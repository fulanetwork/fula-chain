// Deploys the immutable FulaRefillTreasury for the current network.
//
// The treasury is DELIBERATELY NOT UPGRADEABLE and its pool list is fixed at construction.
// Funds can only ever go to a registered pool (permissionless, threshold-gated) or back to the
// token contract (owner only).
//
// USAGE
//   npx hardhat run scripts/RefillTreasury/deployRefillTreasury.ts --network base          # dry run
//   DEPLOY=1 npx hardhat run scripts/RefillTreasury/deployRefillTreasury.ts --network base # deploy
//   TREASURY=0x... TX=0x... npx hardhat run scripts/RefillTreasury/deployRefillTreasury.ts --network base
//                                                  # record + verify an ALREADY deployed treasury (no tx)
//
// The dry run re-verifies every pool on-chain (has code, token()/storageToken() == FULA,
// current balance vs threshold) and prints what the first refillAll() would do.
//
// AFTER DEPLOY (see docs/refill-treasury/02-design-and-runbook.md):
//   1. Whitelist the treasury on the FULA token: createProposal(type 5 AddWhitelist, target=treasury)
//      by one ADMIN_ROLE holder, approveProposal by a second one, then wait the 1-day whitelist lock.
//   2. transferFromContract(treasury, amount) from the token (ADMIN_ROLE, within transactionLimit).
//   3. Anyone: npx hardhat run scripts/RefillTreasury/refillTreasury.ts --network <net>
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { configFor } from "./config";

declare const hre: any;

const fmt = (x: bigint) => Number(ethers.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 2 });

async function main() {
  const cfg = configFor(network.name);
  const existing = process.env.TREASURY?.trim(); // record-only mode for an already-deployed treasury
  const deploy = process.env.DEPLOY === "1" || !!existing;
  const [deployer] = await ethers.getSigners();

  console.log(`network:  ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`token:    ${cfg.token}`);
  console.log(`admin:    ${cfg.admin}`);
  console.log(`cooldown: ${cfg.cooldownSeconds}s`);
  console.log(`mode:     ${existing ? "RECORD existing deployment " + existing : deploy ? "DEPLOY" : "dry run (set DEPLOY=1 to deploy)"}\n`);

  const erc20 = new ethers.Contract(cfg.token, ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"], ethers.provider);
  const symbol = await erc20.symbol();
  if (symbol !== "FULA") throw new Error(`token at ${cfg.token} has symbol ${symbol}, expected FULA`);

  // Pre-flight: the constructor performs the same checks, but a dry run should show them.
  let problems = 0;
  console.log("pool".padEnd(48) + "address".padEnd(44) + "balance".padStart(16) + "threshold".padStart(14) + "  first refill");
  for (const p of cfg.pools) {
    const code = await ethers.provider.getCode(p.account);
    const bal: bigint = await erc20.balanceOf(p.account);
    let tokenOk = false;
    for (const sig of ["function token() view returns (address)", "function storageToken() view returns (address)"]) {
      try {
        const t: string = await new ethers.Contract(p.account, [sig], ethers.provider)[sig.split(" ")[1].split("(")[0]]();
        if (t.toLowerCase() === cfg.token.toLowerCase()) tokenOk = true;
      } catch { /* getter absent */ }
    }
    const target = (p.threshold * 11000n) / 10000n;
    const first = bal < p.threshold ? (target - bal > p.threshold ? p.threshold : target - bal) : 0n;
    const flag = code === "0x" ? "  NO CODE" : !tokenOk ? "  TOKEN MISMATCH" : "";
    if (flag) problems++;
    console.log(p.label.padEnd(48) + p.account.padEnd(44) + fmt(bal).padStart(16) + fmt(p.threshold).padStart(14) + "  " + (first > 0n ? fmt(first) : "-") + flag);
  }
  if (problems) throw new Error(`${problems} pool(s) failed pre-flight; aborting`);

  const adminCode = await ethers.provider.getCode(cfg.admin);
  console.log(`\nadmin ${cfg.admin} ${adminCode === "0x" ? "is an EOA (guardian only: pause / disable / lower thresholds / returnToToken)" : "has code"}`);

  const args: [string, string, number, { account: string; threshold: bigint; maxThreshold: bigint }[]] = [
    cfg.token,
    cfg.admin,
    cfg.cooldownSeconds,
    cfg.pools.map((p) => ({ account: p.account, threshold: p.threshold, maxThreshold: p.maxThreshold })),
  ];
  const Factory = await ethers.getContractFactory("FulaRefillTreasury");
  const gas = await ethers.provider.estimateGas({ data: (await Factory.getDeployTransaction(...args)).data, from: deployer.address });
  console.log(`estimated deploy gas: ${gas}`);
  if (!deploy) {
    console.log("\nDry run complete. Re-run with DEPLOY=1 to deploy.");
    return;
  }

  let address: string;
  let txHash: string | undefined;
  let tx: any = undefined;
  if (existing) {
    // Record-only mode: the deployment already happened (e.g. the script crashed after the tx).
    address = existing;
    txHash = process.env.TX?.trim();
    console.log(`\nrecording existing deployment at ${address}`);
  } else {
    const deployed = await Factory.deploy(...args);
    await deployed.waitForDeployment();
    address = await deployed.getAddress();
    tx = deployed.deploymentTransaction();
    txHash = tx?.hash;
    console.log(`\nFulaRefillTreasury deployed to: ${address}`);
    console.log(`deployment tx: ${txHash}`);
  }

  // Write the record and the verify-args file FIRST, from the config we deployed with. Public RPCs
  // can serve stale state for several seconds after a transaction, and a crash on the read-back
  // must never lose the record (this happened once on Base).
  const constructorArgs = [cfg.token, cfg.admin, cfg.cooldownSeconds, cfg.pools.map((p) => [p.account, p.threshold.toString(), p.maxThreshold.toString()])];
  const record: any = {
    network: network.name,
    address,
    txHash,
    deployer: deployer.address,
    token: cfg.token,
    admin: cfg.admin,
    cooldownSeconds: cfg.cooldownSeconds,
    pools: cfg.pools.map((p, i) => ({ id: i, label: p.label, account: p.account, threshold: p.threshold.toString(), maxThreshold: p.maxThreshold.toString() })),
    constructorArgs,
    readBackVerified: false,
    timestamp: new Date().toISOString(),
  };
  const outDir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const outFile = path.join(outDir, `FulaRefillTreasury_${network.name}_${stamp}.json`);
  const argsFile = path.join(outDir, `FulaRefillTreasury_${network.name}_${stamp}.args.js`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  fs.writeFileSync(argsFile, `module.exports = ${JSON.stringify(constructorArgs, null, 2)};\n`);
  console.log(`recorded: ${outFile}\nverify args: ${argsFile}`);

  // Read back with retries and check every pool against the config.
  const treasury = await ethers.getContractAt("FulaRefillTreasury", address);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let count = -1;
  for (let attempt = 1; attempt <= 12 && count < 0; attempt++) {
    try { count = Number(await treasury.poolCount()); }
    catch (e: any) { console.log(`  read-back attempt ${attempt}: ${e.shortMessage ?? e.message} (RPC lag; retrying in 5s)`); await sleep(5000); }
  }
  if (count < 0) throw new Error("read-back failed after 60s; the deployment record above is still valid, re-run with TREASURY=<address> to verify later");
  let mismatches = 0;
  if (count !== cfg.pools.length) { mismatches++; console.log(`  MISMATCH: poolCount ${count} != config ${cfg.pools.length}`); }
  for (let i = 0; i < Math.min(count, cfg.pools.length); i++) {
    const p = await treasury.getPool(i);
    const ok = p.account.toLowerCase() === cfg.pools[i].account.toLowerCase() && p.threshold === cfg.pools[i].threshold && p.maxThreshold === cfg.pools[i].maxThreshold;
    if (!ok) mismatches++;
    console.log(`  pool ${i}: ${cfg.pools[i].label.padEnd(46)} ${p.account} threshold ${fmt(p.threshold)} cap ${fmt(p.maxThreshold)} ${ok ? "" : "MISMATCH"}`);
  }
  const owner = await treasury.owner(), cd = Number(await treasury.cooldown());
  if (owner.toLowerCase() !== cfg.admin.toLowerCase()) { mismatches++; console.log(`  MISMATCH: owner ${owner}`); }
  if (cd !== cfg.cooldownSeconds) { mismatches++; console.log(`  MISMATCH: cooldown ${cd}`); }
  record.readBackVerified = mismatches === 0;
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(mismatches === 0 ? `read-back verified: owner ${owner}, cooldown ${cd}s, ${count} pools match config` : `READ-BACK FOUND ${mismatches} MISMATCH(ES); do not fund`);

  console.log("\nNEXT STEPS");
  console.log(`  1. Whitelist ${address} on the token (AddWhitelist proposal, 2 admin approvals, 1-day lock).`);
  console.log(`  2. token.transferFromContract(${address}, amount)`);
  console.log(`  3. TREASURY=${address} npx hardhat run scripts/RefillTreasury/refillTreasury.ts --network ${network.name}`);
  console.log(`  verify: npx hardhat verify --network ${network.name} --contract contracts/core/FulaRefillTreasury.sol:FulaRefillTreasury --constructor-args ${argsFile} ${address}`);

  if (process.env.VERIFY === "1") {
    console.log("\nwaiting 6 confirmations before verify...");
    if (tx) await tx.wait(6);
    await hre.run("verify:verify", { address, contract: "contracts/core/FulaRefillTreasury.sol:FulaRefillTreasury", constructorArguments: args });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
