// End-to-end rehearsal of FulaRefillTreasury on Sepolia with the REAL testnet FULA token.
//
//   npx hardhat run scripts/RefillTreasury/rehearseSepolia.ts --network sepolia
//
// Uses PK_TEST (deployer, token ADMIN_ROLE, whitelisted) as "anyone" for refills and ADMIN_PK_TEST
// as the treasury guardian. Pools are minimal stand-in contracts (MockRefillPool / ...StorageToken)
// because the constructor refuses EOAs: only the treasury's own transfer path is under test.
// Cooldown is the contract minimum (1h; mainnet config 24h). The live 'wait for cooldown' step is skipped
// unless WAIT_COOLDOWN=1 is set (it then really waits an hour); the cooldown branch itself is still asserted.
//
// Every step asserts on-chain state and the script exits non-zero on the first mismatch.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const F = (n: number | string) => ethers.parseEther(String(n));
const fmt = (x: bigint) => Number(ethers.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const SEPOLIA_TOKEN = "0x32d6929c9F552068D54481FeAe75674fD29F337e";
const COOLDOWN = 3600;

const results: { step: string; ok: boolean; detail: string }[] = [];
// State checks retry: public RPCs are load-balanced and a node can serve stale state for a few
// seconds right after a transaction. A predicate is re-evaluated up to 8 times, 5s apart.
async function check(step: string, ok: boolean | (() => Promise<boolean>), detail: string) {
  let pass = typeof ok === "boolean" ? ok : false;
  if (typeof ok !== "boolean") {
    for (let i = 0; i < 8; i++) { pass = await ok(); if (pass) break; await sleep(5000); }
  }
  results.push({ step, ok: pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${step}  ${detail}`);
  if (!pass) throw new Error(`step failed: ${step}`);
}
async function expectRevert(step: string, p: Promise<any>, selectorName: string, iface: any) {
  try {
    const tx = await p;
    await tx.wait();
    await check(step, false, "did not revert");
  } catch (e: any) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? "";
    let name = "";
    try { name = iface.parseError(typeof data === "string" ? data : data?.data)?.name ?? ""; } catch { /* no data */ }
    const msg = String(e?.shortMessage ?? e?.message ?? "");
    const ok = name === selectorName || msg.includes(selectorName);
    await check(step, ok, ok ? `reverted ${selectorName}` : `reverted with ${name || msg.slice(0, 80)} (expected ${selectorName})`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const [deployer, guardian] = await ethers.getSigners();
  if (!guardian) throw new Error("ADMIN_PK_TEST not set");
  console.log(`deployer/anyone: ${deployer.address}  guardian: ${guardian.address}`);
  const startEth = await ethers.provider.getBalance(deployer.address);

  const token = await ethers.getContractAt("StorageToken", SEPOLIA_TOKEN);
  const tokenAddr = await token.getAddress();

  // 1. stand-in pools
  const PoolA = await ethers.getContractFactory("MockRefillPool");
  const PoolS = await ethers.getContractFactory("MockRefillPoolStorageToken");
  const poolA = await (await PoolA.deploy(tokenAddr)).waitForDeployment();
  const poolB = await (await PoolA.deploy(tokenAddr)).waitForDeployment();
  const poolC = await (await PoolS.deploy(tokenAddr)).waitForDeployment();
  const poolD = await (await PoolA.deploy(tokenAddr)).waitForDeployment(); // pre-funded AT threshold: skipped in step 5, used for the truncation steps
  const [aAddr, bAddr, cAddr, dAddr] = await Promise.all([poolA.getAddress(), poolB.getAddress(), poolC.getAddress(), poolD.getAddress()]);
  console.log(`pools: A ${aAddr}  B ${bAddr}  C(storageToken) ${cAddr}  D ${dAddr}`);

  // 2. treasury
  const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
  const pools = [
    { account: aAddr, threshold: F(100_000), maxThreshold: F(100_000) },
    { account: bAddr, threshold: F(50_000), maxThreshold: F(100_000) },
    { account: cAddr, threshold: F(20_000), maxThreshold: F(100_000) },
    { account: dAddr, threshold: F(20_000), maxThreshold: F(100_000) },
  ];
  const treasury = await (await Treasury.deploy(tokenAddr, guardian.address, COOLDOWN, pools)).waitForDeployment();
  const tAddr = await treasury.getAddress();
  const deployTx = treasury.deploymentTransaction();
  const deployRcpt = await deployTx!.wait();
  console.log(`treasury: ${tAddr}  tx ${deployTx!.hash}  gasUsed ${deployRcpt!.gasUsed}`);
  await check("deploy: 4 pools registered, owner = guardian", async () => Number(await treasury.poolCount()) === 4 && (await treasury.owner()) === guardian.address, `poolCount=${await treasury.poolCount()}`);
  // Public RPCs return a bare "execution reverted" for a failed deploy; eth_call the deploy data to
  // get the revert bytes and decode the custom error name.
  const deployRevertsWith = async (args: any[], expected: string) => {
    const tx = await Treasury.getDeployTransaction(...(args as [any, any, any, any]));
    try { await ethers.provider.call({ from: deployer.address, data: tx.data }); return "did not revert"; }
    catch (e: any) { const data = e?.data ?? e?.info?.error?.data ?? ""; try { return Treasury.interface.parseError(data)?.name ?? String(e.shortMessage); } catch { return String(e.shortMessage ?? e.message).slice(0, 60); } }
  };
  const eoaResult = await deployRevertsWith([tokenAddr, guardian.address, COOLDOWN, [{ ...pools[0], account: deployer.address }]], "NotAContract");
  await check("deploy: constructor rejects an EOA pool", eoaResult === "NotAContract", eoaResult);
  const zeroCd = await deployRevertsWith([tokenAddr, guardian.address, 0, pools], "CooldownOutOfRange");
  await check("deploy: constructor rejects cooldown 0", zeroCd === "CooldownOutOfRange", zeroCd);

  // 3. fund: token -> deployer (whitelisted admin path) -> treasury (plain transfer) and pre-fund B to 40K
  await (await token.connect(deployer).transferFromContract(deployer.address, F(1_060_000))).wait();
  await (await token.connect(deployer).transfer(tAddr, F(1_000_000))).wait();
  await (await token.connect(deployer).transfer(bAddr, F(40_000))).wait();
  await (await token.connect(deployer).transfer(dAddr, F(20_000))).wait();
  await check("fund: treasury holds 1,000,000, B holds 40,000, D holds 20,000 (= its threshold)", async () => (await treasury.treasuryBalance()) === F(1_000_000) && (await token.balanceOf(bAddr)) === F(40_000) && (await token.balanceOf(dAddr)) === F(20_000), "");

  // 4. previews
  await check("preview: A 100K, B 15K, C 20K, D 0 (at threshold)", async () => (await treasury.previewRefill(0)) === F(100_000) && (await treasury.previewRefill(1)) === F(15_000) && (await treasury.previewRefill(2)) === F(20_000) && (await treasury.previewRefill(3)) === 0n, "");

  // 5. refillAll by "anyone" (deployer is not the owner)
  const r1 = await (await treasury.connect(deployer).refillAll()).wait();
  const refilled = r1!.logs.map((l: any) => { try { return treasury.interface.parseLog(l); } catch { return null; } }).filter((x: any) => x?.name === "Refilled");
  await check("refillAll: 3 Refilled events (D skipped), A=100K B=55K C=20K, treasury=865K",
    async () => refilled.length === 3 && (await token.balanceOf(aAddr)) === F(100_000) && (await token.balanceOf(bAddr)) === F(55_000) && (await token.balanceOf(cAddr)) === F(20_000) && (await treasury.treasuryBalance()) === F(865_000),
    `gasUsed ${r1!.gasUsed}`);

  // 6. above threshold -> nothing
  await expectRevert("refill(0) at threshold reverts NotBelowThreshold", treasury.connect(deployer).refill(0), "NotBelowThreshold", treasury.interface);
  await check("refillAll with nothing eligible returns 0 (staticCall)", async () => (await treasury.connect(deployer).refillAll.staticCall()) === 0n, "");

  // 7. drain A below threshold -> cooldown blocks (then passes, if WAIT_COOLDOWN=1)
  await (await poolA.connect(deployer).drain(deployer.address, F(30_000))).wait();
  await expectRevert("refill(0) inside cooldown reverts CooldownActive", treasury.connect(deployer).refill(0), "CooldownActive", treasury.interface);
  await check("preview is 0 while cooling down", async () => (await treasury.previewRefill(0)) === 0n, "");
  if (process.env.WAIT_COOLDOWN === "1") {
    const p0 = await treasury.getPool(0);
    const waitUntil = Number(p0.lastRefill) + COOLDOWN + 2;
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    if (waitUntil > now) { console.log(`waiting ${waitUntil - now}s for cooldown...`); await sleep((waitUntil - now) * 1000); }
    for (let i = 0; i < 20; i++) { if ((await ethers.provider.getBlock("latest"))!.timestamp >= waitUntil) break; await sleep(6000); }
    await (await treasury.connect(deployer).refill(0)).wait();
    await check("after cooldown: A topped to 110K (target)", async () => (await token.balanceOf(aAddr)) === F(110_000), "");
  } else {
    console.log("skip: live cooldown wait (set WAIT_COOLDOWN=1 to wait the hour); covered by unit tests");
  }

  // 8. guardian powers: non-owner blocked, pause blocks refills, returnToToken works while paused
  await expectRevert("non-owner pause reverts OwnableUnauthorizedAccount", treasury.connect(deployer).pause(), "OwnableUnauthorizedAccount", treasury.interface);
  await (await treasury.connect(guardian).pause()).wait();
  await expectRevert("refillAll while paused reverts EnforcedPause", treasury.connect(deployer).refillAll(), "EnforcedPause", treasury.interface);
  await expectRevert("renounce while paused reverts CannotRenounceWhilePaused", treasury.connect(guardian).renounceOwnership(), "CannotRenounceWhilePaused", treasury.interface);
  const tokenSelfBefore = await token.balanceOf(tokenAddr);
  const toReturn = (await treasury.treasuryBalance()) - F(5_000);
  await (await treasury.connect(guardian).returnToToken(toReturn)).wait();
  await check("returnToToken while paused: token contract credited, treasury left with 5K", async () => (await token.balanceOf(tokenAddr)) === tokenSelfBefore + toReturn && (await treasury.treasuryBalance()) === F(5_000), `returned ${fmt(toReturn)}`);
  await (await treasury.connect(guardian).unpause()).wait();
  await expectRevert("setThreshold above cap reverts InvalidThreshold", treasury.connect(guardian).setThreshold(3, F(100_001)), "InvalidThreshold", treasury.interface);
  await (await treasury.connect(guardian).setThreshold(3, F(30_000))).wait();
  await check("setThreshold(3, 30K) within cap", async () => (await treasury.getPool(3)).threshold === F(30_000), "");

  // 9. truncated refill: D (never refilled) now 20K < 30K threshold, treasury only 5K -> sends 5K; cooldown IS consumed
  //    (independent audit A-M1 / F-S4: otherwise a pool with threshold >= reserve could siphon every deposit)
  const r2 = await (await treasury.connect(deployer).refill(3)).wait();
  const ev = r2!.logs.map((l: any) => { try { return treasury.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Refilled");
  const r2block = (await ethers.provider.getBlock(r2!.blockNumber))!.timestamp;
  await check("truncated refill: D +5K, event truncated=true, lastRefill == block time, treasury 0",
    async () => (await token.balanceOf(dAddr)) === F(25_000) && ev?.args.truncated === true && Number((await treasury.getPool(3)).lastRefill) === r2block && (await treasury.treasuryBalance()) === 0n, "");
  // (TreasuryEmpty is unreachable live here: every pool is inside its 1h cooldown; covered by unit tests)
  await (await token.connect(deployer).transfer(tAddr, F(10_000))).wait();
  await expectRevert("refund then immediate refill of D is blocked by the cooldown (siphon fix)", treasury.connect(deployer).refill(3), "CooldownActive", treasury.interface);
  await check("D unchanged at 25K after the blocked refill", async () => (await token.balanceOf(dAddr)) === F(25_000), "");

  // 10. disable pool
  await (await treasury.connect(guardian).setPoolEnabled(3, false)).wait();
  await expectRevert("disabled pool refill reverts PoolDisabled", treasury.connect(deployer).refill(3), "PoolDisabled", treasury.interface);

  // 11. clean up: return remainder to the token contract
  const rest = await treasury.treasuryBalance();
  if (rest > 0n) await (await treasury.connect(guardian).returnToToken(rest)).wait();
  await check("cleanup: treasury empty", async () => (await treasury.treasuryBalance()) === 0n, "");

  const spent = startEth - (await ethers.provider.getBalance(deployer.address));
  const record = { network: network.name, treasury: tAddr, deployTx: deployTx!.hash, token: tokenAddr, pools: { A: aAddr, B: bAddr, C: cAddr, D: dAddr }, guardian: guardian.address, cooldown: COOLDOWN, results, deployerEthSpent: ethers.formatEther(spent), timestamp: new Date().toISOString() };
  const out = path.join(__dirname, "..", "..", "deployments", `FulaRefillTreasury_rehearsal_sepolia_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`\nALL ${results.length} STEPS PASSED. deployer ETH spent: ${ethers.formatEther(spent)}. record: ${out}`);
  console.log(`status script: TREASURY=${tAddr} npx hardhat run scripts/RefillTreasury/refillTreasury.ts --network sepolia`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); console.log(JSON.stringify(results, null, 2)); process.exit(1); });
