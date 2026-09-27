// Deploys the FULA warp route: one HypERC20Collateral router per chain (lock/release escrow), each
// behind its own ProxyAdmin, with the full security stack, enrolled with each other — on BOTH chains
// of a lane in one run, from the Shanghai-built artifacts (scripts/hyperlane/artifacts-shanghai).
//
// USAGE (the --network picks the LANE; both chains of the lane are deployed)
//   npx hardhat run scripts/hyperlane/deployWarp.ts --network skale-base-sepolia            # dry run
//   DEPLOY=1 npx hardhat run scripts/hyperlane/deployWarp.ts --network skale-base-sepolia   # testnet
//   DEPLOY=1 HL_VALIDATOR=0x.. npx hardhat run scripts/hyperlane/deployWarp.ts --network skale   # mainnet
//
//   STAGE=1|2         limits (default 1; mainnet only — testnet uses TESTNET_STAGE)
//   MOCK_TOKENS=basesepolia=0x..,skalebasesepolia=0x..   testnet only: stand-in ERC20s, route id MCK/<lane>
//   ROUTE_SUFFIX=x    append to the route id (a second rehearsal route alongside the first)
//   HL_<CHAIN>_KEY    per-chain signing key override (e.g. HL_BASE_KEY for a Base deployer that is
//                     not PK). Default: PK_TEST on testnets, PK on mainnets (hardhat vars).
//
// SECURITY STACK (per router; verified on chain after deploy)
//   ISM  = StaticAggregationIsm, 3 of 3:
//            StaticMessageIdMultisigIsm — Base router: OUR validator (1 of 1); SKALE router: Hyperlane's
//                                          public Base set (3 of 5). Attests the ORIGIN chain's merkle root.
//            RateLimitedIsm             — daily inbound cap on THIS router (recipient = this router)
//            PausableIsm                — kill switch for the owner
//   hook = the chain's merkleTreeHook by ADDRESS (Base: the registry hook the public validators sign;
//          SKALE: ours). NOT the mailbox default (its IGP has no SKALE oracle and would revert) and NOT a
//          custom rate-limit hook (it would replace the merkle hook and drop validator coverage).
//   owner/proxyAdmin owner = chain owner (Base: 2-of-2 Safe; SKALE: admin EOA, ProxyAdmin burned later)
//
// ORDER per chain: ProxyAdmin -> router impl -> router proxy (initialize: hook, ism=0, owner=deployer)
//   -> PausableIsm(owner) -> RateLimitedIsm(mailbox, cap, 86400, router) -> multisig via factory
//   -> aggregation via factory -> router.setInterchainSecurityModule. Then, both chains deployed:
//   enrollRemoteRouter each way -> transferOwnership(router, proxyAdmin) -> chain owner.
//   Nothing is enrolled while a router still rides the mailbox default ISM.
import { ethers as hh, network } from "hardhat";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { CHAINS, LANES, RATE_LIMIT_DURATION, STAGES, TESTNET_STAGE, laneOf, validatorFor, HlChain } from "./config";
import { buildInfo, contract, deploy } from "./lib/artifacts";
import { coreAddresses, deployFlag, fmtFula, retryRead, walletFor, warpCoreConfigPath, warpDeployConfigPath, writeRecord, writeYaml } from "./lib/hl";

const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"];
const MT_AGGREGATION = 2, MT_MESSAGE_ID_MULTISIG = 5, MT_NULL = 6;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sortAddrs = (xs: string[]) => [...new Set(xs.map((x) => ethers.getAddress(x)))].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

function parseMockTokens(): Record<string, string> {
  const raw = process.env.MOCK_TOKENS?.trim();
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k || !v) throw new Error(`bad MOCK_TOKENS entry "${part}"`);
    out[k] = ethers.getAddress(v);
  }
  return out;
}

interface Side {
  chain: HlChain;
  core: ReturnType<typeof coreAddresses>;
  wallet: ethers.Wallet;
  token: string;
  /** validators that attest messages ARRIVING here (i.e. the remote chain's origin validators) */
  originValidators: string[];
  originThreshold: number;
  addresses: Record<string, string>;
}

async function main() {
  const { lane } = laneOf(network.name);
  const laneCfg = LANES[lane];
  const baseChain = CHAINS[laneCfg.base], skaleChain = CHAINS[laneCfg.skale];
  const deployIt = deployFlag();
  const mock = parseMockTokens();
  const isTestnet = baseChain.isTestnet;
  if (Object.keys(mock).length && !isTestnet) throw new Error("MOCK_TOKENS is testnet-only");
  const stageNo = Number(process.env.STAGE?.trim() || 1);
  const stage = isTestnet ? TESTNET_STAGE : STAGES[stageNo];
  if (!stage) throw new Error(`unknown STAGE ${stageNo}`);
  const suffix = process.env.ROUTE_SUFFIX?.trim();
  const routeId = (Object.keys(mock).length ? laneCfg.routeId.replace(/^FULA\//, "MCK/") : laneCfg.routeId) + (suffix ? `-${suffix}` : "");
  const validator = validatorFor(lane);
  const info = buildInfo();
  const pub = baseChain.publicValidators!;

  const sides: Side[] = [
    { chain: baseChain, core: coreAddresses(baseChain), wallet: walletFor(baseChain), token: mock[baseChain.name] ?? baseChain.token, originValidators: [validator], originThreshold: 1, addresses: {} },
    { chain: skaleChain, core: coreAddresses(skaleChain), wallet: walletFor(skaleChain), token: mock[skaleChain.name] ?? skaleChain.token, originValidators: pub.validators.map((v) => v.address), originThreshold: pub.threshold, addresses: {} },
  ];
  for (const s of sides) if (s.token === ethers.ZeroAddress) throw new Error(`${s.chain.name}: token address is unset (SKALE_TESTNET_TOKEN or MOCK_TOKENS)`);

  console.log(`lane:      ${lane}   route id: ${routeId}`);
  console.log(`artifacts: @hyperlane-xyz/core ${info.core}, solc ${info.solc}, evm ${info.evmVersion}`);
  console.log(`validator: ${validator} (ours; attests ${skaleChain.name} -> ${baseChain.name})`);
  console.log(`public:    ${pub.threshold} of ${pub.validators.map((v) => v.alias).join(", ")} (attest ${baseChain.name} -> ${skaleChain.name})`);
  console.log(`caps:      inbound ${fmtFula(stage.inboundCapPerDay)} / ${RATE_LIMIT_DURATION}s per router (stage ${isTestnet ? "testnet" : stageNo})`);
  console.log(`mode:      ${deployIt ? "DEPLOY" : "dry run (set DEPLOY=1 to deploy)"}\n`);

  // Pre-flight
  for (const s of sides) {
    const p = s.wallet.provider!;
    const t = new ethers.Contract(s.token, ERC20_ABI, p);
    const [sym, dec, code, ownerCode, bal, net] = await Promise.all([t.symbol(), t.decimals(), p.getCode(s.token), p.getCode(s.chain.owner), p.getBalance(s.wallet.address), p.getNetwork()]);
    if (Number(net.chainId) !== s.chain.chainId) throw new Error(`${s.chain.name}: rpc chainId ${net.chainId} != ${s.chain.chainId}`);
    if (code === "0x") throw new Error(`${s.chain.name}: no code at token ${s.token}`);
    if (Number(dec) !== 18) throw new Error(`${s.chain.name}: token decimals ${dec} != 18`);
    if (s.chain.ownerKind === "safe" && ownerCode === "0x") throw new Error(`${s.chain.name}: owner ${s.chain.owner} is configured as a Safe but has no code`);
    for (const k of ["mailbox", "merkleTreeHook", "staticAggregationIsmFactory", "staticMessageIdMultisigIsmFactory"] as const) {
      if ((await p.getCode((s.core as any)[k])) === "0x") throw new Error(`${s.chain.name}: no code at ${k} ${(s.core as any)[k]}`);
    }
    console.log(`${s.chain.name.padEnd(18)} token ${s.token} (${sym})  owner ${s.chain.owner} (${ownerCode === "0x" ? "EOA" : "contract"})  mailbox ${s.core.mailbox}`);
    console.log(`${"".padEnd(18)} signer ${s.wallet.address} balance ${ethers.formatEther(bal)}`);
  }

  // Render the deploy config the way the Hyperlane CLI would read it (documentation + `warp check`).
  const deployConfig: Record<string, unknown> = {};
  for (const s of sides) {
    deployConfig[s.chain.name] = {
      type: "collateral", token: s.token, owner: s.chain.owner, mailbox: s.core.mailbox, proxyAdmin: { owner: s.chain.owner },
      hook: { type: "merkleTreeHook", address: s.core.merkleTreeHook },
      interchainSecurityModule: {
        type: "staticAggregationIsm", threshold: 3,
        modules: [
          { type: "messageIdMultisigIsm", validators: sortAddrs(s.originValidators).map((v) => v.toLowerCase()), threshold: s.originThreshold },
          { type: "rateLimitedIsm", maxCapacity: stage.inboundCapPerDay.toString(), duration: RATE_LIMIT_DURATION, owner: s.chain.owner },
          { type: "pausableIsm", owner: s.chain.owner, paused: false },
        ],
      },
    };
  }
  const deployFile = warpDeployConfigPath(routeId);
  writeYaml(deployFile, deployConfig, `# Rendered by scripts/hyperlane/deployWarp.ts (${new Date().toISOString()}) — documentation of what was deployed; the deploy itself is done by the script, not the CLI.`);
  console.log(`\nrendered ${path.relative(process.cwd(), deployFile)}`);

  const coreFile = warpCoreConfigPath(routeId);
  if (fs.existsSync(coreFile)) {
    console.log(`WARNING: ${path.relative(process.cwd(), coreFile)} exists (route already deployed). Refusing to deploy again; delete it on purpose for a redeploy.`);
    if (deployIt) throw new Error("route already deployed");
  }
  if (!deployIt) { console.log("\nDry run complete. Re-run with DEPLOY=1 to deploy."); return; }

  const record: any = { network: network.name, lane, routeId, validator, stage: isTestnet ? "testnet" : stageNo, caps: { inboundCapPerDay: stage.inboundCapPerDay.toString(), duration: RATE_LIMIT_DURATION }, artifacts: info, chains: {} as Record<string, any>, deployConfig, readBackVerified: false, timestamp: new Date().toISOString() };
  const recordFile = writeRecord("HyperlaneWarp", network.name, record);
  const save = () => fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  console.log(`record: ${recordFile} (updated after every contract)`);

  // ---- per chain
  for (const s of sides) {
    const w = s.wallet, a = s.addresses;
    record.chains[s.chain.name] = { signer: w.address, token: s.token, addresses: a };
    console.log(`\n== ${s.chain.name}`);
    const proxyAdmin = await deploy("ProxyAdmin", w, [], "ProxyAdmin"); a.proxyAdmin = await proxyAdmin.getAddress(); save();
    const impl = await deploy("HypERC20Collateral", w, [s.token, 1, 1, s.core.mailbox], "HypERC20Collateral implementation"); a.routerImplementation = await impl.getAddress(); save();
    const init = impl.interface.encodeFunctionData("initialize", [s.core.merkleTreeHook, ethers.ZeroAddress, w.address]);
    const meta: { txHash?: string; block?: number } = {};
    const proxy = await deploy("TransparentUpgradeableProxy", w, [a.routerImplementation, a.proxyAdmin, init], "router proxy", meta); a.router = await proxy.getAddress();
    record.chains[s.chain.name].routerDeployTx = meta.txHash; record.chains[s.chain.name].deployBlock = meta.block; save();
    const router = contract("HypERC20Collateral", a.router, w);

    const pausable = await deploy("PausableIsm", w, [s.chain.owner], "PausableIsm"); a.pausableIsm = await pausable.getAddress(); save();
    const rl = await deploy("RateLimitedIsm", w, [s.core.mailbox, stage.inboundCapPerDay, RATE_LIMIT_DURATION, a.router], "RateLimitedIsm"); a.rateLimitedIsm = await rl.getAddress(); save();
    if (!eq(w.address, s.chain.owner)) { const tx = await rl.transferOwnership(s.chain.owner); await tx.wait(); console.log(`  rateLimitedIsm.transferOwnership(${s.chain.owner}) ok`); }

    const msF = contract("StaticMessageIdMultisigIsmFactory", s.core.staticMessageIdMultisigIsmFactory, w);
    const vals = sortAddrs(s.originValidators);
    a.multisigIsm = await msF["getAddress(address[],uint8)"](vals, s.originThreshold);
    if ((await w.provider!.getCode(a.multisigIsm)) === "0x") { const tx = await msF["deploy(address[],uint8)"](vals, s.originThreshold); await tx.wait(); console.log(`  multisig ISM deployed via factory ${a.multisigIsm} (tx ${tx.hash})`); }
    else console.log(`  multisig ISM already exists at ${a.multisigIsm} (same set + threshold), reused`);
    save();

    const aggF = contract("StaticAggregationIsmFactory", s.core.staticAggregationIsmFactory, w);
    const mods = sortAddrs([a.multisigIsm, a.rateLimitedIsm, a.pausableIsm]);
    a.aggregationIsm = await aggF["getAddress(address[],uint8)"](mods, 3);
    if ((await w.provider!.getCode(a.aggregationIsm)) === "0x") { const tx = await aggF["deploy(address[],uint8)"](mods, 3); await tx.wait(); console.log(`  aggregation ISM deployed via factory ${a.aggregationIsm} (tx ${tx.hash})`); }
    else console.log(`  aggregation ISM already exists at ${a.aggregationIsm}, reused`);
    save();

    const tx = await router.setInterchainSecurityModule(a.aggregationIsm); await tx.wait(); console.log(`  router.setInterchainSecurityModule ok (${tx.hash})`);
  }

  // ---- enroll + hand over
  console.log("\nenrolling routers and transferring ownership ...");
  for (const s of sides) {
    const other = sides.find((x) => x !== s)!;
    const router = contract("HypERC20Collateral", s.addresses.router, s.wallet);
    let tx = await router.enrollRemoteRouter(other.chain.domainId, ethers.zeroPadValue(other.addresses.router, 32)); await tx.wait();
    console.log(`  ${s.chain.name}: enrollRemoteRouter(${other.chain.domainId}, ${other.addresses.router}) ok`);
    if (!eq(s.wallet.address, s.chain.owner)) {
      tx = await router.transferOwnership(s.chain.owner); await tx.wait();
      tx = await contract("ProxyAdmin", s.addresses.proxyAdmin, s.wallet).transferOwnership(s.chain.owner); await tx.wait();
      console.log(`  ${s.chain.name}: router + proxyAdmin ownership -> ${s.chain.owner}`);
    }
  }

  // Warp core config in registry format (what `hyperlane warp read/check`, the Warp UI and our UI use).
  const symbol = await new ethers.Contract(sides[0].token, ERC20_ABI, sides[0].wallet.provider).symbol();
  const coreCfg = {
    tokens: sides.map((s) => ({
      chainName: s.chain.name, standard: "EvmHypCollateral", decimals: 18, symbol, name: symbol === "FULA" ? "Functionland Fula" : symbol,
      addressOrDenom: s.addresses.router, collateralAddressOrDenom: s.token,
      connections: sides.filter((x) => x !== s).map((x) => ({ token: `ethereum|${x.chain.name}|${x.addresses.router}` })),
    })),
  };
  writeYaml(coreFile, coreCfg, `# Written by scripts/hyperlane/deployWarp.ts on ${new Date().toISOString()}. Registry-format warp core config.`);
  console.log(`\nwrote ${path.relative(process.cwd(), coreFile)}`);

  // ---- read back
  let bad = 0;
  const check = (label: string, ok: boolean, detail: string) => { if (!ok) bad++; console.log(`  ${ok ? "ok " : "BAD"} ${label}: ${detail}`); };
  for (const s of sides) {
    const other = sides.find((x) => x !== s)!;
    const p = s.wallet.provider!, a = s.addresses;
    console.log(`\nread-back ${s.chain.name} router ${a.router}:`);
    const r = contract("HypERC20Collateral", a.router, p);
    const owner = await retryRead(`${s.chain.name} router.owner`, () => r.owner());
    const [mailbox, hook, ismAddr, remoteRouter, token, domains, localDomain] = await Promise.all([r.mailbox(), r.hook(), r.interchainSecurityModule(), r.routers(other.chain.domainId), r.wrappedToken(), r.domains(), r.localDomain()]);
    check("owner", eq(owner, s.chain.owner), owner);
    check("mailbox", eq(mailbox, s.core.mailbox), mailbox);
    check("localDomain", Number(localDomain) === s.chain.domainId, String(localDomain));
    check("token", eq(token, s.token), token);
    check("hook = merkleTreeHook", eq(hook, s.core.merkleTreeHook), hook);
    check(`remote router (${other.chain.name})`, eq(ethers.dataSlice(remoteRouter, 12), other.addresses.router), ethers.dataSlice(remoteRouter, 12));
    check("enrolled domains", domains.length === 1 && Number(domains[0]) === other.chain.domainId, domains.map(String).join(","));
    const pa = contract("ProxyAdmin", a.proxyAdmin, p);
    check("proxyAdmin owner", eq(await pa.owner(), s.chain.owner), `${a.proxyAdmin} owned by ${await pa.owner()}`);
    check("proxyAdmin administers router", eq(await pa.getProxyAdmin(a.router), a.proxyAdmin), "getProxyAdmin(router)");
    const agg = contract("StaticAggregationIsm", ismAddr, p);
    check("ISM is our aggregation", eq(ismAddr, a.aggregationIsm) && Number(await agg.moduleType()) === MT_AGGREGATION, ismAddr);
    const [modules, threshold] = await agg.modulesAndThreshold("0x");
    check("aggregation 3 of 3", Number(threshold) === 3 && modules.length === 3, `${threshold} of ${modules.length}`);
    const ms = contract("StaticMessageIdMultisigIsm", a.multisigIsm, p);
    const [vals, th] = await ms.validatorsAndThreshold("0x");
    check(`multisig (${other.chain.name} origin)`, Number(await ms.moduleType()) === MT_MESSAGE_ID_MULTISIG && sortAddrs(vals).join() === sortAddrs(s.originValidators).join() && Number(th) === s.originThreshold, `${th} of [${sortAddrs(vals).join(", ")}]`);
    const rl = contract("RateLimitedIsm", a.rateLimitedIsm, p);
    const [cap, dur, rec, rlOwner] = await Promise.all([rl.maxCapacity(), rl.DURATION(), rl.recipient(), rl.owner()]);
    // RateLimited stores refillRate = cap / DURATION and reports maxCapacity = refillRate * DURATION,
    // so the on-chain cap is the configured cap rounded DOWN to a multiple of DURATION wei.
    const capOk = cap <= stage.inboundCapPerDay && cap > stage.inboundCapPerDay - BigInt(RATE_LIMIT_DURATION);
    check("rateLimitedIsm", Number(await rl.moduleType()) === MT_NULL && capOk && Number(dur) === RATE_LIMIT_DURATION && eq(rec, a.router) && eq(rlOwner, s.chain.owner), `cap ${fmtFula(cap)} / ${dur}s recipient ${rec} owner ${rlOwner}`);
    const ps = contract("PausableIsm", a.pausableIsm, p);
    check("pausableIsm", (await ps.paused()) === false && eq(await ps.owner(), s.chain.owner), `paused false owner ${await ps.owner()}`);
    check("aggregation members", sortAddrs(modules).join() === sortAddrs([a.multisigIsm, a.rateLimitedIsm, a.pausableIsm]).join(), "multisig + rateLimited + pausable");
  }
  record.readBackVerified = bad === 0; save();
  console.log(bad === 0 ? "\nread-back verified on both chains." : `\nREAD-BACK FOUND ${bad} PROBLEM(S) — do not seed liquidity.`);

  const [b, k] = sides;
  console.log(`\nNEXT`);
  console.log(`  1. server: install.sh --base-router ${b.addresses.router} --skale-router ${k.addresses.router}${isTestnet ? " --testnet" : ""}`);
  console.log(`  2. canary: AMOUNT=1 npx hardhat run scripts/hyperlane/canary.ts --network ${b.chain.hardhatNetwork}  (and --network ${k.chain.hardhatNetwork})`);
  console.log(`  3. seed:   whitelist ${b.addresses.router} on ${b.chain.name} and ${k.addresses.router} on ${k.chain.name}, then transferFromContract.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
