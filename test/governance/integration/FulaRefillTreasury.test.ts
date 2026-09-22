import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { StorageToken, StakingPool } from "../../../typechain-types";

const F = (n: number | string) => ethers.parseEther(String(n));
const ONE_DAY = 24 * 60 * 60;
const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

describe("FulaRefillTreasury", function () {
    // ------------------------------------------------------------------ fixture (mock token)
    async function deployFixture() {
        const [deployer, admin, caller, stranger, sink] = await ethers.getSigners();

        const Mock = await ethers.getContractFactory("MockERC20");
        const token = await Mock.deploy(F(100_000_000));
        const tokenAddr = await token.getAddress();

        const PoolA = await ethers.getContractFactory("MockRefillPool");
        const poolA = await PoolA.deploy(tokenAddr); // token()
        const PoolB = await ethers.getContractFactory("MockRefillPoolStorageToken");
        const poolB = await PoolB.deploy(tokenAddr); // storageToken()

        const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
        const pools = [
            { account: await poolA.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
            { account: await poolB.getAddress(), threshold: F(50_000), maxThreshold: F(100_000) },
        ];
        const treasury = await Treasury.deploy(tokenAddr, admin.address, ONE_DAY, pools);
        const treasuryAddr = await treasury.getAddress();
        await token.transfer(treasuryAddr, F(1_000_000));

        return { deployer, admin, caller, stranger, sink, token, tokenAddr, poolA, poolB, treasury, treasuryAddr, Treasury, pools };
    }

    // ------------------------------------------------------------------ construction
    describe("construction", function () {
        it("registers pools with ids in order and emits PoolRegistered", async function () {
            const { treasury, poolA, poolB } = await loadFixture(deployFixture);
            expect(await treasury.poolCount()).to.equal(2);
            const p0 = await treasury.getPool(0);
            expect(p0.account).to.equal(await poolA.getAddress());
            expect(p0.threshold).to.equal(F(100_000));
            expect(p0.maxThreshold).to.equal(F(100_000));
            expect(p0.enabled).to.equal(true);
            expect(p0.lastRefill).to.equal(0);
            expect(await treasury.poolIdOf(await poolB.getAddress())).to.equal(1);
            expect(await treasury.isPool(await poolB.getAddress())).to.equal(true);
            expect(await treasury.isPool(await treasury.getAddress())).to.equal(false);
            expect(await treasury.targetOf(0)).to.equal(F(110_000));
            expect(await treasury.targetOf(1)).to.equal(F(55_000));
            expect(await treasury.cooldown()).to.equal(ONE_DAY);
            expect(await treasury.owner()).to.equal((await ethers.getSigners())[1].address);
        });

        it("rejects: no pools, zero token, EOA token, zero admin", async function () {
            const { Treasury, tokenAddr, admin, pools, deployer } = await loadFixture(deployFixture);
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [])).to.be.revertedWithCustomError(Treasury, "NoPools");
            await expect(Treasury.deploy(ethers.ZeroAddress, admin.address, 3600, pools)).to.be.revertedWithCustomError(Treasury, "ZeroAddress");
            await expect(Treasury.deploy(deployer.address, admin.address, 3600, pools)).to.be.revertedWithCustomError(Treasury, "NotAContract");
            await expect(Treasury.deploy(tokenAddr, ethers.ZeroAddress, 0, pools)).to.be.revertedWithCustomError(Treasury, "OwnableInvalidOwner");
        });

        it("rejects a pool that is an EOA, the token, a duplicate, or has a bad threshold", async function () {
            const { Treasury, tokenAddr, admin, pools, stranger } = await loadFixture(deployFixture);
            const good = pools[0];
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...good, account: stranger.address }])).to.be.revertedWithCustomError(Treasury, "NotAContract");
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...good, account: tokenAddr }])).to.be.revertedWithCustomError(Treasury, "InvalidPoolAccount");
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [good, good])).to.be.revertedWithCustomError(Treasury, "DuplicatePool");
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...good, threshold: 0n }])).to.be.revertedWithCustomError(Treasury, "InvalidThreshold");
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...good, threshold: F(100_001) }])).to.be.revertedWithCustomError(Treasury, "InvalidThreshold");
            const tooBig = (1n << 128n);
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...good, threshold: tooBig, maxThreshold: tooBig }])).to.be.revertedWithCustomError(Treasury, "InvalidThreshold").withArgs(tooBig, tooBig - 1n);
            expect(await Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...good, threshold: tooBig - 1n, maxThreshold: tooBig - 1n }])).to.not.equal(undefined);
        });

        it("rejects a pool whose token getter is missing or points at another token (cross-chain paste guard)", async function () {
            const { Treasury, tokenAddr, admin } = await loadFixture(deployFixture);
            const NoGetter = await ethers.getContractFactory("MockRefillPoolNoGetter");
            const noGetter = await NoGetter.deploy();
            const Other = await ethers.getContractFactory("MockERC20");
            const other = await Other.deploy(F(1));
            const PoolA = await ethers.getContractFactory("MockRefillPool");
            const wrongToken = await PoolA.deploy(await other.getAddress());
            const base = { threshold: F(1000), maxThreshold: F(1000) };
            const EmptyFb = await ethers.getContractFactory("MockRefillPoolEmptyFallback");
            const emptyFb = await EmptyFb.deploy();
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...base, account: await emptyFb.getAddress() }])).to.be.revertedWithCustomError(Treasury, "PoolTokenMismatch");
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...base, account: await noGetter.getAddress() }])).to.be.revertedWithCustomError(Treasury, "PoolTokenMismatch");
            await expect(Treasury.deploy(tokenAddr, admin.address, 3600, [{ ...base, account: await wrongToken.getAddress() }])).to.be.revertedWithCustomError(Treasury, "PoolTokenMismatch");
        });
    });

    // ------------------------------------------------------------------ refill amounts
    describe("refill", function () {
        it("does nothing (reverts) when the pool is at or above threshold", async function () {
            const { treasury, token, poolA, caller } = await loadFixture(deployFixture);
            await token.transfer(await poolA.getAddress(), F(100_000));
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "NotBelowThreshold").withArgs(0, F(100_000), F(100_000));
            expect(await treasury.previewRefill(0)).to.equal(0);
        });

        it("brings an empty pool up by exactly threshold (maxPerRefill == threshold)", async function () {
            const { treasury, token, poolA, caller, treasuryAddr } = await loadFixture(deployFixture);
            const poolAddr = await poolA.getAddress();
            expect(await treasury.previewRefill(0)).to.equal(F(100_000));
            await expect(treasury.connect(caller).refill(0))
                .to.emit(treasury, "Refilled").withArgs(0, poolAddr, caller.address, F(100_000), 0, false);
            expect(await token.balanceOf(poolAddr)).to.equal(F(100_000));
            expect(await token.balanceOf(treasuryAddr)).to.equal(F(900_000));
            expect((await treasury.getPool(0)).lastRefill).to.equal(await time.latest());
        });

        it("tops up to 110% of threshold when the pool is only partly drained", async function () {
            const { treasury, token, poolA, caller } = await loadFixture(deployFixture);
            const poolAddr = await poolA.getAddress();
            await token.transfer(poolAddr, F(60_000));
            expect(await treasury.previewRefill(0)).to.equal(F(50_000));
            await treasury.connect(caller).refill(0);
            expect(await token.balanceOf(poolAddr)).to.equal(F(110_000));

            // one wei below threshold -> sent just enough for target
            await poolA.drain(caller.address, F(10_000) + 1n); // balance = 100_000 - 1 wei
            await time.increase(ONE_DAY + 1);
            await treasury.connect(caller).refill(0);
            expect(await token.balanceOf(poolAddr)).to.equal(F(110_000));
        });

        it("sends whatever the treasury has when it cannot reach target, without reverting; the truncated refill still consumes the cooldown", async function () {
            const { treasury, token, poolA, caller, admin, treasuryAddr } = await loadFixture(deployFixture);
            const poolAddr = await poolA.getAddress();
            await treasury.connect(admin).returnToToken(F(1_000_000) - F(30_000)); // leave 30K
            await expect(treasury.connect(caller).refill(0))
                .to.emit(treasury, "Refilled").withArgs(0, poolAddr, caller.address, F(30_000), 0, true);
            expect(await token.balanceOf(poolAddr)).to.equal(F(30_000));
            expect(await token.balanceOf(treasuryAddr)).to.equal(0);
            expect((await treasury.getPool(0)).lastRefill).to.equal(await time.latest());

            // Refunding does NOT reopen the pool inside the cooldown: this is what stops a pool whose
            // threshold exceeds the reserve from siphoning every deposit (independent audit A-M1 / F-S4).
            await token.transfer(treasuryAddr, F(500_000));
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(F(50_000)); // only pool B; A is cooling down
            await time.increase(ONE_DAY + 1);
            await treasury.connect(caller).refill(0);
            expect(await token.balanceOf(poolAddr)).to.equal(F(110_000));
        });

        it("an empty treasury: strict refill reverts TreasuryEmpty, batch is a no-op, no cooldown consumed", async function () {
            const { treasury, caller, admin } = await loadFixture(deployFixture);
            await treasury.connect(admin).returnToToken(F(1_000_000));
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "TreasuryEmpty");
            await expect(treasury.connect(caller).refillAll()).to.not.be.reverted;
            expect((await treasury.getPool(0)).lastRefill).to.equal(0);
        });

        it("enforces the per-pool cooldown after a full refill and allows it again after", async function () {
            const { treasury, poolA, caller } = await loadFixture(deployFixture);
            await treasury.connect(caller).refill(0);
            const at = (await time.latest()) + ONE_DAY;
            await poolA.drain(caller.address, F(100_000)); // empty it again
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive").withArgs(0, at);
            expect(await treasury.previewRefill(0)).to.equal(0);
            await time.increaseTo(at);
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
        });

        it("cooldown must be within [1 hour, 30 days]: zero (no brake) and absolute timestamps are rejected", async function () {
            const { Treasury, tokenAddr, admin, pools } = await loadFixture(deployFixture);
            const MIN = 3600, MAX = 30 * ONE_DAY;
            await expect(Treasury.deploy(tokenAddr, admin.address, 0, pools)).to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange").withArgs(0, MIN, MAX);
            await expect(Treasury.deploy(tokenAddr, admin.address, MIN - 1, pools)).to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange");
            await expect(Treasury.deploy(tokenAddr, admin.address, MAX + 1, pools)).to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange");
            await expect(Treasury.deploy(tokenAddr, admin.address, await time.latest(), pools)).to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange");
            expect(await (await Treasury.deploy(tokenAddr, admin.address, MIN, pools)).cooldown()).to.equal(MIN);
            expect(await (await Treasury.deploy(tokenAddr, admin.address, MAX, pools)).cooldown()).to.equal(MAX);
        });

        it("a pause expires after 30 days so a lost owner key cannot brick refills; the guardian can re-pause", async function () {
            const { treasury, caller, admin } = await loadFixture(deployFixture);
            await expect(treasury.connect(admin).pause()).to.emit(treasury, "Paused").withArgs(admin.address, (await time.latest()) + 1 + 30 * ONE_DAY);
            await expect(treasury.connect(admin).pause()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            await time.increase(30 * ONE_DAY + 1);
            expect(await treasury.paused()).to.equal(false);
            await expect(treasury.connect(admin).unpause()).to.be.revertedWithCustomError(treasury, "ExpectedPause");
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
            await expect(treasury.connect(admin).pause()).to.emit(treasury, "Paused");
            expect(await treasury.paused()).to.equal(true);
        });

        it("rejects unknown and disabled pools", async function () {
            const { treasury, caller, admin } = await loadFixture(deployFixture);
            await expect(treasury.connect(caller).refill(7)).to.be.revertedWithCustomError(treasury, "UnknownPool").withArgs(7);
            await expect(treasury.getPool(7)).to.be.revertedWithCustomError(treasury, "UnknownPool");
            await expect(treasury.targetOf(7)).to.be.revertedWithCustomError(treasury, "UnknownPool");
            await expect(treasury.poolIdOf(caller.address)).to.be.revertedWithCustomError(treasury, "UnknownPool");
            expect(await treasury.previewRefill(7)).to.equal(0);
            await treasury.connect(admin).setPoolEnabled(0, false);
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "PoolDisabled").withArgs(0);
            expect(await treasury.previewRefill(0)).to.equal(0);
        });

        it("is callable by any address", async function () {
            const { treasury, stranger } = await loadFixture(deployFixture);
            await expect(treasury.connect(stranger).refill(0)).to.not.be.reverted;
        });
    });

    // ------------------------------------------------------------------ refillAll
    describe("refillAll", function () {
        it("refills every eligible pool, skips the rest, returns the total", async function () {
            const { treasury, token, poolA, poolB, caller, admin } = await loadFixture(deployFixture);
            await token.transfer(await poolB.getAddress(), F(40_000)); // below 50K -> +15K to 55K
            const total = await treasury.connect(caller).refillAll.staticCall();
            expect(total).to.equal(F(100_000) + F(15_000));
            await treasury.connect(caller).refillAll();
            expect(await token.balanceOf(await poolA.getAddress())).to.equal(F(100_000));
            expect(await token.balanceOf(await poolB.getAddress())).to.equal(F(55_000));

            // second call: both above threshold / in cooldown -> no-op, no revert
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(0);
            await expect(treasury.connect(caller).refillAll()).to.not.be.reverted;

            // disabled pool skipped even when empty
            await poolA.drain(caller.address, F(100_000));
            await time.increase(ONE_DAY + 1);
            await treasury.connect(admin).setPoolEnabled(0, false);
            expect(await treasury.connect(caller).refillAll.staticCall()).to.equal(0);
        });

        it("splits a short treasury across pools in id order", async function () {
            const { treasury, token, poolA, poolB, caller, admin } = await loadFixture(deployFixture);
            await treasury.connect(admin).returnToToken(F(1_000_000) - F(120_000)); // 120K left
            await treasury.connect(caller).refillAll();
            expect(await token.balanceOf(await poolA.getAddress())).to.equal(F(100_000)); // full
            expect(await token.balanceOf(await poolB.getAddress())).to.equal(F(20_000));  // truncated
            expect((await treasury.getPool(0)).lastRefill).to.equal(await time.latest());
            expect((await treasury.getPool(1)).lastRefill).to.equal(await time.latest()); // truncated, still consumed
        });
    });

    // ------------------------------------------------------------------ guardian
    describe("guardian (owner)", function () {
        it("pause blocks refills but not returnToToken; unpause restores", async function () {
            const { treasury, caller, admin } = await loadFixture(deployFixture);
            await treasury.connect(admin).pause();
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            await expect(treasury.connect(caller).refillAll()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
            expect(await treasury.previewRefill(0)).to.equal(0);
            await expect(treasury.connect(admin).returnToToken(F(1))).to.not.be.reverted;
            await treasury.connect(admin).unpause();
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
        });

        it("setThreshold stays within the per-pool cap and moves the target", async function () {
            const { treasury, admin } = await loadFixture(deployFixture);
            await expect(treasury.connect(admin).setThreshold(1, F(100_000))).to.emit(treasury, "ThresholdUpdated").withArgs(1, F(50_000), F(100_000));
            expect(await treasury.targetOf(1)).to.equal(F(110_000));
            expect(await treasury.previewRefill(1)).to.equal(F(100_000));
            await treasury.connect(admin).setThreshold(1, F(1));
            await expect(treasury.connect(admin).setThreshold(1, F(100_000) + 1n)).to.be.revertedWithCustomError(treasury, "InvalidThreshold");
            await expect(treasury.connect(admin).setThreshold(1, 0)).to.be.revertedWithCustomError(treasury, "InvalidThreshold");
            await expect(treasury.connect(admin).setThreshold(9, F(1))).to.be.revertedWithCustomError(treasury, "UnknownPool");
            await expect(treasury.connect(admin).setPoolEnabled(9, true)).to.be.revertedWithCustomError(treasury, "UnknownPool");
        });

        it("returnToToken sends only to the token contract and validates amount", async function () {
            const { treasury, token, tokenAddr, admin, treasuryAddr } = await loadFixture(deployFixture);
            const before = await token.balanceOf(tokenAddr);
            await expect(treasury.connect(admin).returnToToken(F(250_000))).to.emit(treasury, "ReturnedToToken").withArgs(admin.address, F(250_000));
            expect(await token.balanceOf(tokenAddr)).to.equal(before + F(250_000));
            expect(await token.balanceOf(treasuryAddr)).to.equal(F(750_000));
            await expect(treasury.connect(admin).returnToToken(0)).to.be.revertedWithCustomError(treasury, "ZeroAmount");
            await expect(treasury.connect(admin).returnToToken(F(750_001))).to.be.revertedWithCustomError(treasury, "InsufficientTreasuryBalance").withArgs(F(750_001), F(750_000));
        });

        it("non-owners cannot use any guardian function", async function () {
            const { treasury, stranger } = await loadFixture(deployFixture);
            const calls = [
                () => treasury.connect(stranger).pause(),
                () => treasury.connect(stranger).unpause(),
                () => treasury.connect(stranger).setThreshold(0, F(1)),
                () => treasury.connect(stranger).setPoolEnabled(0, false),
                () => treasury.connect(stranger).returnToToken(F(1)),
            ];
            for (const call of calls) {
                await expect(call()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount").withArgs(stranger.address);
            }
        });

        it("has no function that can move FULA to an arbitrary address", async function () {
            const { treasury } = await loadFixture(deployFixture);
            const movers = treasury.interface.fragments
                .filter((f: any) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
                .map((f: any) => f.name)
                .sort();
            expect(movers).to.deep.equal([
                "acceptOwnership", "pause", "refill", "refillAll", "renounceOwnership",
                "returnToToken", "setPoolEnabled", "setThreshold", "transferOwnership", "unpause",
            ]);
            // none of the state-changing functions takes an address except ownership transfer
            for (const f of treasury.interface.fragments.filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)) as any[]) {
                if (f.name === "transferOwnership") continue;
                expect(f.inputs.some((i: any) => i.type === "address"), `${f.name} takes an address`).to.equal(false);
            }
        });

        it("ownership is two-step and can be renounced (not while paused), after which refills still work", async function () {
            const { treasury, admin, stranger, caller } = await loadFixture(deployFixture);
            await treasury.connect(admin).transferOwnership(stranger.address);
            expect(await treasury.owner()).to.equal(admin.address);
            await treasury.connect(stranger).acceptOwnership();
            expect(await treasury.owner()).to.equal(stranger.address);
            await treasury.connect(stranger).pause();
            await expect(treasury.connect(stranger).renounceOwnership()).to.be.revertedWithCustomError(treasury, "CannotRenounceWhilePaused");
            await treasury.connect(stranger).unpause();
            await treasury.connect(stranger).renounceOwnership();
            expect(await treasury.owner()).to.equal(ethers.ZeroAddress);
            await expect(treasury.connect(stranger).pause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
            await expect(treasury.connect(caller).refill(0)).to.not.be.reverted;
        });
    });

    // ------------------------------------------------------------------ token quirks
    describe("token quirks", function () {
        it("a blacklisted pool makes refillAll revert until disabled; other pools still refill singly", async function () {
            const [, admin, caller] = await ethers.getSigners();
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
            await blk.transfer(await treasury.getAddress(), F(1_000_000));
            await blk.setBlocked(await poolA.getAddress(), true);

            await expect(treasury.connect(caller).refillAll()).to.be.revertedWithCustomError(blk, "Blocked");
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(blk, "Blocked");
            await expect(treasury.connect(caller).refill(1)).to.not.be.reverted;
            expect(await blk.balanceOf(await poolB.getAddress())).to.equal(F(100_000));

            await treasury.connect(admin).setPoolEnabled(0, false);
            await expect(treasury.connect(caller).refillAll()).to.not.be.reverted;
        });

        it("a transfer fee makes a refill land short and the cooldown is still consumed", async function () {
            const [, admin, caller] = await ethers.getSigners();
            const Fee = await ethers.getContractFactory("MockFeeOnTransferToken");
            const fee = await Fee.deploy(100); // 1%
            const feeAddr = await fee.getAddress();
            const PoolA = await ethers.getContractFactory("MockRefillPool");
            const pool = await PoolA.deploy(feeAddr);
            const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
            const treasury = await Treasury.deploy(feeAddr, admin.address, ONE_DAY, [
                { account: await pool.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
            ]);
            await fee.mintFree(await treasury.getAddress(), F(1_000_000));

            await expect(treasury.connect(caller).refill(0)).to.emit(treasury, "Refilled").withArgs(0, await pool.getAddress(), caller.address, F(100_000), 0, false);
            expect(await fee.balanceOf(await pool.getAddress())).to.equal(F(99_000)); // still below threshold
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
            await time.increase(ONE_DAY + 1);
            await treasury.connect(caller).refill(0); // sends 11_000, lands 10_890
            expect(await fee.balanceOf(await pool.getAddress())).to.equal(F(109_890));
        });
    });

    // ------------------------------------------------------------------ reentrancy
    describe("reentrancy", function () {
        it("a pool that re-enters refill during the token transfer is rejected", async function () {
            const [, admin, caller] = await ethers.getSigners();
            const Hooked = await ethers.getContractFactory("MockReentrantToken");
            const hooked = await Hooked.deploy(F(10_000_000));
            const Pool = await ethers.getContractFactory("MockReentrantPool");
            const pool = await Pool.deploy(await hooked.getAddress());
            const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
            const treasury = await Treasury.deploy(await hooked.getAddress(), admin.address, 3600, [
                { account: await pool.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
            ]);
            await hooked.transfer(await treasury.getAddress(), F(1_000_000));
            await pool.arm(await treasury.getAddress(), 0);

            await treasury.connect(caller).refill(0);
            expect(await pool.attempted()).to.equal(true);
            expect(await pool.reentered()).to.equal(false);
            expect(await hooked.balanceOf(await pool.getAddress())).to.equal(F(100_000));
            expect(await hooked.balanceOf(await treasury.getAddress())).to.equal(F(900_000));
        });
    });

    // ------------------------------------------------------------------ real FULA + StakingPool
    describe("integration with StorageToken and StakingPool", function () {
        it("is funded via whitelist + transferFromContract, refills a drained StakingPool, and returns to the token", async function () {
            this.timeout(120_000);
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
            const treasury = await Treasury.deploy(tokenAddr, admin.address, ONE_DAY, [
                { account: poolAddr, threshold: F(100_000), maxThreshold: F(100_000) },
            ]);
            const treasuryAddr = await treasury.getAddress();

            // The treasury is NOT whitelisted yet: the token refuses to pay it.
            await expect(token.connect(owner).transferFromContract(treasuryAddr, F(1))).to.be.revertedWithCustomError(token, "NotWhitelisted");

            // Whitelist proposal (type 5), second-admin approval, 1-day lock.
            const tx = await token.connect(owner).createProposal(5, 0, treasuryAddr, ethers.ZeroHash, 0, ethers.ZeroAddress);
            const receipt = await tx.wait();
            const proposalId = receipt!.logs[0].topics[1];
            await time.increase(ONE_DAY + 1);
            await token.connect(admin).approveProposal(proposalId);
            await time.increase(ONE_DAY + 1);

            await token.connect(owner).transferFromContract(treasuryAddr, F(1_000_000));
            expect(await treasury.treasuryBalance()).to.equal(F(1_000_000));

            // Pool is empty -> anyone refills it by 100K (threshold).
            await treasury.connect(caller).refill(0);
            expect(await token.balanceOf(poolAddr)).to.equal(F(100_000));
            expect(await pool.getBalance()).to.equal(F(100_000));

            // The engine pays out rewards (pool -> engine), pool drops below threshold.
            await pool.connect(engine).transferTokens(F(70_000));
            expect(await token.balanceOf(poolAddr)).to.equal(F(30_000));
            await expect(treasury.connect(caller).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
            await time.increase(ONE_DAY + 1);
            expect(await treasury.previewRefill(0)).to.equal(F(80_000));
            await treasury.connect(caller).refill(0);
            expect(await token.balanceOf(poolAddr)).to.equal(F(110_000));
            expect(await treasury.treasuryBalance()).to.equal(F(820_000));

            // Guardian returns the remainder to the token contract, which can re-issue it.
            const tokenSelfBefore = await token.balanceOf(tokenAddr);
            await treasury.connect(admin).returnToToken(F(820_000));
            expect(await token.balanceOf(tokenAddr)).to.equal(tokenSelfBefore + F(820_000));
            expect(await treasury.treasuryBalance()).to.equal(0);
        });
    });
});
