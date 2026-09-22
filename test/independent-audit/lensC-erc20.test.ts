/**
 * Independent pre-deployment audit of FulaRefillTreasury — Lens C: ERC20 integration & external calls.
 *
 * Every test here is a proof for a finding or a "checked and holds" claim in the audit report.
 * Nothing in this file modifies repo state; it is a standalone Hardhat/ethers v6/chai suite.
 *
 * The real StorageToken (UUPS proxy) is used wherever the semantics under test are the token's
 * own (zero-amount revert, blacklist, pause, platform fee). Purpose-built mocks from
 * contracts/test/MockRefillPool.sol are used for the reentrancy hook, and raw runtime bytecode
 * (hardhat_setCode) for the constructor probe edge cases that no mock in the repo covers.
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, ZeroAddress, ZeroHash } from "ethers";

const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const DAY = 24 * 60 * 60;

const SUPPLY = ethers.parseEther("10000000"); // 10M minted to the token contract
const RESERVE = ethers.parseEther("1000000"); // 1M moved to the refill treasury
const THRESHOLD = ethers.parseEther("10000"); // per-pool threshold
const MAX_THRESHOLD = ethers.parseEther("50000");
const COOLDOWN = DAY;

// Proposal type ids from contracts/governance/libraries/ProposalTypes.sol
const P_ADD_WHITELIST = 5;
const P_ADD_BLACKLIST = 9;

describe("Independent audit / Lens C — FulaRefillTreasury ERC20 integration", function () {
  this.timeout(120_000);

  let owner: HardhatEthersSigner; // token ADMIN #1 + treasury owner
  let admin: HardhatEthersSigner; // token ADMIN #2
  let keeper: HardhatEthersSigner; // arbitrary permissionless caller
  let other: HardhatEthersSigner; // arbitrary third party

  let token: Contract;
  let poolA: Contract; // MockRefillPool (token())
  let poolB: Contract; // MockRefillPool (token())
  let poolC: Contract; // MockRefillPoolStorageToken (storageToken())
  let treasury: Contract;

  // ------------------------------------------------------------------ helpers

  /** Two-admin StorageToken proposal: create (auto-approve #1), wait, approve #2 (executes). */
  async function runTokenProposal(proposalType: number, target: string, amount: bigint | number = 0) {
    const tx = await token
      .connect(owner)
      .createProposal(proposalType, 0, target, ZeroHash, amount, ZeroAddress);
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];
    await time.increase(DAY + 1);
    await token.connect(admin).approveProposal(proposalId);
    await time.increase(DAY + 1);
  }

  /**
   * Force StorageToken's platform fee on by writing its private storage slot. The token's
   * `ChangeTreasuryFee` proposal does not store `proposal.amount` (StorageToken.sol L248-262), so
   * governance can only ever set 0 today; a token upgrade could make it live. The probe transfer
   * proves the slot is right rather than assuming it.
   */
  async function setPlatformFee(bps: number) {
    const PLATFORM_FEE_SLOT = 14;
    await ethers.provider.send("hardhat_setStorageAt", [
      await token.getAddress(),
      ethers.toBeHex(PLATFORM_FEE_SLOT, 32),
      ethers.toBeHex(bps, 32),
    ]);
    const probe = ethers.parseEther("1000");
    const before = await token.balanceOf(other.address);
    await token.connect(owner).transfer(other.address, probe);
    const received = (await token.balanceOf(other.address)) - before;
    expect(received, "platform fee slot did not take effect").to.equal((probe * BigInt(10000 - bps)) / 10000n);
  }

  /** Put runtime bytecode that returns `returnHex` for ANY calldata at a fresh address. */
  async function deployRawReturner(returnHex: string): Promise<string> {
    // Runtime: PUSH32 <word> PUSH1 0 MSTORE PUSH1 <retLen> PUSH1 0 RETURN
    const word = returnHex.slice(2).padStart(64, "0").slice(0, 64);
    const retLen = returnHex.slice(2).length / 2 >= 64 ? "40" : "20"; // 64 or 32 bytes
    const runtime = "0x7f" + word + "600052" + "60" + retLen + "6000" + "f3";
    const addr = ethers.getAddress("0x" + ethers.keccak256(ethers.toUtf8Bytes(returnHex + Math.random())).slice(26));
    await ethers.provider.send("hardhat_setCode", [addr, runtime]);
    return addr;
  }

  async function deployTreasury(pools: { account: string; threshold: bigint; maxThreshold: bigint }[], cooldown = COOLDOWN) {
    const F = await ethers.getContractFactory("FulaRefillTreasury");
    const t = await F.deploy(await token.getAddress(), owner.address, cooldown, pools);
    await t.waitForDeployment();
    return t;
  }

  function poolInit(account: string) {
    return { account, threshold: THRESHOLD, maxThreshold: MAX_THRESHOLD };
  }

  // ------------------------------------------------------------------ fixture

  beforeEach(async function () {
    [owner, admin, keeper, other] = await ethers.getSigners();

    const StorageToken = await ethers.getContractFactory("StorageToken");
    token = (await upgrades.deployProxy(StorageToken, [owner.address, admin.address, SUPPLY], {
      kind: "uups",
      initializer: "initialize",
    })) as Contract;
    await token.waitForDeployment();
    await time.increase(DAY + 1);
    await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await time.increase(DAY + 1);
    await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, SUPPLY);

    const MockPool = await ethers.getContractFactory("MockRefillPool");
    const MockPoolST = await ethers.getContractFactory("MockRefillPoolStorageToken");
    poolA = await MockPool.deploy(await token.getAddress());
    poolB = await MockPool.deploy(await token.getAddress());
    poolC = await MockPoolST.deploy(await token.getAddress());

    treasury = await deployTreasury([
      poolInit(await poolA.getAddress()),
      poolInit(await poolB.getAddress()),
      poolInit(await poolC.getAddress()),
    ]);

    // Whitelist the treasury and owner so the token contract can fund them (24h lock each).
    for (const a of [await treasury.getAddress(), owner.address]) {
      await runTokenProposal(P_ADD_WHITELIST, a);
      await time.increase(DAY + 1);
    }
    await token.connect(owner).transferFromContract(await treasury.getAddress(), RESERVE);
    await token.connect(owner).transferFromContract(owner.address, ethers.parseEther("100000"));
  });

  // =========================================================== checked & holds

  describe("Checked and holds — real StorageToken", function () {
    it("refill sends exactly min(1.1T - balance, T, available); nothing reaches any third address", async function () {
      const poolAddr = await poolA.getAddress();
      const tAddr = await treasury.getAddress();
      const sink = await token.treasury();
      const sinkBefore = await token.balanceOf(sink);
      const tokenBefore = await token.balanceOf(await token.getAddress());

      expect(await token.balanceOf(poolAddr)).to.equal(0n);
      await expect(treasury.connect(keeper).refill(0))
        .to.emit(treasury, "Refilled")
        .withArgs(0, poolAddr, keeper.address, THRESHOLD, 0n, false);

      expect(await token.balanceOf(poolAddr)).to.equal(THRESHOLD); // capped at threshold
      expect(await token.balanceOf(tAddr)).to.equal(RESERVE - THRESHOLD);
      expect(await token.balanceOf(sink)).to.equal(sinkBefore);
      expect(await token.balanceOf(await token.getAddress())).to.equal(tokenBefore);
      expect(await token.balanceOf(keeper.address)).to.equal(0n);

      // Now at threshold -> not eligible; strict path reverts, batch path is a no-op.
      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(treasury, "NotBelowThreshold");

      // Drain a little: next refill tops up to 1.1T exactly, not T.
      await poolA.drain(other.address, ethers.parseEther("1"));
      await time.increase(COOLDOWN + 1);
      await treasury.connect(keeper).refill(0);
      expect(await token.balanceOf(poolAddr)).to.equal((THRESHOLD * 11000n) / 10000n);
    });

    it("zero-amount path: an empty treasury never reaches the token's AmountMustBePositive revert", async function () {
      await treasury.connect(owner).returnToToken(RESERVE);
      expect(await treasury.treasuryBalance()).to.equal(0n);

      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(treasury, "TreasuryEmpty");
      expect(await treasury.connect(keeper).refillAll.staticCall()).to.equal(0n);
      await expect(treasury.connect(keeper).refillAll()).to.not.be.reverted;
      await expect(treasury.connect(owner).returnToToken(0)).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("returnToToken goes only to address(token); ADMIN of the token then controls it, not the treasury owner", async function () {
      const tokenAddr = await token.getAddress();
      const before = await token.balanceOf(tokenAddr);
      await treasury.connect(owner).returnToToken(RESERVE);
      expect(await token.balanceOf(tokenAddr)).to.equal(before + RESERVE);
      expect(await token.balanceOf(owner.address)).to.equal(ethers.parseEther("100000")); // owner got nothing
    });

    it("token paused: every outflow reverts inside the token, state is untouched, resumes after unpause", async function () {
      await token.connect(owner).emergencyAction(1); // pause
      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(treasury.connect(keeper).refillAll()).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(treasury.connect(owner).returnToToken(1n)).to.be.revertedWithCustomError(token, "EnforcedPause");
      expect((await treasury.getPool(0)).lastRefill).to.equal(0n); // effects rolled back with the revert

      await time.increase(31 * 60); // EMERGENCY_COOLDOWN
      await token.connect(owner).emergencyAction(2); // unpause
      await expect(treasury.connect(keeper).refill(0)).to.emit(treasury, "Refilled");
    });

    it("donations: to a pool only makes it ineligible; to the treasury changes nothing but `available`", async function () {
      const poolAddr = await poolA.getAddress();
      await token.connect(owner).transfer(poolAddr, THRESHOLD); // front-runner 'donates'
      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(treasury, "NotBelowThreshold");
      expect(await treasury.previewRefill(0)).to.equal(0n);

      await token.connect(owner).transfer(await treasury.getAddress(), ethers.parseEther("5"));
      expect(await treasury.previewRefill(1)).to.equal(THRESHOLD);
      await expect(treasury.connect(keeper).refill(1)).to.emit(treasury, "Refilled");
    });

    it("every non-zero refill burns the cooldown, truncated or not", async function () {
      const short = ethers.parseEther("100");
      await treasury.connect(owner).returnToToken(RESERVE - short);
      await expect(treasury.connect(keeper).refill(0))
        .to.emit(treasury, "Refilled")
        .withArgs(0, await poolA.getAddress(), keeper.address, short, 0n, true);
      const truncatedAt = BigInt(await time.latest());
      expect((await treasury.getPool(0)).lastRefill).to.equal(truncatedAt); // truncated refill sets the gate

      // Refunded treasury -> the pool (still far below threshold) must WAIT: a later deposit
      // cannot be siphoned through a pool whose threshold exceeded the reserve with no time gate.
      await token.connect(owner).transfer(await treasury.getAddress(), ethers.parseEther("50000"));
      expect(await treasury.previewRefill(0)).to.equal(0n);
      await expect(treasury.connect(keeper).refill(0))
        .to.be.revertedWithCustomError(treasury, "CooldownActive")
        .withArgs(0, truncatedAt + BigInt(COOLDOWN));

      // Once the cooldown passes, the full refill lands and consumes the cooldown again.
      await time.increase(COOLDOWN + 1);
      await expect(treasury.connect(keeper).refill(0))
        .to.emit(treasury, "Refilled")
        .withArgs(0, await poolA.getAddress(), keeper.address, THRESHOLD, short, false);
      const fullAt = BigInt(await time.latest());
      expect((await treasury.getPool(0)).lastRefill).to.equal(fullAt);
      await poolA.drain(other.address, THRESHOLD);
      await expect(treasury.connect(keeper).refill(0))
        .to.be.revertedWithCustomError(treasury, "CooldownActive")
        .withArgs(0, fullAt + BigInt(COOLDOWN));
    });
  });

  // ================================================================ findings

  describe("L-1 platform fee: FULA leaks to token.treasury(), a non-pool non-token address", function () {
    it("with platformFeeBps=500 each refill sends 5% to the fee sink and lands the pool below threshold with cooldown burned", async function () {
      await setPlatformFee(500);
      const poolAddr = await poolA.getAddress();
      const sink = await token.treasury();
      expect(await treasury.isPool(sink)).to.equal(false);
      expect(sink).to.not.equal(await token.getAddress());

      const sinkBefore = await token.balanceOf(sink);
      await treasury.connect(keeper).refill(0);

      const fee = (THRESHOLD * 500n) / 10000n;
      expect(await token.balanceOf(sink)).to.equal(sinkBefore + fee); // <- third destination
      expect(await token.balanceOf(poolAddr)).to.equal(THRESHOLD - fee); // still < threshold
      expect(await token.balanceOf(await treasury.getAddress())).to.equal(RESERVE - THRESHOLD);
      // The pool is still below threshold but the cooldown was consumed.
      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
    });

    it("returnToToken leaks the same 5% to the fee sink", async function () {
      await setPlatformFee(500);
      const sink = await token.treasury();
      const sinkBefore = await token.balanceOf(sink);
      await treasury.connect(owner).returnToToken(RESERVE);
      expect(await token.balanceOf(sink)).to.equal(sinkBefore + (RESERVE * 500n) / 10000n);
    });
  });

  describe("L-2 blacklist: token governance can freeze the treasury or brick refillAll", function () {
    it("blacklisting the treasury freezes refill, refillAll and returnToToken", async function () {
      await runTokenProposal(P_ADD_BLACKLIST, await treasury.getAddress());
      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(token, "BlacklistedAddress");
      await expect(treasury.connect(keeper).refillAll()).to.be.revertedWithCustomError(token, "BlacklistedAddress");
      await expect(treasury.connect(owner).returnToToken(1n)).to.be.revertedWithCustomError(token, "BlacklistedAddress");
    });

    it("blacklisting one pool reverts the whole refillAll batch until the owner disables that pool", async function () {
      await runTokenProposal(P_ADD_BLACKLIST, await poolA.getAddress());
      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(token, "BlacklistedAddress");
      await expect(treasury.connect(keeper).refillAll()).to.be.revertedWithCustomError(token, "BlacklistedAddress");
      await expect(treasury.connect(keeper).refill(1)).to.emit(treasury, "Refilled"); // per-pool path still works

      await treasury.connect(owner).setPoolEnabled(0, false);
      await expect(treasury.connect(keeper).refillAll()).to.emit(treasury, "Refilled");
      // If the owner had renounced, refillAll would stay bricked; only refill(id) would remain.
    });
  });

  describe("L-3 pool trust is fixed at construction; cooldown is the only brake", function () {
    it("a pool whose code is replaced after construction still receives refills (no re-probe)", async function () {
      const poolAddr = await poolA.getAddress();
      // Replace the pool with a contract that has no token() getter at all.
      await ethers.provider.send("hardhat_setCode", [poolAddr, "0x00"]);
      await expect(treasury.connect(keeper).refill(0)).to.emit(treasury, "Refilled");
      expect(await token.balanceOf(poolAddr)).to.equal(THRESHOLD);
    });

    it("cooldown=0 (no brake) is rejected at construction, as is anything outside [MIN_COOLDOWN, MAX_COOLDOWN]", async function () {
      const F = await ethers.getContractFactory("FulaRefillTreasury");
      const tokenAddr = await token.getAddress();
      const pools = [poolInit(await poolA.getAddress())];
      const min = await treasury.MIN_COOLDOWN();
      const max = await treasury.MAX_COOLDOWN();
      expect(min).to.equal(3600n);
      expect(max).to.equal(BigInt(30 * DAY));

      await expect(F.deploy(tokenAddr, owner.address, 0, pools))
        .to.be.revertedWithCustomError(F, "CooldownOutOfRange")
        .withArgs(0, min, max);
      await expect(F.deploy(tokenAddr, owner.address, min - 1n, pools))
        .to.be.revertedWithCustomError(F, "CooldownOutOfRange")
        .withArgs(min - 1n, min, max);
      await expect(F.deploy(tokenAddr, owner.address, max + 1n, pools))
        .to.be.revertedWithCustomError(F, "CooldownOutOfRange")
        .withArgs(max + 1n, min, max);

      // Both edges are inclusive.
      expect(await (await F.deploy(tokenAddr, owner.address, min, pools)).cooldown()).to.equal(min);
      expect(await (await F.deploy(tokenAddr, owner.address, max, pools)).cooldown()).to.equal(max);
    });

    it("cooldown=MIN_COOLDOWN: a pool that can move its own balance drains the treasury only at threshold per cooldown", async function () {
      const minCooldown = Number(await treasury.MIN_COOLDOWN());
      const t0 = await deployTreasury([poolInit(await poolA.getAddress())], minCooldown);
      await runTokenProposal(P_ADD_WHITELIST, await t0.getAddress());
      const reserve = THRESHOLD * 5n;
      await token.connect(owner).transferFromContract(await t0.getAddress(), reserve);

      for (let i = 0; i < 5; i++) {
        await t0.connect(keeper).refill(0);
        const refilledAt = BigInt(await time.latest());
        await poolA.drain(other.address, await token.balanceOf(await poolA.getAddress()));
        expect(await token.balanceOf(other.address)).to.equal(THRESHOLD * BigInt(i + 1));
        // Back-to-back is refused: the next threshold is only reachable after the cooldown.
        await expect(t0.connect(keeper).refill(0))
          .to.be.revertedWithCustomError(t0, "CooldownActive")
          .withArgs(0, refilledAt + BigInt(minCooldown));
        await time.increase(minCooldown + 1);
      }
      expect(await token.balanceOf(await t0.getAddress())).to.equal(0n);
      expect(await token.balanceOf(other.address)).to.equal(reserve);
    });

    it("cooldown>0: the same loop is capped at threshold per cooldown", async function () {
      await treasury.connect(keeper).refill(0);
      await poolA.drain(other.address, THRESHOLD);
      await expect(treasury.connect(keeper).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
      expect(await token.balanceOf(other.address)).to.equal(THRESHOLD);
    });
  });

  // ============================================================= probe & hooks

  describe("Constructor probe `_getterReturns` edge cases", function () {
    it("EOA -> NotAContract; empty fallback / no getter -> PoolTokenMismatch", async function () {
      const F = await ethers.getContractFactory("FulaRefillTreasury");
      const tokenAddr = await token.getAddress();
      await expect(F.deploy(tokenAddr, owner.address, COOLDOWN, [poolInit(other.address)]))
        .to.be.revertedWithCustomError(F, "NotAContract");

      const empty = await (await ethers.getContractFactory("MockRefillPoolEmptyFallback")).deploy();
      await expect(F.deploy(tokenAddr, owner.address, COOLDOWN, [poolInit(await empty.getAddress())]))
        .to.be.revertedWithCustomError(F, "PoolTokenMismatch");

      const noGetter = await (await ethers.getContractFactory("MockRefillPoolNoGetter")).deploy();
      await expect(F.deploy(tokenAddr, owner.address, COOLDOWN, [poolInit(await noGetter.getAddress())]))
        .to.be.revertedWithCustomError(F, "PoolTokenMismatch");
    });

    it("wrong-length (64B) return and dirty high bits are rejected; a clean 32B word from ANY selector is accepted", async function () {
      const F = await ethers.getContractFactory("FulaRefillTreasury");
      const tokenAddr = await token.getAddress();
      const clean = ethers.zeroPadValue(tokenAddr, 32);

      const wrongLen = await deployRawReturner(clean + "00".repeat(32));
      await expect(F.deploy(tokenAddr, owner.address, COOLDOWN, [poolInit(wrongLen)]))
        .to.be.revertedWithCustomError(F, "PoolTokenMismatch");

      const dirty = await deployRawReturner("0x" + "01" + clean.slice(4));
      await expect(F.deploy(tokenAddr, owner.address, COOLDOWN, [poolInit(dirty)]))
        .to.be.revertedWithCustomError(F, "PoolTokenMismatch");

      // I-1: the probe is a typo-catcher, not authorization — any echo contract passes.
      const echo = await deployRawReturner(clean);
      const t = await F.deploy(tokenAddr, owner.address, COOLDOWN, [poolInit(echo)]);
      expect(await t.isPool(echo)).to.equal(true);
    });

    it("real UUPS proxies (StakingPool via token(), TestnetMiningRewards via storageToken()) pass and refill cleanly", async function () {
      const tokenAddr = await token.getAddress();
      const sp = (await upgrades.deployProxy(await ethers.getContractFactory("StakingPool"),
        [tokenAddr, owner.address, admin.address], { kind: "uups", initializer: "initialize" })) as Contract;
      const tmr = (await upgrades.deployProxy(await ethers.getContractFactory("TestnetMiningRewards"),
        [tokenAddr, owner.address, admin.address], { kind: "uups", initializer: "initialize" })) as Contract;

      const t = await deployTreasury([poolInit(await sp.getAddress()), poolInit(await tmr.getAddress())]);
      await runTokenProposal(P_ADD_WHITELIST, await t.getAddress());
      await token.connect(owner).transferFromContract(await t.getAddress(), THRESHOLD * 4n);

      expect(await t.connect(keeper).refillAll.staticCall()).to.equal(THRESHOLD * 2n);
      await t.connect(keeper).refillAll();
      expect(await sp.getBalance()).to.equal(THRESHOLD); // StakingPool has no ledger besides balanceOf
      expect(await token.balanceOf(await tmr.getAddress())).to.equal(THRESHOLD);
      expect(await tmr.totalAllocation()).to.equal(0n); // vesting accounting untouched by a refill
    });
  });

  describe("Reentrancy through a token hook (hypothetical hooked token)", function () {
    it("re-entering refill from the recipient hook is blocked and pays out exactly once", async function () {
      const Hooked = await ethers.getContractFactory("MockReentrantToken");
      const hooked = await Hooked.deploy(RESERVE);
      const Pool = await ethers.getContractFactory("MockReentrantPool");
      const pool = await Pool.deploy(await hooked.getAddress());
      // A second, fully eligible pool: at hook time pool #0 already sits at threshold, so the
      // hook targets pool #1 — the ONLY thing that can stop that inner refill is the guard.
      const victim = await (await ethers.getContractFactory("MockRefillPool")).deploy(await hooked.getAddress());

      const F = await ethers.getContractFactory("FulaRefillTreasury");
      const t = await F.deploy(await hooked.getAddress(), owner.address, 3600, [
        poolInit(await pool.getAddress()),
        poolInit(await victim.getAddress()),
      ]);
      await hooked.transfer(await t.getAddress(), RESERVE);
      await pool.arm(await t.getAddress(), 1);
      expect(await t.previewRefill(1)).to.equal(THRESHOLD); // eligible before the outer call

      await t.connect(keeper).refill(0);
      expect(await pool.attempted()).to.equal(true);
      expect(await pool.reentered()).to.equal(false); // ReentrancyGuardReentrantCall inside the hook
      expect(await hooked.balanceOf(await pool.getAddress())).to.equal(THRESHOLD);
      expect(await hooked.balanceOf(await victim.getAddress())).to.equal(0n); // inner refill did not land
      expect(await hooked.balanceOf(await t.getAddress())).to.equal(RESERVE - THRESHOLD);

      // Same call outside the hook succeeds, proving pool #1 was eligible all along.
      await expect(t.connect(keeper).refill(1)).to.emit(t, "Refilled");
    });
  });
});
