// Deploys the Hyperlane CORE contracts on a SKALE chain, where Hyperlane runs nothing:
//   ProxyAdmin, Mailbox (impl + transparent proxy), MerkleTreeHook (default hook), ProtocolFee 0
//   (required hook), TrustedRelayerIsm (placeholder default ISM), ValidatorAnnounce, the two static
//   ISM factories the warp route needs, and (testnets) a TestRecipient.
//
// WHY NOT `hyperlane core deploy`: skaled 5.2 has no Cancun opcodes; the CLI's bytecode is Cancun and
// its first proxy creation burns the whole gas limit (SKALE Base Sepolia, 2026-09-27). We deploy the
// same contracts rebuilt for Shanghai (scripts/hyperlane/artifacts-shanghai, see hl-contracts/).
// Registry chains (base, basesepolia) need no core deploy and this script refuses to run there.
//
// USAGE
//   npx hardhat run scripts/hyperlane/deployCore.ts --network skale-base-sepolia      # dry run
//   DEPLOY=1 npx hardhat run scripts/hyperlane/deployCore.ts --network skale-base-sepolia
//   DEPLOY=1 npx hardhat run scripts/hyperlane/deployCore.ts --network skale          # mainnet (PK only:
//                                                    the sole address whitelisted to deploy on Europa)
//
// Order (mirrors Hyperlane's own deployer): ProxyAdmin -> Mailbox impl -> Mailbox proxy initialised
// with the ProxyAdmin as PLACEHOLDER ism/hooks (initialize() needs contract addresses and the hooks
// need the mailbox address) -> hooks/ISM/announce with the proxy address -> mailbox.setDefaultIsm /
// setDefaultHook / setRequiredHook -> ownership of mailbox + ProxyAdmin -> chain owner.
// Writes registry/chains/<name>/addresses.yaml (what `hyperlane registry agent-config` reads) and a
// deployments/HyperlaneCore_<net>_<ts>.json record, then reads everything back.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { laneOf } from "./config";
import { buildInfo, contract, deploy } from "./lib/artifacts";
import { chainDir, deployFlag, readYaml, retryRead, writeRecord, writeYaml } from "./lib/hl";

const HOOK_MERKLE_TREE = 3, HOOK_PROTOCOL_FEE = 8; // IPostDispatchHook.Types
const ISM_NULL = 6; // IInterchainSecurityModule.Types — TrustedRelayerIsm reports NULL

async function main() {
  const { lane, local } = laneOf(network.name);
  if (!local.skale) throw new Error(`${local.name} is a Hyperlane registry chain; nothing to deploy. deployCore.ts is for SKALE chains only.`);
  const deployIt = deployFlag();
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== local.chainId) throw new Error(`connected chainId ${net.chainId} != config ${local.chainId}`);
  const info = buildInfo();

  console.log(`lane:      ${lane}`);
  console.log(`chain:     ${local.name} (chainId ${local.chainId}, domain ${local.domainId})`);
  console.log(`deployer:  ${signer.address}  balance ${ethers.formatEther(await ethers.provider.getBalance(signer.address))}`);
  console.log(`owner:     ${local.owner} (${local.ownerKind})`);
  console.log(`artifacts: @hyperlane-xyz/core ${info.core}, solc ${info.solc}, evm ${info.evmVersion}`);
  console.log(`mode:      ${deployIt ? "DEPLOY" : "dry run (set DEPLOY=1 to deploy)"}\n`);

  const dir = chainDir(local.name);
  const addressesFile = path.join(dir, "addresses.yaml");
  if (fs.existsSync(addressesFile)) {
    const existing = readYaml<Record<string, string>>(addressesFile);
    console.log(`registry already has core addresses for ${local.name} (mailbox ${existing.mailbox}).`);
    console.log(`Refusing to deploy a second core. Delete ${path.relative(process.cwd(), addressesFile)} on purpose if you really want a new one.`);
    if (deployIt) throw new Error("core already deployed");
  }

  // Deploy permission probe (SKALE whitelists tx.origin; nested CREATEs must work for the factories).
  const probe = await ethers.getContractFactory("CreateProbe");
  const ret = await ethers.provider.call({ from: signer.address, data: (await probe.getDeployTransaction()).data });
  if ((ret.length - 2) / 2 === 0) throw new Error(`deployer ${signer.address} cannot create contracts on ${local.name} (empty creation result). On Europa only the whitelisted PK deployer can.`);
  console.log(`deploy permission: OK (nested CREATE from ${signer.address} succeeds on ${local.name})`);
  // Shanghai-only bytecode sanity: the chain must reject MCOPY (if it accepted it we would not need this build, harmless) and accept PUSH0.
  const push0 = await ethers.provider.call({ from: signer.address, data: "0x5f5f60015ff3" });
  if (push0 === "0x") throw new Error(`${local.name} rejects PUSH0; artifacts-shanghai cannot run here`);

  if (!deployIt) {
    console.log("\nDry run complete. Re-run with DEPLOY=1 to deploy.");
    return;
  }

  const addresses: Record<string, string> = {};
  const record: any = { network: network.name, chain: local.name, chainId: local.chainId, deployer: signer.address, owner: local.owner, artifacts: info, addresses, readBackVerified: false, timestamp: new Date().toISOString() };
  const recordFile = writeRecord("HyperlaneCore", network.name, record);
  const save = () => fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  console.log(`record: ${recordFile} (updated after every contract)\n`);

  const proxyAdmin = await deploy("ProxyAdmin", signer, [], "ProxyAdmin");
  addresses.proxyAdmin = await proxyAdmin.getAddress(); save();

  const mailboxImpl = await deploy("Mailbox", signer, [local.domainId], "Mailbox implementation");
  addresses.mailboxImplementation = await mailboxImpl.getAddress(); save();

  const initData = mailboxImpl.interface.encodeFunctionData("initialize", [signer.address, addresses.proxyAdmin, addresses.proxyAdmin, addresses.proxyAdmin]);
  const mailboxProxy = await deploy("TransparentUpgradeableProxy", signer, [addresses.mailboxImplementation, addresses.proxyAdmin, initData], "Mailbox proxy");
  addresses.mailbox = await mailboxProxy.getAddress(); save();
  const mailbox = contract("Mailbox", addresses.mailbox, signer);

  const merkle = await deploy("MerkleTreeHook", signer, [addresses.mailbox], "MerkleTreeHook");
  addresses.merkleTreeHook = await merkle.getAddress(); save();

  const fee = await deploy("ProtocolFee", signer, [ethers.parseEther("0.1"), 0, local.owner, local.owner], "ProtocolFee (0)");
  addresses.protocolFee = await fee.getAddress(); save();

  const trusted = await deploy("TrustedRelayerIsm", signer, [addresses.mailbox, local.owner], "TrustedRelayerIsm (placeholder default ISM)");
  addresses.interchainSecurityModule = await trusted.getAddress(); save();

  const announce = await deploy("ValidatorAnnounce", signer, [addresses.mailbox], "ValidatorAnnounce");
  addresses.validatorAnnounce = await announce.getAddress(); save();

  const aggF = await deploy("StaticAggregationIsmFactory", signer, [], "StaticAggregationIsmFactory");
  addresses.staticAggregationIsmFactory = await aggF.getAddress(); save();
  const msF = await deploy("StaticMessageIdMultisigIsmFactory", signer, [], "StaticMessageIdMultisigIsmFactory");
  addresses.staticMessageIdMultisigIsmFactory = await msF.getAddress(); save();

  if (local.isTestnet) {
    const tr = await deploy("TestRecipient", signer, [], "TestRecipient (testnet)");
    addresses.testRecipient = await tr.getAddress(); save();
  }
  // No IGP: gas is free on SKALE and we never charge interchain gas. The agents' chain config still
  // wants an `interchainGasPaymaster` address; pointing it at the ProtocolFee hook (a real contract
  // that never emits GasPayment) keeps the relayer's IGP indexer idle. Documented in the README.
  addresses.interchainGasPaymaster = addresses.protocolFee; save();

  console.log("\nwiring mailbox ...");
  for (const [label, fn] of [
    ["setDefaultIsm", () => mailbox.setDefaultIsm(addresses.interchainSecurityModule)],
    ["setDefaultHook", () => mailbox.setDefaultHook(addresses.merkleTreeHook)],
    ["setRequiredHook", () => mailbox.setRequiredHook(addresses.protocolFee)],
  ] as const) {
    const tx = await fn(); await tx.wait(); console.log(`  ${label} ok (${tx.hash})`);
  }
  if (signer.address.toLowerCase() !== local.owner.toLowerCase()) {
    let tx = await mailbox.transferOwnership(local.owner); await tx.wait(); console.log(`  mailbox.transferOwnership(${local.owner}) ok`);
    tx = await proxyAdmin.transferOwnership(local.owner); await tx.wait(); console.log(`  proxyAdmin.transferOwnership(${local.owner}) ok`);
  }

  // Registry addresses.yaml (consumed by `hyperlane registry agent-config` and deployWarp.ts).
  writeYaml(addressesFile, addresses, `# Written by scripts/hyperlane/deployCore.ts on ${new Date().toISOString()} (artifacts-shanghai, core ${info.core}). Do not edit by hand.`);
  console.log(`\nwrote ${path.relative(process.cwd(), addressesFile)}`);

  // Read back.
  console.log("\nread-back:");
  let bad = 0;
  const check = (label: string, ok: boolean, detail: string) => { if (!ok) bad++; console.log(`  ${ok ? "ok " : "BAD"} ${label}: ${detail}`); };
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const ro = contract("Mailbox", addresses.mailbox, ethers.provider);
  const owner = await retryRead("mailbox.owner", () => ro.owner());
  const [dIsm, dHook, rHook, domain] = await Promise.all([ro.defaultIsm(), ro.defaultHook(), ro.requiredHook(), ro.localDomain()]);
  check("localDomain", Number(domain) === local.domainId, String(domain));
  check("owner", eq(owner, local.owner), owner);
  check("defaultHook is our MerkleTreeHook", eq(dHook, addresses.merkleTreeHook) && Number(await contract("MerkleTreeHook", dHook, ethers.provider).hookType()) === HOOK_MERKLE_TREE, dHook);
  check("requiredHook is ProtocolFee(0)", eq(rHook, addresses.protocolFee) && Number(await contract("ProtocolFee", rHook, ethers.provider).hookType()) === HOOK_PROTOCOL_FEE && (await contract("ProtocolFee", rHook, ethers.provider).protocolFee()) === 0n, rHook);
  check("defaultIsm is the TrustedRelayer placeholder", eq(dIsm, addresses.interchainSecurityModule) && Number(await contract("TrustedRelayerIsm", dIsm, ethers.provider).moduleType()) === ISM_NULL, dIsm);
  check("proxyAdmin owner", eq(await contract("ProxyAdmin", addresses.proxyAdmin, ethers.provider).owner(), local.owner), addresses.proxyAdmin);
  check("proxyAdmin administers the mailbox", eq(await contract("ProxyAdmin", addresses.proxyAdmin, ethers.provider).getProxyAdmin(addresses.mailbox), addresses.proxyAdmin), "getProxyAdmin(mailbox)");
  check("validatorAnnounce.mailbox", eq(await contract("ValidatorAnnounce", addresses.validatorAnnounce, ethers.provider).mailbox(), addresses.mailbox), addresses.validatorAnnounce);
  check("merkleTreeHook count 0", Number(await contract("MerkleTreeHook", addresses.merkleTreeHook, ethers.provider).count()) === 0, "fresh tree");
  record.readBackVerified = bad === 0; save();
  console.log(bad === 0 ? "\nread-back verified." : `\nREAD-BACK FOUND ${bad} PROBLEM(S) — do not continue to deployWarp.ts.`);
  console.log(`\nNEXT: DEPLOY=1 npx hardhat run scripts/hyperlane/deployWarp.ts --network ${network.name}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
