// Independent audit, lens E: TEST COVERAGE GAPS for FulaRefillTreasury.
// Every `it` below targets a branch, boundary, event, return value or token interaction that the
// existing suite (test/governance/integration/FulaRefillTreasury.test.ts) does not exercise.
// Tests that document a FINDING (surprising but "by-code" behaviour) say so in their title.
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { StorageToken, StakingPool } from "../../typechain-types";

const F = (n: number | string) => ethers.parseEther(String(n));
const ONE_DAY = 24 * 60 * 60;
const MIN_COOLDOWN = 60 * 60;      // FulaRefillTreasury.MIN_COOLDOWN (1 hour)
const MAX_COOLDOWN = 30 * ONE_DAY; // FulaRefillTreasury.MAX_COOLDOWN
const MAX_PAUSE = 30 * ONE_DAY;    // FulaRefillTreasury.MAX_PAUSE
const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const MAX_THRESHOLD = (1n << 128n) - 1n;

/// Minimal raw-bytecode contract whose runtime answers EVERY call with `retLen` bytes of memory
/// where word 0 == `word`. Lets us probe `_getterReturns` (ret.length / dirty-upper-bits checks)
/// without adding a Solidity mock to the repo.
///   runtime: PUSH32 word; PUSH1 0; MSTORE; PUSH1 retLen; PUSH1 0; RETURN   (41 bytes = 0x29)
///   init:    PUSH1 0x29; PUSH1 0x0c; PUSH1 0; CODECOPY; PUSH1 0x29; PUSH1 0; RETURN (12 bytes)
function stubBytecode(word: bigint, retLen: number): string {
    const w = word.toString(16).padStart(64, "0");
    const runtime = "7f" + w + "6000" + "52" + "60" + retLen.toString(16).padStart(2, "0") + "6000" + "f3";
    if (runtime.length !== 82) throw new Error("bad runtime length");
    return "0x" + "6029600c60003960296000f3" + runtime;
}
async function deployStub(word: bigint, retLen: number): Promise<string> {
    const [deployer] = await ethers.getSigners();
    const f = new ethers.ContractFactory([], stubBytecode(word, retLen), deployer);
    const c = await f.deploy();
    await c.waitForDeployment();
    return await c.getAddress();
}

describe("FulaRefillTreasury — independent coverage audit (lens E)", function () {
    async function deployFixture() {
        const [deployer, admin, caller, stranger, sink] = await ethers.getSigners();
        const Mock = await ethers.getContractFactory("MockERC20");
        const token = await Mock.deploy(F(100_000_000));
        const tokenAddr = await token.getAddress();
        const PoolA = await ethers.getContractFactory("MockRefillPool");
        const poolA = await PoolA.deploy(tokenAddr);
        const PoolB = await ethers.getContractFactory("MockRefillPoolStorageToken");
        const poolB = await PoolB.deploy(tokenAddr);
        const poolAAddr = await poolA.getAddress();
        const poolBAddr = await poolB.getAddress();
        const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
        const pools = [
            { account: poolAAddr, threshold: F(100_000), maxThreshold: F(100_000) },
            { account: poolBAddr, threshold: F(50_000), maxThreshold: F(100_000) },
        ];
        const treasury = await Treasury.deploy(tokenAddr, admin.address, ONE_DAY, pools);
        const treasuryAddr = await treasury.getAddress();
        await token.transfer(treasuryAddr, F(1_000_000));
        return { deployer, admin, caller, stranger, sink, token, tokenAddr, poolA, poolB, poolAAddr, poolBAddr, treasury, treasuryAddr, Treasury, pools };
    }

    /// Blocklist-token fixture (mirrors StorageToken's blacklist).
    async function blocklistFixture() {
        const [deployer, admin, caller] = await ethers.getSigners();
        const Blk = await ethers.getContractFactory("MockBlocklistToken");
        const blk = await Blk.deploy(F(10_000_000));
        const blkAddr = await blk.getAddress();
        const PoolA = await ethers.getContractFactory("MockRefillPool");
        const poolA = await PoolA.deploy(blkAddr);
        const poolB = await PoolA.deploy(blkAddr);
        const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
        const treasury = await Treasury.deploy(blkAddr, admin.address, ONE_DAY, [
            { account: await poolA.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
            { account: await poolB.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
        ]);
        const treasuryAddr = await treasury.getAddress();
        await blk.transfer(treasuryAddr, F(1_000_000));
        return { deployer, admin, caller, blk, blkAddr, poolA, poolB, treasury, treasuryAddr };
    }

    /// Fee-on-transfer fixture. fee 0 at start so it can double as a "mintable" plain token.
    async function feeFixture() {
        const [deployer, admin, caller] = await ethers.getSigners();
        const Fee = await ethers.getContractFactory("MockFeeOnTransferToken");
        const fee = await Fee.deploy(0);
        const feeAddr = await fee.getAddress();
        const PoolA = await ethers.getContractFactory("MockRefillPool");
        const pool = await PoolA.deploy(feeAddr);
        const poolAddr = await pool.getAddress();
        return { deployer, admin, caller, fee, feeAddr, pool, poolAddr };
    }

    // =========================================================== constructor branches
    describe("constructor branches not covered by the existing suite", function () {
        it("L139: a zero pool account reverts ZeroAddress", async function () {
            const { Treasury, tokenAddr, admin, pools } = await loadFixture(deployFixture);
            await expect(Treasury.deploy(tokenAddr, admin.address, MIN_COOLDOWN, [{ ...pools[0], account: ethers.ZeroAddress }]))
                .to.be.revertedWithCustomError(Treasury, "ZeroAddress");
        });

        it("L140: the treasury's own (predicted) address is rejected as a pool with InvalidPoolAccount, before the code-length check", async function () {
            const { Treasury, tokenAddr, admin, pools, deployer } = await loadFixture(deployFixture);
            const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: await deployer.getNonce() });
            await expect(Treasury.deploy(tokenAddr, admin.address, MIN_COOLDOWN, [pools[0], { ...pools[1], account: predicted }]))
                .to.be.revertedWithCustomError(Treasury, "InvalidPoolAccount").withArgs(predicted);
        });

        it("L330/L332: getter returning 64 bytes, or a 32-byte word with dirty upper bits, is rejected; a clean word for ANY selector is accepted", async function () {
            const { Treasury, tokenAddr, admin } = await loadFixture(deployFixture);
            const tokenWord = BigInt(tokenAddr);
            const dirty = await deployStub(tokenWord | (1n << 160n), 32);
            const long = await deployStub(tokenWord, 64);
            const clean = await deployStub(tokenWord, 32);
            // sanity: the stubs really return what we think for token()
            const sel = ethers.id("token()").slice(0, 10);
            expect(await ethers.provider.call({ to: clean, data: sel })).to.equal(ethers.zeroPadValue(tokenAddr, 32));
            expect((await ethers.provider.call({ to: long, data: sel })).length).to.equal(2 + 128);
            expect(await ethers.provider.call({ to: dirty, data: sel })).to.equal(ethers.toBeHex(tokenWord | (1n << 160n), 32));

            const base = { threshold: F(1000), maxThreshold: F(1000) };
            await expect(Treasury.deploy(tokenAddr, admin.address, MIN_COOLDOWN, [{ ...base, account: dirty }]))
                .to.be.revertedWithCustomError(Treasury, "PoolTokenMismatch").withArgs(dirty);
            await expect(Treasury.deploy(tokenAddr, admin.address, MIN_COOLDOWN, [{ ...base, account: long }]))
                .to.be.revertedWithCustomError(Treasury, "PoolTokenMismatch").withArgs(long);
            const t = await Treasury.deploy(tokenAddr, admin.address, MIN_COOLDOWN, [{ ...base, account: clean }]);
            expect(await t.isPool(clean)).to.equal(true);
        });

        it("emits PoolRegistered(poolId, account, threshold, maxThreshold) for every pool, in order", async function () {
            const { treasury, poolAAddr, poolBAddr } = await loadFixture(deployFixture);
            const receipt = await treasury.deploymentTransaction()!.wait();
            const logs = receipt!.logs
                .map((l) => { try { return treasury.interface.parseLog(l as any); } catch { return null; } })
                .filter((l) => l && l.name === "PoolRegistered");
            expect(logs.length).to.equal(2);
            expect(logs[0]!.args.poolId).to.equal(0n);
            expect(logs[0]!.args.account).to.equal(poolAAddr);
            expect(logs[0]!.args.threshold).to.equal(F(100_000));
            expect(logs[0]!.args.maxThreshold).to.equal(F(100_000));
            expect(logs[1]!.args.poolId).to.equal(1n);
            expect(logs[1]!.args.account).to.equal(poolBAddr);
            expect(logs[1]!.args.threshold).to.equal(F(50_000));
            expect(logs[1]!.args.maxThreshold).to.equal(F(100_000));
        });

        it("REGRESSION (was FINDING Low): a cooldown >= current unix time (an absolute timestamp passed as a duration) is now rejected at construction with CooldownOutOfRange instead of freezing every pool", async function () {
            const { Treasury, tokenAddr, admin, pools } = await loadFixture(deployFixture);
            const now = await time.latest();
            const cooldown = BigInt(now) + 1000n;
            expect(cooldown).to.be.greaterThan(BigInt(MAX_COOLDOWN)); // precondition: a unix timestamp is always > 30 days
            await expect(Treasury.deploy(tokenAddr, admin.address, cooldown, pools))
                .to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange").withArgs(cooldown, MIN_COOLDOWN, MAX_COOLDOWN);
        });

        it("cooldown bounds: 0, MIN-1 (3599) and MAX+1 (30 days + 1) revert CooldownOutOfRange; MIN (3600) and MAX (30 days) are accepted and stored", async function () {
            const { Treasury, tokenAddr, admin, pools, treasury } = await loadFixture(deployFixture);
            expect(await treasury.MIN_COOLDOWN()).to.equal(MIN_COOLDOWN);
            expect(await treasury.MAX_COOLDOWN()).to.equal(MAX_COOLDOWN);
            for (const bad of [0, MIN_COOLDOWN - 1, MAX_COOLDOWN + 1]) {
                await expect(Treasury.deploy(tokenAddr, admin.address, bad, pools), `cooldown ${bad}`)
                    .to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange").withArgs(bad, MIN_COOLDOWN, MAX_COOLDOWN);
            }
            for (const ok of [MIN_COOLDOWN, MAX_COOLDOWN]) {
                const t = await Treasury.deploy(tokenAddr, admin.address, ok, pools);
                expect(await t.cooldown(), `cooldown ${ok}`).to.equal(ok);
            }
        });
    });

    // =========================================================== refill / _refill / _amountFor
    describe("refill amount and state branches", function () {
        it("refill() returns the amount sent (full and truncated), matching previewRefill", async function () {
            const { treasury, caller, admin } = await loadFixture(deployFixture);
            expect(await treasury.connect(caller).refill.staticCall(0)).to.equal(F(100_000));
            await treasury.connect(admin).returnToToken(F(1_000_000) - F(30_000));
            expect(await treasury.previewRefill(0)).to.equal(F(30_000));
            expect(await treasury.connect(caller).refill.staticCall(0)).to.equal(F(30_000));
        });

        it("Refilled event carries a non-zero poolBalanceBefore", async function () {
            const { treasury, token, poolAAddr, caller } = await loadFixture(deployFixture);
            await token.transfer(poolAAddr, F(60_000));
            await expect(treasury.connect(caller).refill(0))
                .to.emit(treasury, "Refilled").withArgs(0, poolAAddr, caller.address, F(50_000), F(60_000), false);
        });

        it("L311 cap: a pool below 10% of threshold lands BELOW target (threshold+balance), is not 'truncated', and burns the cooldown (contradicts the header comment 'bringing it to threshold*1.10')", async function () {
            const { treasury, token, poolAAddr, caller } = await loadFixture(deployFixture);
            await token.transfer(poolAAddr, F(5_000));
            expect(await treasury.previewRefill(0)).to.equal(F(100_000));
            await expect(treasury.connect(caller).refill(0))
                .to.emit(treasury, "Refilled").withArgs(0, poolAAddr, caller.address, F(100_000), F(5_000), false);
            expect(await token.balanceOf(poolAAddr)).to.equal(F(105_000)); // < targetOf(0) == 110_000
            expect(await token.balanceOf(poolAAddr)).to.be.lessThan(await treasury.targetOf(0));
            expect((await treasury.getPool(0)).lastRefill).to.equal(await time.latest());
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "NotBelowThreshold");
        });

        it("L313 boundary: treasury balance exactly equal to the needed amount is NOT truncated and sets lastRefill", async function () {
            const { treasury, caller, admin, poolAAddr, token, treasuryAddr } = await loadFixture(deployFixture);
            await treasury.connect(admin).returnToToken(F(1_000_000) - F(100_000));
            await expect(treasury.connect(caller).refill(0))
                .to.emit(treasury, "Refilled").withArgs(0, poolAAddr, caller.address, F(100_000), 0, false);
            expect(await token.balanceOf(treasuryAddr)).to.equal(0);
            expect((await treasury.getPool(0)).lastRefill).to.equal(await time.latest());
        });

        it("cooldown boundary: refill at exactly lastRefill+cooldown-1 reverts, at exactly lastRefill+cooldown succeeds", async function () {
            const { treasury, caller, poolA } = await loadFixture(deployFixture);
            await treasury.connect(caller).refill(0);
            const last = await time.latest();
            expect((await treasury.getPool(0)).lastRefill).to.equal(last);
            await poolA.drain(caller.address, F(100_000));
            const at = last + ONE_DAY;
            await time.setNextBlockTimestamp(at - 1);
            // explicit gasLimit so hardhat actually mines the reverting tx at exactly at-1 (no estimateGas short-circuit)
            await expect(treasury.connect(caller).refill(0, { gasLimit: 300_000 })).to.be.revertedWithCustomError(treasury, "CooldownActive").withArgs(0, at);
            expect(await time.latest()).to.equal(at - 1);
            await time.setNextBlockTimestamp(at);
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
            expect(await time.latest()).to.equal(at);
            expect((await treasury.getPool(0)).lastRefill).to.equal(at);
        });

        it("previewRefill reports the truncated amount when the treasury is short and 0 when it is empty; treasuryBalance tracks", async function () {
            const { treasury, caller, admin } = await loadFixture(deployFixture);
            expect(await treasury.treasuryBalance()).to.equal(F(1_000_000));
            await treasury.connect(admin).returnToToken(F(1_000_000) - F(30_000));
            expect(await treasury.treasuryBalance()).to.equal(F(30_000));
            expect(await treasury.previewRefill(0)).to.equal(F(30_000));
            await treasury.connect(admin).returnToToken(F(30_000));
            expect(await treasury.treasuryBalance()).to.equal(0);
            expect(await treasury.previewRefill(0)).to.equal(0);
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "TreasuryEmpty");
        });

        it("previewRefill == refill.staticCall (or 0 where strict refill reverts) across every eligibility state", async function () {
            const { treasury, token, poolA, poolAAddr, caller, admin } = await loadFixture(deployFixture);
            const strictOrZero = async (id: number) => { try { return await treasury.connect(caller).refill.staticCall(id); } catch { return 0n; } };
            const check = async (label: string, expected: bigint) => {
                expect(await treasury.previewRefill(0), `${label}: preview`).to.equal(expected);
                expect(await strictOrZero(0), `${label}: strict`).to.equal(expected);
            };
            await check("empty pool", F(100_000));
            await token.transfer(poolAAddr, F(100_001));
            await check("above threshold", 0n);
            await poolA.drain(caller.address, F(100_001));
            await treasury.connect(caller).refill(0);
            await poolA.drain(caller.address, F(100_000));
            await check("cooldown", 0n);
            await time.increase(ONE_DAY + 1);
            await treasury.connect(admin).setPoolEnabled(0, false);
            await check("disabled", 0n);
            await treasury.connect(admin).setPoolEnabled(0, true);
            await treasury.connect(admin).returnToToken(F(900_000) - F(40_000));
            await check("truncated", F(40_000));
            await treasury.connect(admin).returnToToken(F(40_000));
            await check("empty treasury", 0n);
        });

        it("poolIdOf reverts with UnknownPool(type(uint256).max) for an unregistered account; isPool is false for token/zero/treasury", async function () {
            const { treasury, tokenAddr, treasuryAddr, stranger } = await loadFixture(deployFixture);
            await expect(treasury.poolIdOf(stranger.address)).to.be.revertedWithCustomError(treasury, "UnknownPool").withArgs(ethers.MaxUint256);
            expect(await treasury.isPool(tokenAddr)).to.equal(false);
            expect(await treasury.isPool(ethers.ZeroAddress)).to.equal(false);
            expect(await treasury.isPool(treasuryAddr)).to.equal(false);
        });

        it("MAX_THRESHOLD in action: threshold == 2^128-1 previews/refills exactly MAX, targetOf does not overflow, setThreshold(MAX) ok and MAX+1 rejected", async function () {
            const { fee, feeAddr, pool, poolAddr, admin, caller } = await loadFixture(feeFixture);
            const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
            const t = await Treasury.deploy(feeAddr, admin.address, MIN_COOLDOWN, [{ account: poolAddr, threshold: MAX_THRESHOLD, maxThreshold: MAX_THRESHOLD }]);
            expect(await t.MAX_THRESHOLD()).to.equal(MAX_THRESHOLD);
            await fee.mintFree(await t.getAddress(), 1n << 130n);
            expect(await t.targetOf(0)).to.equal(MAX_THRESHOLD * 11_000n / 10_000n);
            expect(await t.previewRefill(0)).to.equal(MAX_THRESHOLD);
            await expect(t.connect(caller).refill(0)).to.emit(t, "Refilled").withArgs(0, poolAddr, caller.address, MAX_THRESHOLD, 0, false);
            expect(await fee.balanceOf(poolAddr)).to.equal(MAX_THRESHOLD);
            await t.connect(admin).setThreshold(0, 1);
            await expect(t.connect(admin).setThreshold(0, MAX_THRESHOLD)).to.emit(t, "ThresholdUpdated").withArgs(0, 1, MAX_THRESHOLD);
            await expect(t.connect(admin).setThreshold(0, MAX_THRESHOLD + 1n)).to.be.revertedWithCustomError(t, "InvalidThreshold").withArgs(MAX_THRESHOLD + 1n, MAX_THRESHOLD);
        });
    });

    // =========================================================== refillAll
    describe("refillAll skip and partial-fill branches", function () {
        it("L287 non-strict: a pool in cooldown is SKIPPED (not reverted) while the other pool is served; total reflects only what was sent", async function () {
            const { treasury, token, poolA, poolAAddr, poolBAddr, caller } = await loadFixture(deployFixture);
            await treasury.connect(caller).refill(0);
            await poolA.drain(caller.address, F(100_000)); // A empty again, in cooldown; B empty, eligible
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(F(50_000));
            await expect(treasury.connect(caller).refillAll())
                .to.emit(treasury, "Refilled").withArgs(1, poolBAddr, caller.address, F(50_000), 0, false);
            expect(await token.balanceOf(poolAAddr)).to.equal(0);
            expect(await token.balanceOf(poolBAddr)).to.equal(F(50_000));
        });

        it("partial fill sequence: a TRUNCATED refill consumes the cooldown too (lastRefill set); the truncated pool is NOT served again after re-funding until its cooldown passes, then both pools are served", async function () {
            const { treasury, token, poolA, poolAAddr, poolBAddr, caller, admin, treasuryAddr } = await loadFixture(deployFixture);
            await treasury.connect(admin).returnToToken(F(1_000_000) - F(120_000));
            const receipt = await (await treasury.connect(caller).refillAll()).wait(); // A: 100k full, B: 20k truncated
            const refilled = receipt!.logs
                .map((l) => { try { return treasury.interface.parseLog(l as any); } catch { return null; } })
                .filter((l) => l && l.name === "Refilled");
            expect(refilled.length).to.equal(2);
            expect(refilled[0]!.args.poolId).to.equal(0n);
            expect(refilled[0]!.args.amount).to.equal(F(100_000));
            expect(refilled[0]!.args.truncated).to.equal(false);
            expect(refilled[1]!.args.poolId).to.equal(1n);
            expect(refilled[1]!.args.amount).to.equal(F(20_000));
            expect(refilled[1]!.args.truncated).to.equal(true);
            const t0 = await time.latest();
            const tA = (await treasury.getPool(0)).lastRefill;
            const tB = (await treasury.getPool(1)).lastRefill;
            expect(tA).to.equal(t0);
            expect(tB).to.equal(t0); // truncated refill still consumed the cooldown
            expect(await token.balanceOf(poolBAddr)).to.equal(F(20_000));
            expect(await token.balanceOf(treasuryAddr)).to.equal(0);

            await token.transfer(treasuryAddr, F(500_000));
            await poolA.drain(caller.address, F(100_000));
            // A: empty but in cooldown -> skipped. B: 20k < 50k but ALSO in cooldown -> skipped.
            expect(await treasury.previewRefill(1)).to.equal(0);
            await expect(treasury.connect(caller).refill(1)).to.be.revertedWithCustomError(treasury, "CooldownActive").withArgs(1, Number(tB) + ONE_DAY);
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(0);
            await treasury.connect(caller).refillAll();
            expect(await token.balanceOf(poolAAddr)).to.equal(0);
            expect(await token.balanceOf(poolBAddr)).to.equal(F(20_000));
            expect((await treasury.getPool(0)).lastRefill).to.equal(tA);
            expect((await treasury.getPool(1)).lastRefill).to.equal(tB);

            // one second before the shared cooldown expires: a real tx (not a view, whose pending-block
            // timestamp is one ahead) still reverts for B
            await time.setNextBlockTimestamp(t0 + ONE_DAY - 1);
            await expect(treasury.connect(caller).refill(1, { gasLimit: 300_000 })).to.be.revertedWithCustomError(treasury, "CooldownActive").withArgs(1, t0 + ONE_DAY);
            expect(await time.latest()).to.equal(t0 + ONE_DAY - 1);
            // Mine the batch at EXACTLY lastRefill + cooldown to pin the `<` boundary for both pools. Amounts are
            // read from the receipt rather than a staticCall, because a view's timestamp at a +-1 boundary is
            // Hardhat-version-dependent. A: empty -> +100k (threshold); B: 20k -> target 55k -> +35k.
            await time.setNextBlockTimestamp(t0 + ONE_DAY);
            const receipt2 = await (await treasury.connect(caller).refillAll()).wait();
            expect(await time.latest()).to.equal(t0 + ONE_DAY);
            const refilled2 = receipt2!.logs
                .map((l) => { try { return treasury.interface.parseLog(l as any); } catch { return null; } })
                .filter((l) => l && l.name === "Refilled");
            expect(refilled2.length).to.equal(2);
            expect(refilled2[0]!.args.poolId).to.equal(0n);
            expect(refilled2[0]!.args.amount).to.equal(F(100_000));
            expect(refilled2[0]!.args.poolBalanceBefore).to.equal(0);
            expect(refilled2[0]!.args.truncated).to.equal(false);
            expect(refilled2[1]!.args.poolId).to.equal(1n);
            expect(refilled2[1]!.args.amount).to.equal(F(35_000));
            expect(refilled2[1]!.args.poolBalanceBefore).to.equal(F(20_000));
            expect(refilled2[1]!.args.truncated).to.equal(false);
            expect(await token.balanceOf(poolAAddr)).to.equal(F(100_000));
            expect(await token.balanceOf(poolBAddr)).to.equal(F(55_000));
            expect((await treasury.getPool(0)).lastRefill).to.equal(t0 + ONE_DAY);
            expect((await treasury.getPool(1)).lastRefill).to.equal(t0 + ONE_DAY);
            // both pools full now: nothing to do, unambiguous for a view
            expect(await treasury.previewRefill(0)).to.equal(0);
            expect(await treasury.previewRefill(1)).to.equal(0);
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(0);
        });

        it("refillAll is guarded by the same reentrancy lock: a pool re-entering refill() during the batch is rejected", async function () {
            const [, admin, caller] = await ethers.getSigners();
            const Hooked = await ethers.getContractFactory("MockReentrantToken");
            const hooked = await Hooked.deploy(F(10_000_000));
            const Pool = await ethers.getContractFactory("MockReentrantPool");
            const pool = await Pool.deploy(await hooked.getAddress());
            const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
            const treasury = await Treasury.deploy(await hooked.getAddress(), admin.address, MIN_COOLDOWN, [
                { account: await pool.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
            ]);
            await hooked.transfer(await treasury.getAddress(), F(1_000_000));
            await pool.arm(await treasury.getAddress(), 0);
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(F(100_000));
            await treasury.connect(caller).refillAll();
            expect(await pool.attempted()).to.equal(true);
            expect(await pool.reentered()).to.equal(false);
            expect(await hooked.balanceOf(await pool.getAddress())).to.equal(F(100_000));
            expect(await hooked.balanceOf(await treasury.getAddress())).to.equal(F(900_000));
        });
    });

    // =========================================================== guardian
    describe("guardian paths not covered", function () {
        it("pause/unpause emit Paused(account, until=now+MAX_PAUSE)/Unpaused(account) and set/clear pausedUntil; double pause reverts EnforcedPause; unpause when live reverts ExpectedPause", async function () {
            const { treasury, admin, caller } = await loadFixture(deployFixture);
            expect(await treasury.MAX_PAUSE()).to.equal(MAX_PAUSE);
            expect(await treasury.pausedUntil()).to.equal(0);
            await expect(treasury.connect(admin).unpause()).to.be.revertedWithCustomError(treasury, "ExpectedPause");
            const at = (await time.latest()) + 10;
            await time.setNextBlockTimestamp(at);
            await expect(treasury.connect(admin).pause()).to.emit(treasury, "Paused").withArgs(admin.address, at + MAX_PAUSE);
            expect(await treasury.pausedUntil()).to.equal(at + MAX_PAUSE);
            expect(await treasury.paused()).to.equal(true);
            expect(await treasury.previewRefill(0)).to.equal(0);
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            await expect(treasury.connect(caller).refillAll()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            await expect(treasury.connect(admin).pause()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            await expect(treasury.connect(admin).unpause()).to.emit(treasury, "Unpaused").withArgs(admin.address);
            expect(await treasury.pausedUntil()).to.equal(0);
            expect(await treasury.paused()).to.equal(false);
            expect(await treasury.previewRefill(0)).to.equal(F(100_000));
        });

        it("pause EXPIRES: after MAX_PAUSE (30 days) + 1 the treasury is unpaused with no owner action, refill works, unpause() reverts ExpectedPause, and the owner can re-pause to extend", async function () {
            const { treasury, admin, caller, poolAAddr } = await loadFixture(deployFixture);
            await treasury.connect(admin).pause();
            const pausedAt = await time.latest();
            const until = Number(await treasury.pausedUntil());
            expect(until).to.equal(pausedAt + MAX_PAUSE);
            expect(await treasury.paused()).to.equal(true);
            // last second of the pause window (a real tx at exactly until-1): still paused
            await time.setNextBlockTimestamp(until - 1);
            await expect(treasury.connect(caller).refill(0, { gasLimit: 300_000 })).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            expect(await time.latest()).to.equal(until - 1);
            // block.timestamp == pausedUntil exactly: already unpaused (strict `<`), so unpause() has nothing to do
            await time.setNextBlockTimestamp(until);
            await expect(treasury.connect(admin).unpause({ gasLimit: 300_000 })).to.be.revertedWithCustomError(treasury, "ExpectedPause");
            expect(await time.latest()).to.equal(until);
            // MAX_PAUSE + 1 after the pause tx: unpaused with NO owner action
            await time.increaseTo(pausedAt + MAX_PAUSE + 1);
            expect(await treasury.paused()).to.equal(false);
            expect(await treasury.pausedUntil()).to.equal(until); // storage untouched; expiry is purely time-based
            expect(await treasury.previewRefill(0)).to.equal(F(100_000));
            await expect(treasury.connect(caller).refill(0))
                .to.emit(treasury, "Refilled").withArgs(0, poolAAddr, caller.address, F(100_000), 0, false);
            await expect(treasury.connect(admin).unpause()).to.be.revertedWithCustomError(treasury, "ExpectedPause");
            // guardian may pause again (extend) once the previous window has lapsed
            await expect(treasury.connect(admin).pause()).to.emit(treasury, "Paused");
            expect(await treasury.paused()).to.equal(true);
            expect(await treasury.pausedUntil()).to.equal((await time.latest()) + MAX_PAUSE);
            await expect(treasury.connect(admin).renounceOwnership()).to.be.revertedWithCustomError(treasury, "CannotRenounceWhilePaused");
        });

        it("setThreshold and setPoolEnabled still work while paused (no whenNotPaused on guardian config)", async function () {
            const { treasury, admin } = await loadFixture(deployFixture);
            await treasury.connect(admin).pause();
            await expect(treasury.connect(admin).setThreshold(0, F(1))).to.emit(treasury, "ThresholdUpdated").withArgs(0, F(100_000), F(1));
            await expect(treasury.connect(admin).setPoolEnabled(0, false)).to.emit(treasury, "PoolEnabledUpdated").withArgs(0, false);
            expect((await treasury.getPool(0)).threshold).to.equal(F(1));
            expect((await treasury.getPool(0)).enabled).to.equal(false);
        });

        it("setPoolEnabled: disable then RE-ENABLE (event + getPool state), refill works again, lastRefill/threshold untouched", async function () {
            const { treasury, admin, caller, poolA } = await loadFixture(deployFixture);
            await treasury.connect(caller).refill(0);
            const before = await treasury.getPool(0);
            await expect(treasury.connect(admin).setPoolEnabled(0, false)).to.emit(treasury, "PoolEnabledUpdated").withArgs(0, false);
            expect((await treasury.getPool(0)).enabled).to.equal(false);
            await expect(treasury.connect(admin).setPoolEnabled(0, true)).to.emit(treasury, "PoolEnabledUpdated").withArgs(0, true);
            const after = await treasury.getPool(0);
            expect(after.enabled).to.equal(true);
            expect(after.lastRefill).to.equal(before.lastRefill);
            expect(after.threshold).to.equal(before.threshold);
            expect(after.maxThreshold).to.equal(before.maxThreshold);
            expect(after.account).to.equal(before.account);
            await poolA.drain(caller.address, F(100_000));
            await time.increase(ONE_DAY + 1);
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
        });

        it("setThreshold below the pool's balance makes it ineligible (NotBelowThreshold with the new threshold) and does not reset lastRefill", async function () {
            const { treasury, admin, caller, poolA, token, poolAAddr } = await loadFixture(deployFixture);
            await treasury.connect(caller).refill(0); // A = 100k, lastRefill set
            const last = (await treasury.getPool(0)).lastRefill;
            await poolA.drain(caller.address, F(40_000)); // A = 60k
            await treasury.connect(admin).setThreshold(0, F(50_000));
            expect((await treasury.getPool(0)).lastRefill).to.equal(last);
            expect(await treasury.previewRefill(0)).to.equal(0);
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "NotBelowThreshold").withArgs(0, F(60_000), F(50_000));
            // raising back above the balance -> still in cooldown from the earlier full refill
            await treasury.connect(admin).setThreshold(0, F(100_000));
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
            expect(await token.balanceOf(poolAAddr)).to.equal(F(60_000));
        });

        it("returnToToken boundary: amount == full balance succeeds and leaves 0; afterwards refill reverts TreasuryEmpty", async function () {
            const { treasury, admin, caller, token, tokenAddr, treasuryAddr } = await loadFixture(deployFixture);
            const before = await token.balanceOf(tokenAddr);
            await expect(treasury.connect(admin).returnToToken(F(1_000_000))).to.emit(treasury, "ReturnedToToken").withArgs(admin.address, F(1_000_000));
            expect(await token.balanceOf(treasuryAddr)).to.equal(0);
            expect(await token.balanceOf(tokenAddr)).to.equal(before + F(1_000_000));
            await expect(treasury.connect(admin).returnToToken(1)).to.be.revertedWithCustomError(treasury, "InsufficientTreasuryBalance").withArgs(1, 0);
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "TreasuryEmpty");
        });
    });

    // =========================================================== ownership
    describe("Ownable2Step edge cases", function () {
        it("transferOwnership emits OwnershipTransferStarted, sets pendingOwner; old owner keeps guardian powers and pending owner has none until accept", async function () {
            const { treasury, admin, stranger } = await loadFixture(deployFixture);
            await expect(treasury.connect(admin).transferOwnership(stranger.address))
                .to.emit(treasury, "OwnershipTransferStarted").withArgs(admin.address, stranger.address);
            expect(await treasury.pendingOwner()).to.equal(stranger.address);
            await expect(treasury.connect(stranger).pause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount").withArgs(stranger.address);
            await treasury.connect(admin).pause();
            await treasury.connect(admin).unpause();
            await expect(treasury.connect(stranger).acceptOwnership())
                .to.emit(treasury, "OwnershipTransferred").withArgs(admin.address, stranger.address);
            expect(await treasury.pendingOwner()).to.equal(ethers.ZeroAddress);
            await expect(treasury.connect(admin).pause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount").withArgs(admin.address);
        });

        it("acceptOwnership by a non-pending account reverts; a second transferOwnership overwrites the pending owner", async function () {
            const { treasury, admin, stranger, caller } = await loadFixture(deployFixture);
            await expect(treasury.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount").withArgs(stranger.address);
            await treasury.connect(admin).transferOwnership(stranger.address);
            await treasury.connect(admin).transferOwnership(caller.address);
            expect(await treasury.pendingOwner()).to.equal(caller.address);
            await expect(treasury.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount").withArgs(stranger.address);
            await treasury.connect(caller).acceptOwnership();
            expect(await treasury.owner()).to.equal(caller.address);
        });

        it("renounceOwnership by a non-owner reverts; renouncing with a pending owner set clears it (pending can never accept)", async function () {
            const { treasury, admin, stranger } = await loadFixture(deployFixture);
            await expect(treasury.connect(stranger).renounceOwnership()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount").withArgs(stranger.address);
            await treasury.connect(admin).transferOwnership(stranger.address);
            await expect(treasury.connect(admin).renounceOwnership()).to.emit(treasury, "OwnershipTransferred").withArgs(admin.address, ethers.ZeroAddress);
            expect(await treasury.owner()).to.equal(ethers.ZeroAddress);
            expect(await treasury.pendingOwner()).to.equal(ethers.ZeroAddress);
            await expect(treasury.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount").withArgs(stranger.address);
        });

        it("DESIGN NOTE (Info): renouncing while a pool is disabled freezes it disabled forever; thresholds are frozen; returnToToken is gone (funds only leave via refills)", async function () {
            const { treasury, admin, caller, poolBAddr, token } = await loadFixture(deployFixture);
            await treasury.connect(admin).setPoolEnabled(0, false);
            await treasury.connect(admin).renounceOwnership();
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "PoolDisabled").withArgs(0);
            await expect(treasury.connect(admin).setPoolEnabled(0, true)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
            await expect(treasury.connect(admin).setThreshold(1, F(1))).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
            await expect(treasury.connect(admin).returnToToken(F(1))).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
            await expect(treasury.connect(admin).pause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
            // the other pool still refills
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(F(50_000));
            await treasury.connect(caller).refillAll();
            expect(await token.balanceOf(poolBAddr)).to.equal(F(50_000));
        });
    });

    // =========================================================== token quirks
    describe("token-level rejections the treasury cannot see", function () {
        it("treasury itself blocklisted: refill, refillAll AND returnToToken all revert (funds frozen until the token unblocks it); previewRefill still reports a non-zero amount", async function () {
            const { treasury, treasuryAddr, blk, admin, caller } = await loadFixture(blocklistFixture);
            await blk.setBlocked(treasuryAddr, true);
            expect(await treasury.previewRefill(0)).to.equal(F(100_000));
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(blk, "Blocked").withArgs(treasuryAddr);
            await expect(treasury.connect(caller).refillAll()).to.be.revertedWithCustomError(blk, "Blocked").withArgs(treasuryAddr);
            await expect(treasury.connect(admin).returnToToken(F(1))).to.be.revertedWithCustomError(blk, "Blocked").withArgs(treasuryAddr);
            await blk.setBlocked(treasuryAddr, false);
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
        });

        it("token contract itself blocklisted: returnToToken is bricked while refills keep working", async function () {
            const { treasury, blk, blkAddr, admin, caller } = await loadFixture(blocklistFixture);
            await blk.setBlocked(blkAddr, true);
            await expect(treasury.connect(admin).returnToToken(F(1))).to.be.revertedWithCustomError(blk, "Blocked").withArgs(blkAddr);
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
        });

        it("fee token: returnToToken event reports the requested amount while the token contract receives amount - fee", async function () {
            const { fee, feeAddr, poolAddr, admin } = await loadFixture(feeFixture);
            const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
            const t = await Treasury.deploy(feeAddr, admin.address, ONE_DAY, [{ account: poolAddr, threshold: F(100_000), maxThreshold: F(100_000) }]);
            await fee.mintFree(await t.getAddress(), F(1_000_000));
            await fee.setFeeBps(100); // 1%
            const before = await fee.balanceOf(feeAddr);
            await expect(t.connect(admin).returnToToken(F(100))).to.emit(t, "ReturnedToToken").withArgs(admin.address, F(100));
            expect(await fee.balanceOf(feeAddr)).to.equal(before + F(99));
            expect(await fee.balanceOf("0x0000000000000000000000000000000000000FEE")).to.equal(F(1));
        });

        it("fee token: refillAll with a fee lands every pool short; previewRefill promises the gross amount", async function () {
            const { fee, feeAddr, poolAddr, admin, caller } = await loadFixture(feeFixture);
            const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
            const t = await Treasury.deploy(feeAddr, admin.address, ONE_DAY, [{ account: poolAddr, threshold: F(100_000), maxThreshold: F(100_000) }]);
            await fee.mintFree(await t.getAddress(), F(1_000_000));
            await fee.setFeeBps(500); // 5% = StorageToken MAX_BPS
            expect(await t.previewRefill(0)).to.equal(F(100_000));
            expect(await t.connect(caller).refillAll.staticCall()).to.equal(F(100_000));
            await t.connect(caller).refillAll();
            expect(await fee.balanceOf(poolAddr)).to.equal(F(95_000)); // still below threshold, cooldown burned
            expect(await t.previewRefill(0)).to.equal(0);
            expect(await t.connect(caller).refillAll.staticCall()).to.equal(0);
        });
    });

    // =========================================================== real StorageToken paused
    describe("integration: StorageToken governance pause", function () {
        async function realTokenFixture() {
            const [owner, admin, engine, caller] = await ethers.getSigners();
            const TOTAL = F(10_000_000);
            const StorageToken = await ethers.getContractFactory("StorageToken");
            const token = (await upgrades.deployProxy(StorageToken, [owner.address, admin.address, TOTAL], { kind: "uups", initializer: "initialize" })) as unknown as StorageToken;
            await token.waitForDeployment();
            const tokenAddr = await token.getAddress();
            await time.increase(ONE_DAY + 1);
            await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            await time.increase(ONE_DAY + 1);
            await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL);
            const StakingPool = await ethers.getContractFactory("StakingPool");
            const pool = (await upgrades.deployProxy(StakingPool, [tokenAddr, owner.address, admin.address], { kind: "uups", initializer: "initialize" })) as unknown as StakingPool;
            await pool.waitForDeployment();
            const poolAddr = await pool.getAddress();
            await time.increase(ONE_DAY + 1);
            await pool.connect(owner).setStakingEngine(engine.address);
            const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
            const treasury = await Treasury.deploy(tokenAddr, admin.address, ONE_DAY, [{ account: poolAddr, threshold: F(100_000), maxThreshold: F(100_000) }]);
            const treasuryAddr = await treasury.getAddress();
            const tx = await token.connect(owner).createProposal(5, 0, treasuryAddr, ethers.ZeroHash, 0, ethers.ZeroAddress);
            const receipt = await tx.wait();
            const proposalId = receipt!.logs[0].topics[1];
            await time.increase(ONE_DAY + 1);
            await token.connect(admin).approveProposal(proposalId);
            await time.increase(ONE_DAY + 1);
            await token.connect(owner).transferFromContract(treasuryAddr, F(1_000_000));
            return { owner, admin, engine, caller, token, tokenAddr, pool, poolAddr, treasury, treasuryAddr };
        }

        it("while FULA is paused by its governance, refill/refillAll/returnToToken all revert with the TOKEN's EnforcedPause (treasury itself unpaused) and previewRefill is blind to it; unpause restores", async function () {
            this.timeout(120_000);
            const { owner, admin, caller, token, treasury, poolAddr } = await loadFixture(realTokenFixture);
            expect(await treasury.treasuryBalance()).to.equal(F(1_000_000));
            await token.connect(owner).emergencyAction(1);
            expect(await token.paused()).to.equal(true);
            expect(await treasury.paused()).to.equal(false);
            expect(await treasury.previewRefill(0)).to.equal(F(100_000));
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(token, "EnforcedPause");
            await expect(treasury.connect(caller).refillAll()).to.be.revertedWithCustomError(token, "EnforcedPause");
            await expect(treasury.connect(admin).returnToToken(F(1))).to.be.revertedWithCustomError(token, "EnforcedPause");
            await time.increase(31 * 60); // EMERGENCY_COOLDOWN = 30 minutes
            await token.connect(owner).emergencyAction(2);
            await expect(treasury.connect(caller).refill(0)).to.emit(treasury, "Refilled").withArgs(0, poolAddr, caller.address, F(100_000), 0, false);
            expect(await token.balanceOf(poolAddr)).to.equal(F(100_000));
        });
    });
});
