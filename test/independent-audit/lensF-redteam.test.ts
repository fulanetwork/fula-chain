// Lens F — independent red-team of FulaRefillTreasury.
//
// Deliverable rule: a "success" is FULA that was held by the treasury ending up at an address that
// is NOT a constructor-registered pool and NOT the token contract. Tests in the "LITERAL SUCCESSES"
// block pass by asserting exactly that. Each is labelled with what it actually proves: none of them
// is a flaw in the treasury's ROUTING (the only sinks are L301 p.account and L218 address(token)) and
// every one needs something outside the treasury to be compromised first (the token's fee sink, a
// pool's own withdraw path, the token's ADMIN_ROLE quorum). S4 was the one finding inside the
// treasury's own cooldown logic (a truncated refill used to leave `lastRefill` untouched, so
// sub-threshold inflows were drainable with no time gate); the post-audit revision fixed it (L42-44,
// L367-369: EVERY non-zero refill consumes the cooldown) and S4 now proves the fix. S3 / C5 likewise
// became regression tests of the new constructor bound `MIN_COOLDOWN <= cooldown <= MAX_COOLDOWN`
// (L85-89, L163). Tests in the "BLOCKED" block assert the attack FAILS, citing the line in
// contracts/core/FulaRefillTreasury.sol that stops it. Line numbers below refer to that file
// (references inside tests rewritten for the revision are current; the others predate it).
//
// Only file created by this audit. Hardhat + ethers v6 + chai matchers. No typechain import for the
// target on purpose (artifact name "FulaRefillTreasury").

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ZeroAddress, ZeroHash, MaxUint256 } from "ethers";
import * as fs from "fs";
import * as path from "path";

const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const DAY = 24 * 60 * 60;
const E = (n: string | number) => ethers.parseEther(String(n));
const MAX_THRESHOLD = (1n << 128n) - 1n;
const MIN_COOLDOWN = 3600n; // FulaRefillTreasury.MIN_COOLDOWN = 1 hours
const MAX_COOLDOWN = 30n * BigInt(DAY); // FulaRefillTreasury.MAX_COOLDOWN = 30 days
const MAX_PAUSE = 30n * BigInt(DAY); // FulaRefillTreasury.MAX_PAUSE = 30 days

type PoolInit = { account: string; threshold: bigint; maxThreshold: bigint };

async function deployTreasury(token: string, owner: string, cooldown: bigint | number, pools: PoolInit[]) {
  const T = await ethers.getContractFactory("FulaRefillTreasury");
  const t = await T.deploy(token, owner, cooldown, pools);
  await t.waitForDeployment();
  return t;
}

async function deployPool(token: string, name = "MockRefillPool") {
  const P = await ethers.getContractFactory(name);
  const p = await P.deploy(token);
  await p.waitForDeployment();
  return p;
}

describe("Lens F red-team: FulaRefillTreasury", function () {
  this.timeout(600_000);

  // ================================================================================================
  // LITERAL SUCCESSES — FULA leaves the treasury and lands somewhere that is not a pool / the token.
  // Each is labelled with the trust boundary it crosses. None is a bug in the treasury's routing.
  // ================================================================================================
  describe("LITERAL SUCCESSES (labelled: not a treasury routing flaw)", function () {
    it("S1 fee-on-transfer token: refill skims to the token's fee sink (token-level, documented L40-44)", async function () {
      // Requires the TOKEN to charge a fee. With the real StorageToken that needs a ChangeTreasuryFee
      // proposal through its own governance (StorageToken.sol L32 MAX_BPS=500, L100-103) and the sink
      // is the token's Treasury contract, not an attacker. The treasury contract itself cannot stop it.
      const [deployer, owner] = await ethers.getSigners();
      const Fee = await ethers.getContractFactory("MockFeeOnTransferToken");
      const fee = await Fee.deploy(500); // 5%, the real token's MAX_BPS
      await fee.waitForDeployment();
      const feeAddr = await fee.getAddress();
      const pool = await deployPool(feeAddr);
      const poolAddr = await pool.getAddress();
      const t = await deployTreasury(feeAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, threshold: E(1000), maxThreshold: E(1000) }]);
      const tAddr = await t.getAddress();
      await fee.mintFree(tAddr, E(1000)); // mint path is fee-free
      const sink = "0x0000000000000000000000000000000000000FEE";
      expect(await fee.balanceOf(sink)).to.equal(0n);

      await t.refill(0);

      // 5% of the 1000 sent landed at a non-pool, non-token address.
      expect(await fee.balanceOf(sink)).to.equal(E(50));
      expect(await fee.balanceOf(poolAddr)).to.equal(E(950));
      expect(await t.isPool(sink)).to.equal(false);
      // The pool landed SHORT of threshold and the cooldown was still consumed (L299), as documented.
      expect((await t.getPool(0)).lastRefill).to.not.equal(0n);
    });

    it("S2 compromised pool: refill -> pool.drain -> attacker EOA (accepted model, L34-38; rate-limited)", async function () {
      // MockRefillPool.drain is permissionless (MockRefillPool.sol L19-21), standing in for a pool whose
      // withdraw path is compromised. The treasury only ever sends to the registered pool (L301).
      const [deployer, owner, attacker] = await ethers.getSigners();
      const Tok = await ethers.getContractFactory("MockERC20");
      const tok = await Tok.deploy(E(1_000_000));
      await tok.waitForDeployment();
      const tokAddr = await tok.getAddress();
      const pool = await deployPool(tokAddr);
      const poolAddr = await pool.getAddress();
      const cooldown = DAY;
      const t = await deployTreasury(tokAddr, owner.address, cooldown, [{ account: poolAddr, threshold: E(1000), maxThreshold: E(1000) }]);
      const tAddr = await t.getAddress();
      await tok.transfer(tAddr, E(10_000));

      await t.connect(attacker).refill(0);
      await pool.connect(attacker).drain(attacker.address, E(1000));
      expect(await tok.balanceOf(attacker.address)).to.equal(E(1000)); // treasury FULA at attacker EOA

      // ...but the brake holds: a second pull in the same cooldown reverts (L285-286).
      await expect(t.connect(attacker).refill(0)).to.be.revertedWithCustomError(t, "CooldownActive");
      expect(await t.refillAll.staticCall()).to.equal(0n);
      await time.increase(cooldown);
      await t.connect(attacker).refill(0);
      await pool.connect(attacker).drain(attacker.address, E(1000));
      expect(await tok.balanceOf(attacker.address)).to.equal(E(2000)); // threshold per cooldown, as designed
      expect(await tok.balanceOf(tAddr)).to.equal(E(8000));
    });

    it("S3 [FIXED] cooldown = 0 is rejected at construction (L85-89, L163): the brake cannot be removed, so a compromised pool cannot empty the treasury without waiting", async function () {
      // Pre-revision, `cooldown != 0 &&` short-circuited the cooldown check and a zero cooldown let a
      // compromised pool loop refill+drain until the treasury was empty. The constructor now bounds
      // the immutable to [MIN_COOLDOWN, MAX_COOLDOWN]; regression test of that bound.
      const [deployer, owner, attacker] = await ethers.getSigners();
      const Tok = await ethers.getContractFactory("MockERC20");
      const tok = await Tok.deploy(E(1_000_000));
      await tok.waitForDeployment();
      const tokAddr = await tok.getAddress();
      const pool = await deployPool(tokAddr);
      const poolAddr = await pool.getAddress();
      const pools = [{ account: poolAddr, threshold: E(1000), maxThreshold: E(1000) }];

      const T = await ethers.getContractFactory("FulaRefillTreasury");
      await expect(T.deploy(tokAddr, owner.address, 0, pools))
        .to.be.revertedWithCustomError(T, "CooldownOutOfRange").withArgs(0n, MIN_COOLDOWN, MAX_COOLDOWN);

      // With the smallest legal cooldown (deploys fine) the same attack loop stops after ONE pull.
      const t = await deployTreasury(tokAddr, owner.address, MIN_COOLDOWN, pools);
      const tAddr = await t.getAddress();
      expect(await t.cooldown()).to.equal(MIN_COOLDOWN);
      expect(await t.MIN_COOLDOWN()).to.equal(MIN_COOLDOWN);
      await tok.transfer(tAddr, E(5000));

      await t.connect(attacker).refill(0);
      await pool.connect(attacker).drain(attacker.address, await tok.balanceOf(poolAddr));
      const availableAt = (await t.getPool(0)).lastRefill + MIN_COOLDOWN;
      for (let i = 0; i < 5; i++) {
        await expect(t.connect(attacker).refill(0)).to.be.revertedWithCustomError(t, "CooldownActive").withArgs(0n, availableAt);
        expect(await t.connect(attacker).refillAll.staticCall()).to.equal(0n);
      }
      expect(await tok.balanceOf(attacker.address)).to.equal(E(1000)); // exactly threshold, not the whole reserve
      expect(await tok.balanceOf(tAddr)).to.equal(E(4000));
      // ...and only after the cooldown does the next `threshold` become pullable.
      await time.increaseTo(availableAt);
      await t.connect(attacker).refill(0);
      expect(await tok.balanceOf(tAddr)).to.equal(E(3000));
    });

    it("S4 [FIXED] a truncated refill consumes the cooldown (L42-44, L367-369): sub-threshold top-ups are NOT drainable until it passes", async function () {
      // Was the one finding inside the treasury's own logic: a refill cut short by an empty treasury
      // (`truncated`) used to leave lastRefill untouched, so a funder who topped the treasury up in
      // chunks smaller than threshold (e.g. streaming reward income) handed every chunk to a
      // compromised pool with no waiting; extraction was bounded by inflows, never by the cooldown.
      // The revision sets lastRefill on EVERY non-zero refill. Same attack loop, now proving the fix:
      // the first sub-threshold chunk is pulled, every later chunk piles up in the treasury behind
      // CooldownActive, and the brake is `threshold per cooldown` regardless of how the reserve arrives.
      const [deployer, owner, attacker] = await ethers.getSigners();
      const Tok = await ethers.getContractFactory("MockERC20");
      const tok = await Tok.deploy(E(1_000_000));
      await tok.waitForDeployment();
      const tokAddr = await tok.getAddress();
      const pool = await deployPool(tokAddr);
      const poolAddr = await pool.getAddress();
      const threshold = E(1000);
      const t = await deployTreasury(tokAddr, owner.address, DAY, [{ account: poolAddr, threshold, maxThreshold: threshold }]);
      const tAddr = await t.getAddress();

      let pulled = 0n;
      let deposited = 0n;
      let availableAt = 0n;
      for (let i = 0; i < 4; i++) {
        await tok.transfer(tAddr, threshold - 1n); // funder tops up just under threshold
        deposited += threshold - 1n;
        if (i === 0) {
          // First chunk: truncated refill goes through and DOES consume the cooldown.
          await expect(t.connect(attacker).refill(0))
            .to.emit(t, "Refilled").withArgs(0, poolAddr, attacker.address, threshold - 1n, 0n, true);
          const lastRefill = (await t.getPool(0)).lastRefill;
          expect(lastRefill).to.equal(BigInt(await time.latest()));
          availableAt = lastRefill + BigInt(DAY);
          await pool.connect(attacker).drain(attacker.address, await tok.balanceOf(poolAddr));
          pulled += threshold - 1n;
        } else {
          // Every later chunk inside the same window: the loop stops at CooldownActive, nothing moves.
          expect(await t.previewRefill(0)).to.equal(0n);
          await expect(t.connect(attacker).refill(0)).to.be.revertedWithCustomError(t, "CooldownActive").withArgs(0n, availableAt);
          expect(await t.connect(attacker).refillAll.staticCall()).to.equal(0n);
          expect(await tok.balanceOf(poolAddr)).to.equal(0n);
        }
      }
      // Only the first chunk left inside ONE cooldown window (no time.increase anywhere above).
      expect(pulled).to.equal(threshold - 1n);
      expect(await tok.balanceOf(attacker.address)).to.equal(pulled);
      expect(await tok.balanceOf(tAddr)).to.equal(deposited - pulled); // 3 chunks accumulated, untouched
      expect(await tok.balanceOf(tAddr)).to.be.greaterThan(threshold * 2n);

      // After the cooldown: at most `threshold` per pull again, even though the reserve holds ~3x that.
      await time.setNextBlockTimestamp(availableAt);
      await t.connect(attacker).refill(0);
      expect(await tok.balanceOf(poolAddr)).to.equal(threshold);
      expect((await t.getPool(0)).lastRefill).to.equal(availableAt);
      await pool.connect(attacker).drain(attacker.address, await tok.balanceOf(poolAddr));
      await expect(t.connect(attacker).refill(0)).to.be.revertedWithCustomError(t, "CooldownActive");
      expect(await tok.balanceOf(attacker.address)).to.equal(pulled + threshold);
    });

    it("S5 compromised owner + token ADMIN quorum (real StorageToken): returnToToken -> transferFromContract -> attacker EOA", async function () {
      // The treasury owner alone can only send to the token contract (L218). Getting it OUT of the
      // token needs StorageToken.transferFromContract (StorageToken.sol L150-171): ADMIN_ROLE, a
      // whitelist proposal approved by quorum, a 24h whitelist lock and a per-role tx limit. Here the
      // attacker holds ONLY the treasury owner key; tokOwner/tokAdmin (the token's ADMIN_ROLE quorum)
      // do every token-side step. returnToToken is a one-way door into a balance the token admins
      // already control, so this shows the chain end to end, not a treasury-owner-only path.
      const [tokOwner, tokAdmin, attacker] = await ethers.getSigners();
      const ST = await ethers.getContractFactory("StorageToken");
      const st = await upgrades.deployProxy(ST, [tokOwner.address, tokAdmin.address, E(1_000_000)], { kind: "uups", initializer: "initialize" });
      await st.waitForDeployment();
      const stAddr = await st.getAddress();

      const pool = await deployPool(stAddr);
      const poolAddr = await pool.getAddress();
      const t = await deployTreasury(stAddr, attacker.address, DAY, [{ account: poolAddr, threshold: E(100), maxThreshold: E(1000) }]);
      const tAddr = await t.getAddress();

      const whitelist = async (target: string) => {
        const tx = await st.connect(tokOwner).createProposal(5, 0, target, ZeroHash, 0, ZeroAddress);
        const rc = await tx.wait();
        const proposalId = rc!.logs[0].topics[1];
        await time.increase(DAY + 1);
        await st.connect(tokAdmin).approveProposal(proposalId);
        await time.increase(DAY + 1);
      };

      await time.increase(DAY + 1); // role timelock after init
      await st.connect(tokOwner).setRoleQuorum(ADMIN_ROLE, 2);
      await st.connect(tokOwner).setRoleTransactionLimit(ADMIN_ROLE, E(10_000));
      await whitelist(tAddr);
      await st.connect(tokOwner).transferFromContract(tAddr, E(5000));
      expect(await st.balanceOf(tAddr)).to.equal(E(5000));

      // Real-token integration checks on the way: refill works with StorageToken.transfer (zero-amount
      // guard L292-295 never reaches AmountMustBePositive), and returnToToken is accepted by _update.
      await t.refill(0);
      expect(await st.balanceOf(poolAddr)).to.equal(E(100));

      await t.connect(attacker).returnToToken(E(4900));
      expect(await st.balanceOf(tAddr)).to.equal(0n);

      await whitelist(attacker.address);
      await st.connect(tokOwner).transferFromContract(attacker.address, E(4900));
      expect(await st.balanceOf(attacker.address)).to.equal(E(4900));
    });
  });

  // ================================================================================================
  // BLOCKED — every attempt below asserts the attack FAILS, with the line that stops it.
  // ================================================================================================
  describe("BLOCKED: compromised owner", function () {
    let tok: any, tokAddr: string, poolA: any, poolB: any, poolAAddr: string, poolBAddr: string, t: any, tAddr: string;
    let owner: any, attacker: any, other: any;
    const threshold = E(1000);

    beforeEach(async function () {
      [, owner, attacker, other] = await ethers.getSigners();
      const Tok = await ethers.getContractFactory("MockERC20");
      tok = await Tok.deploy(E(1_000_000));
      await tok.waitForDeployment();
      tokAddr = await tok.getAddress();
      poolA = await deployPool(tokAddr);
      poolB = await deployPool(tokAddr, "MockRefillPoolStorageToken");
      poolAAddr = await poolA.getAddress();
      poolBAddr = await poolB.getAddress();
      t = await deployTreasury(tokAddr, owner.address, DAY, [
        { account: poolAAddr, threshold, maxThreshold: threshold * 5n },
        { account: poolBAddr, threshold, maxThreshold: threshold * 5n },
      ]);
      tAddr = await t.getAddress();
      await tok.transfer(tAddr, E(100_000));
    });

    it("O1 non-owner cannot call any guardian function (OwnableUnauthorizedAccount)", async function () {
      for (const call of [
        () => t.connect(attacker).pause(),
        () => t.connect(attacker).unpause(),
        () => t.connect(attacker).setThreshold(0, 1n),
        () => t.connect(attacker).setPoolEnabled(0, false),
        () => t.connect(attacker).returnToToken(1n),
        () => t.connect(attacker).transferOwnership(attacker.address),
        () => t.connect(attacker).renounceOwnership(),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
      }
      await expect(t.connect(attacker).acceptOwnership()).to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
    });

    it("O2 attacker who takes ownership (2-step) still has no sink other than pools/token", async function () {
      await t.connect(owner).transferOwnership(attacker.address);
      expect(await t.owner()).to.equal(owner.address); // nothing until accepted
      await t.connect(attacker).acceptOwnership();
      expect(await t.owner()).to.equal(attacker.address);

      // Threshold can be raised only up to the construction cap (L194).
      await expect(t.connect(attacker).setThreshold(0, threshold * 5n + 1n)).to.be.revertedWithCustomError(t, "InvalidThreshold");
      await expect(t.connect(attacker).setThreshold(0, 0)).to.be.revertedWithCustomError(t, "InvalidThreshold");
      await t.connect(attacker).setThreshold(0, threshold * 5n);
      // pause / enable flags are booleans with no destination parameter.
      await t.connect(attacker).pause();
      await expect(t.refill(0)).to.be.revertedWithCustomError(t, "EnforcedPause");
      await expect(t.refillAll()).to.be.revertedWithCustomError(t, "EnforcedPause");
      await t.connect(attacker).unpause();
      await t.connect(attacker).setPoolEnabled(1, false);
      await expect(t.refill(1)).to.be.revertedWithCustomError(t, "PoolDisabled");
      await t.connect(attacker).setPoolEnabled(1, true);

      // returnToToken has no `to` parameter (L214-220): the only sink is address(token).
      const before = await tok.balanceOf(tokAddr);
      await t.connect(attacker).returnToToken(E(100_000));
      expect(await tok.balanceOf(tokAddr)).to.equal(before + E(100_000));
      expect(await tok.balanceOf(attacker.address)).to.equal(0n);
      expect(await tok.balanceOf(tAddr)).to.equal(0n);
      await expect(t.connect(attacker).returnToToken(0)).to.be.revertedWithCustomError(t, "ZeroAmount");
      await expect(t.connect(attacker).returnToToken(1)).to.be.revertedWithCustomError(t, "InsufficientTreasuryBalance");

      // The ABI has no function taking an arbitrary recipient. Enumerate it.
      const sinks = t.interface.fragments
        .filter((f: any) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f: any) => f.name)
        .sort();
      expect(sinks).to.deep.equal([
        "acceptOwnership", "pause", "refill", "refillAll", "renounceOwnership",
        "returnToToken", "setPoolEnabled", "setThreshold", "transferOwnership", "unpause",
      ]);
    });

    it("O3 owner cannot become address(0) while paused (L208-211); Ownable2Step pending=0 is inert", async function () {
      await t.connect(owner).pause();
      await expect(t.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(t, "CannotRenounceWhilePaused");
      // OZ5 Ownable2Step.transferOwnership(0) does not revert; it only sets pendingOwner=0, which no one
      // can accept, so the owner is unchanged and can still unpause.
      await t.connect(owner).transferOwnership(ZeroAddress);
      expect(await t.pendingOwner()).to.equal(ZeroAddress);
      expect(await t.owner()).to.equal(owner.address);
      await t.connect(owner).unpause();
      expect(await t.paused()).to.equal(false);
      // Renouncing while unpaused is allowed and makes the contract autonomous: refills still work,
      // every guardian function is gone forever (including returnToToken).
      await t.connect(owner).renounceOwnership();
      expect(await t.owner()).to.equal(ZeroAddress);
      await expect(t.connect(owner).pause()).to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
      await expect(t.connect(owner).returnToToken(1n)).to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
      await t.refill(0);
      expect(await tok.balanceOf(poolAAddr)).to.equal(threshold);
    });

    it("O4 pause is bounded by MAX_PAUSE (L91-92, L211-224, L267-269): it expires after 30 days, so held keys cannot brick refills forever (no fund loss)", async function () {
      // Pre-revision the owner could pause once and walk away (OZ Pausable, no expiry). Now a pause
      // lasts at most MAX_PAUSE; the guardian must re-pause to extend, and a lost owner key cannot
      // leave the contract stuck.
      expect(await t.MAX_PAUSE()).to.equal(MAX_PAUSE);
      expect(await t.paused()).to.equal(false);
      await expect(t.connect(owner).unpause()).to.be.revertedWithCustomError(t, "ExpectedPause");

      const tx = await t.connect(owner).pause();
      const until = BigInt(await time.latest()) + MAX_PAUSE;
      await expect(tx).to.emit(t, "Paused").withArgs(owner.address, until);
      expect(await t.pausedUntil()).to.equal(until);
      expect(await t.paused()).to.equal(true);
      expect(await t.previewRefill(0)).to.equal(0n);
      await expect(t.refill(0)).to.be.revertedWithCustomError(t, "EnforcedPause");
      await expect(t.refillAll()).to.be.revertedWithCustomError(t, "EnforcedPause");
      // A pause cannot be stacked / re-armed while active (no way to push `pausedUntil` further out).
      await expect(t.connect(owner).pause()).to.be.revertedWithCustomError(t, "EnforcedPause");
      // Funds are still recoverable to the token by the same owner (L211 "does not stop returnToToken").
      await t.connect(owner).returnToToken(E(1));
      expect(await tok.balanceOf(tAddr)).to.equal(E(100_000) - E(1));

      // Just before expiry: still paused. At `pausedUntil` exactly: `block.timestamp < pausedUntil`
      // is false, refills resume with NO owner action.
      await time.increaseTo(until - 2n);
      expect(await t.paused()).to.equal(true);
      await time.setNextBlockTimestamp(until - 1n);
      await expect(t.refill(0)).to.be.revertedWithCustomError(t, "EnforcedPause");
      await time.increaseTo(until);
      expect(await t.paused()).to.equal(false);
      expect(await t.pausedUntil()).to.equal(until); // storage untouched; expiry is purely time-based
      await expect(t.connect(owner).unpause()).to.be.revertedWithCustomError(t, "ExpectedPause");
      expect(await t.previewRefill(0)).to.equal(threshold);
      await t.refill(0);
      expect(await tok.balanceOf(poolAAddr)).to.equal(threshold);

      // The guardian can extend only by pausing again, which starts a fresh MAX_PAUSE window.
      await t.connect(owner).pause();
      expect(await t.pausedUntil()).to.equal(BigInt(await time.latest()) + MAX_PAUSE);
      await expect(t.refill(1)).to.be.revertedWithCustomError(t, "EnforcedPause");
      await expect(t.connect(owner).unpause()).to.emit(t, "Unpaused").withArgs(owner.address);
      expect(await t.pausedUntil()).to.equal(0n);
      await t.refill(1);
      expect(await tok.balanceOf(poolBAddr)).to.equal(threshold);
    });
  });

  describe("BLOCKED: constructor argument manipulation", function () {
    let tok: any, tokAddr: string, pool: any, poolAddr: string, owner: any;
    const ok = { threshold: E(1), maxThreshold: E(1) };

    beforeEach(async function () {
      [, owner] = await ethers.getSigners();
      const Tok = await ethers.getContractFactory("MockERC20");
      tok = await Tok.deploy(E(1_000));
      await tok.waitForDeployment();
      tokAddr = await tok.getAddress();
      pool = await deployPool(tokAddr);
      poolAddr = await pool.getAddress();
    });

    it("C1 token: zero / EOA rejected (L130-131); empty pool list rejected (L132)", async function () {
      const T = await ethers.getContractFactory("FulaRefillTreasury");
      await expect(T.deploy(ZeroAddress, owner.address, MIN_COOLDOWN, [{ account: poolAddr, ...ok }])).to.be.revertedWithCustomError(T, "ZeroAddress");
      await expect(T.deploy(owner.address, owner.address, MIN_COOLDOWN, [{ account: poolAddr, ...ok }])).to.be.revertedWithCustomError(T, "NotAContract");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [])).to.be.revertedWithCustomError(T, "NoPools");
      await expect(T.deploy(tokAddr, ZeroAddress, MIN_COOLDOWN, [{ account: poolAddr, ...ok }])).to.be.revertedWithCustomError(T, "OwnableInvalidOwner");
    });

    it("C2 pool account: zero / token / self / EOA / duplicate rejected (L139-142)", async function () {
      const T = await ethers.getContractFactory("FulaRefillTreasury");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: ZeroAddress, ...ok }])).to.be.revertedWithCustomError(T, "ZeroAddress");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: tokAddr, ...ok }])).to.be.revertedWithCustomError(T, "InvalidPoolAccount");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: owner.address, ...ok }])).to.be.revertedWithCustomError(T, "NotAContract");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, ...ok }, { account: poolAddr, ...ok }])).to.be.revertedWithCustomError(T, "DuplicatePool");
      // "self": precompute the treasury's own address and pass it as a pool. address(this) is known
      // during construction, so L140 (InvalidPoolAccount) fires before the code-length check at L141.
      const [deployer] = await ethers.getSigners();
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const selfAddr = ethers.getCreateAddress({ from: deployer.address, nonce });
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: selfAddr, ...ok }])).to.be.revertedWithCustomError(T, "InvalidPoolAccount");
    });

    it("C3 pool getter aliasing: no getter / empty fallback / wrong token all rejected (L145, L323-334)", async function () {
      const T = await ethers.getContractFactory("FulaRefillTreasury");
      const NoGetter = await ethers.getContractFactory("MockRefillPoolNoGetter");
      const ng = await NoGetter.deploy();
      await ng.waitForDeployment();
      const EmptyFb = await ethers.getContractFactory("MockRefillPoolEmptyFallback");
      const ef = await EmptyFb.deploy();
      await ef.waitForDeployment();
      const Tok2 = await ethers.getContractFactory("MockERC20");
      const tok2 = await Tok2.deploy(E(1));
      await tok2.waitForDeployment();
      const wrongPool = await deployPool(await tok2.getAddress());
      for (const bad of [await ng.getAddress(), await ef.getAddress(), await wrongPool.getAddress()]) {
        await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: bad, ...ok }])).to.be.revertedWithCustomError(T, "PoolTokenMismatch");
      }
      // An ERC20 contract as a "pool": has code, but no token()/storageToken() getter -> rejected too.
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: await tok2.getAddress(), ...ok }])).to.be.revertedWithCustomError(T, "PoolTokenMismatch");
    });

    it("C4 threshold tricks: 0 / > max / max > uint128 rejected (L143-144); uint128.max does not overflow (L307-311)", async function () {
      const T = await ethers.getContractFactory("FulaRefillTreasury");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, threshold: 0n, maxThreshold: E(1) }])).to.be.revertedWithCustomError(T, "InvalidThreshold");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, threshold: E(2), maxThreshold: E(1) }])).to.be.revertedWithCustomError(T, "InvalidThreshold");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, threshold: 1n, maxThreshold: MAX_THRESHOLD + 1n }])).to.be.revertedWithCustomError(T, "InvalidThreshold");
      await expect(T.deploy(tokAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, threshold: 1n, maxThreshold: MaxUint256 }])).to.be.revertedWithCustomError(T, "InvalidThreshold");

      const t = await deployTreasury(tokAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, threshold: MAX_THRESHOLD, maxThreshold: MAX_THRESHOLD }]);
      const tAddr = await t.getAddress();
      expect(await t.targetOf(0)).to.equal((MAX_THRESHOLD * 11_000n) / 10_000n);
      await tok.transfer(tAddr, E(1000));
      expect(await t.previewRefill(0)).to.equal(E(1000)); // capped at threshold, then at treasury balance
      await t.refill(0);
      expect(await tok.balanceOf(poolAddr)).to.equal(E(1000));
      expect(await tok.balanceOf(tAddr)).to.equal(0n);
    });

    it("C5 [FIXED] cooldown outside [MIN_COOLDOWN, MAX_COOLDOWN] is rejected at construction (L85-89, L163): an absolute timestamp / uint64.max can no longer brick refills from the very first call", async function () {
      // Pre-revision any uint64 deployed, and a cooldown >= block.timestamp (e.g. a timestamp passed
      // by mistake) made every refill revert CooldownActive forever (lastRefill=0 + cooldown > now),
      // with only returnToToken left. The immutable is now range-checked; regression test of the bound.
      const T = await ethers.getContractFactory("FulaRefillTreasury");
      expect(await (await deployTreasury(tokAddr, owner.address, MIN_COOLDOWN, [{ account: poolAddr, ...ok }])).MAX_COOLDOWN()).to.equal(MAX_COOLDOWN);
      const now = BigInt(await time.latest());
      const rejected = [
        0n,                    // zero: removes the brake (S3)
        MIN_COOLDOWN - 1n,     // just under the floor
        MAX_COOLDOWN + 1n,     // just over the ceiling
        now + 1_000_000n,      // absolute timestamp passed by mistake: used to brick refills
        now,                   // == block.timestamp
        (1n << 64n) - 1n,      // uint64.max: used to deploy fine and be equally dead
      ];
      for (const bad of rejected) {
        await expect(T.deploy(tokAddr, owner.address, bad, [{ account: poolAddr, ...ok }]), `cooldown ${bad}`)
          .to.be.revertedWithCustomError(T, "CooldownOutOfRange").withArgs(bad, MIN_COOLDOWN, MAX_COOLDOWN);
      }
      // The check runs before the pool loop (after ZeroAddress/NotAContract/NoPools on the token and
      // list, L160-163), so it fires even when the pool entries themselves are invalid.
      await expect(T.deploy(tokAddr, owner.address, 0, [{ account: ZeroAddress, ...ok }])).to.be.revertedWithCustomError(T, "CooldownOutOfRange");
      await expect(T.deploy(tokAddr, owner.address, 0, [])).to.be.revertedWithCustomError(T, "NoPools");

      // Both bounds are inclusive and deploy; a pool with lastRefill=0 is immediately eligible under
      // either, i.e. nothing is bricked from the first call.
      for (const edge of [MIN_COOLDOWN, MAX_COOLDOWN]) {
        const t = await deployTreasury(tokAddr, owner.address, edge, [{ account: poolAddr, ...ok }]);
        const tAddr = await t.getAddress();
        expect(await t.cooldown()).to.equal(edge);
        await tok.transfer(tAddr, E(10));
        expect(await t.previewRefill(0)).to.equal(E(1));
        await t.refill(0);
        expect(await tok.balanceOf(tAddr)).to.equal(E(9));
        await expect(t.refill(0)).to.be.revertedWithCustomError(t, "NotBelowThreshold"); // full, not bricked
        await t.connect(owner).returnToToken(E(9));
        expect(await tok.balanceOf(tAddr)).to.equal(0n);
        await pool.drain(owner.address, E(1)); // reset the shared pool for the next edge
      }
    });
  });

  describe("BLOCKED: permissionless surface", function () {
    let tok: any, tokAddr: string, pool: any, poolAddr: string, t: any, tAddr: string, owner: any, attacker: any, keeper: any;
    const threshold = E(1000);

    beforeEach(async function () {
      [, owner, attacker, keeper] = await ethers.getSigners();
      const Tok = await ethers.getContractFactory("MockERC20");
      tok = await Tok.deploy(E(1_000_000));
      await tok.waitForDeployment();
      tokAddr = await tok.getAddress();
      pool = await deployPool(tokAddr);
      poolAddr = await pool.getAddress();
      t = await deployTreasury(tokAddr, owner.address, DAY, [{ account: poolAddr, threshold, maxThreshold: threshold }]);
      tAddr = await t.getAddress();
      await tok.transfer(tAddr, E(10_000));
    });

    it("P1 unknown poolId / poolId aliasing: array index only, mapping is consistent (L165, L234-242)", async function () {
      await expect(t.refill(1)).to.be.revertedWithCustomError(t, "UnknownPool");
      await expect(t.refill(MaxUint256)).to.be.revertedWithCustomError(t, "UnknownPool");
      await expect(t.getPool(1)).to.be.revertedWithCustomError(t, "UnknownPool");
      await expect(t.poolIdOf(attacker.address)).to.be.revertedWithCustomError(t, "UnknownPool");
      expect(await t.poolIdOf(poolAddr)).to.equal(0n);
      expect(await t.poolCount()).to.equal(1n);
    });

    it("P2 front-running refill: the racer's tx still sends to the pool; the keeper just reverts (L281-283)", async function () {
      await t.connect(attacker).refill(0);
      expect(await tok.balanceOf(poolAddr)).to.equal(threshold);
      expect(await tok.balanceOf(attacker.address)).to.equal(0n);
      await expect(t.connect(keeper).refill(0)).to.be.revertedWithCustomError(t, "NotBelowThreshold");
      expect(await t.connect(keeper).refillAll.staticCall()).to.equal(0n);
      // The refill amount does not depend on msg.sender; it is a pure function of balances (L279-291).
    });

    it("P3 donation to the pool only griefs eligibility (NotBelowThreshold); no outflow", async function () {
      await tok.transfer(poolAddr, threshold);
      await expect(t.refill(0)).to.be.revertedWithCustomError(t, "NotBelowThreshold");
      expect(await t.previewRefill(0)).to.equal(0n);
      expect(await tok.balanceOf(tAddr)).to.equal(E(10_000));
      // Donation to the TREASURY is simply more reserve; nothing can pull it except refill/returnToToken.
      await tok.transfer(tAddr, E(1));
      expect(await t.treasuryBalance()).to.equal(E(10_001));
    });

    it("P4 partial pool balance: amount = min(target - balance, threshold, available); never more than threshold (L307-317)", async function () {
      await tok.transfer(poolAddr, threshold - 1n);
      // target = 1100; balance = 999.999..; amount = 100.000...1 <= threshold
      expect(await t.previewRefill(0)).to.equal((threshold * 11_000n) / 10_000n - (threshold - 1n));
      await t.refill(0);
      expect(await tok.balanceOf(poolAddr)).to.equal((threshold * 11_000n) / 10_000n);
      // With balance 0 the cap is threshold, not target (L311).
      await pool.drain(attacker.address, await tok.balanceOf(poolAddr));
      await time.increase(DAY);
      expect(await t.previewRefill(0)).to.equal(threshold);
    });

    it("P5 sending ETH: no receive/fallback/payable; refill with value reverts before execution", async function () {
      await expect(attacker.sendTransaction({ to: tAddr, value: 1n })).to.be.reverted;
      const data = t.interface.encodeFunctionData("refill", [0]);
      await expect(attacker.sendTransaction({ to: tAddr, value: 1n, data })).to.be.reverted;
      expect(await ethers.provider.getBalance(tAddr)).to.equal(0n);
      expect(t.interface.fallback).to.equal(null);
      expect(t.interface.receive).to.equal(false);
    });

    it("P6 no selfdestruct / delegatecall / receive / fallback / payable in source; not upgradeable", async function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", "contracts", "core", "FulaRefillTreasury.sol"), "utf8");
      for (const needle of ["delegatecall", "selfdestruct", "receive(", "fallback(", "payable", "UUPS", "Upgradeable", "Initializable"]) {
        expect(src.includes(needle), `source contains ${needle}`).to.equal(false);
      }
      // No add/remove-pool function exists (ABI enumeration in O2 above).
      expect(t.interface.fragments.some((f: any) => f.type === "function" && /pool/i.test(f.name) && /add|remove|register|set.*account/i.test(f.name))).to.equal(false);
    });
  });

  describe("BLOCKED: reentrancy through a hooked token", function () {
    it("R1 pool re-enters refill during the transfer hook: ReentrancyGuardReentrantCall (L164, L171, L214)", async function () {
      const [, owner, attacker] = await ethers.getSigners();
      const Hook = await ethers.getContractFactory("MockReentrantToken");
      const hook = await Hook.deploy(E(1_000_000));
      await hook.waitForDeployment();
      const hookAddr = await hook.getAddress();
      const RP = await ethers.getContractFactory("MockReentrantPool");
      const rp = await RP.deploy(hookAddr);
      await rp.waitForDeployment();
      const rpAddr = await rp.getAddress();
      const threshold = E(1000);
      const t = await deployTreasury(hookAddr, owner.address, MIN_COOLDOWN, [{ account: rpAddr, threshold, maxThreshold: threshold }]);
      const tAddr = await t.getAddress();
      await hook.transfer(tAddr, E(10_000)); // hook call on the treasury fails silently (no fallback)
      await rp.arm(tAddr, 0);

      // Scenario 1: pool re-enters refill(0) on itself. Blocked by the guard (and it would also be
      // NotBelowThreshold, since `threshold` has already landed when the hook fires).
      await t.connect(attacker).refill(0);
      expect(await rp.attempted()).to.equal(true);
      expect(await rp.reentered()).to.equal(false);
      expect(await hook.balanceOf(rpAddr)).to.equal(threshold); // exactly one refill landed
      expect(await hook.balanceOf(tAddr)).to.equal(E(9000));

      // Scenario 2 (airtight): two reentrant pools, treasury well funded. Pool A's hook re-enters
      // refill(1) for pool B, which is below threshold, enabled, and never refilled (lastRefill=0, so
      // the cooldown check passes regardless of `cooldown`; every pool here is refilled at most once).
      // Every eligibility check would pass; the ONLY thing that stops it is nonReentrant (L164 / L171).
      const rpA = await RP.deploy(hookAddr);
      await rpA.waitForDeployment();
      const rpB = await RP.deploy(hookAddr);
      await rpB.waitForDeployment();
      const rpC = await RP.deploy(hookAddr);
      await rpC.waitForDeployment();
      const rpAAddr = await rpA.getAddress();
      const rpBAddr = await rpB.getAddress();
      const rpCAddr = await rpC.getAddress();
      const t2 = await deployTreasury(hookAddr, owner.address, MIN_COOLDOWN, [
        { account: rpAAddr, threshold, maxThreshold: threshold },
        { account: rpBAddr, threshold, maxThreshold: threshold },
        { account: rpCAddr, threshold, maxThreshold: threshold },
      ]);
      const t2Addr = await t2.getAddress();
      await hook.transfer(t2Addr, E(10_000));
      await rpA.arm(t2Addr, 1); // A's hook targets pool B
      expect(await t2.previewRefill(1)).to.equal(threshold); // B is eligible right now
      await t2.connect(attacker).refill(0);
      expect(await rpA.attempted()).to.equal(true);
      expect(await rpA.reentered()).to.equal(false);
      expect(await hook.balanceOf(rpAAddr)).to.equal(threshold);
      expect(await hook.balanceOf(rpBAddr)).to.equal(0n); // nested refill(1) took nothing
      expect(await hook.balanceOf(t2Addr)).to.equal(E(9000));

      // Same through refillAll, airtight: B's hook targets C, which is eligible when the hook fires
      // (outer loop has not reached it yet). Balances cannot distinguish "nested refilled C" from
      // "outer loop refilled C", so use the Refilled event's `caller`: a nested refill would be
      // emitted with caller == B, and B's `reentered` flag would be true.
      await rpB.arm(t2Addr, 2);
      const rc = await (await t2.connect(attacker).refillAll()).wait();
      const refilled = rc!.logs
        .map((l: any) => { try { return t2.interface.parseLog(l); } catch { return null; } })
        .filter((p: any) => p && p.name === "Refilled");
      expect(refilled.length).to.equal(2); // B and C by the outer loop
      for (const ev of refilled) expect(ev!.args.caller).to.equal(attacker.address);
      expect(await rpB.attempted()).to.equal(true);
      expect(await rpB.reentered()).to.equal(false);
      expect(await hook.balanceOf(rpBAddr)).to.equal(threshold);
      expect(await hook.balanceOf(rpCAddr)).to.equal(threshold);
      expect(await hook.balanceOf(t2Addr)).to.equal(E(7000));
    });

    it("R2 hook cannot reach returnToToken (onlyOwner) and read-only views see post-effect state (L297-301)", async function () {
      const [, owner, attacker] = await ethers.getSigners();
      const Hook = await ethers.getContractFactory("MockReentrantToken");
      const hook = await Hook.deploy(E(1_000_000));
      await hook.waitForDeployment();
      const hookAddr = await hook.getAddress();
      const RP = await ethers.getContractFactory("MockReentrantPool");
      const rp = await RP.deploy(hookAddr);
      await rp.waitForDeployment();
      const rpAddr = await rp.getAddress();
      const t = await deployTreasury(hookAddr, owner.address, DAY, [{ account: rpAddr, threshold: E(1000), maxThreshold: E(1000) }]);
      const tAddr = await t.getAddress();
      await hook.transfer(tAddr, E(10_000));
      await rp.arm(tAddr, 0);
      await t.connect(attacker).refill(0);
      // lastRefill was written BEFORE the transfer (L299), so even a re-entrant view would see the cooldown.
      expect((await t.getPool(0)).lastRefill).to.not.equal(0n);
      expect(await t.previewRefill(0)).to.equal(0n);
      expect(await hook.balanceOf(attacker.address)).to.equal(0n);
    });
  });

  describe("BLOCKED / DoS: blocklist token (mirrors StorageToken blacklist)", function () {
    let blk: any, blkAddr: string, poolA: any, poolB: any, poolAAddr: string, poolBAddr: string, t: any, tAddr: string, owner: any;
    const threshold = E(1000);

    beforeEach(async function () {
      [, owner] = await ethers.getSigners();
      const B = await ethers.getContractFactory("MockBlocklistToken");
      blk = await B.deploy(E(1_000_000));
      await blk.waitForDeployment();
      blkAddr = await blk.getAddress();
      poolA = await deployPool(blkAddr);
      poolB = await deployPool(blkAddr);
      poolAAddr = await poolA.getAddress();
      poolBAddr = await poolB.getAddress();
      t = await deployTreasury(blkAddr, owner.address, DAY, [
        { account: poolAAddr, threshold, maxThreshold: threshold },
        { account: poolBAddr, threshold, maxThreshold: threshold },
      ]);
      tAddr = await t.getAddress();
      await blk.transfer(tAddr, E(10_000));
    });

    it("B1 blocked pool: refillAll reverts (all-or-nothing, L45-47) until owner disables it; refill(other) works", async function () {
      await blk.setBlocked(poolAAddr, true);
      await expect(t.refillAll()).to.be.revertedWithCustomError(blk, "Blocked");
      await t.refill(1);
      expect(await blk.balanceOf(poolBAddr)).to.equal(threshold);
      await t.connect(owner).setPoolEnabled(0, false);
      expect(await t.refillAll.staticCall()).to.equal(0n); // B is now full, A skipped
      expect(await blk.balanceOf(tAddr)).to.equal(E(9000));
    });

    it("B3 after renounceOwnership a blocked pool makes refillAll revert PERMANENTLY (no owner to disable it); refill(other) still works", async function () {
      await t.connect(owner).renounceOwnership();
      await blk.setBlocked(poolAAddr, true);
      await expect(t.refillAll()).to.be.revertedWithCustomError(blk, "Blocked");
      await expect(t.connect(owner).setPoolEnabled(0, false)).to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
      await t.refill(1);
      expect(await blk.balanceOf(poolBAddr)).to.equal(threshold);
      // Keepers must fall back to per-pool refill; refillAll is dead until the TOKEN unblocks the pool.
      await blk.setBlocked(poolAAddr, false);
      await t.refillAll();
      expect(await blk.balanceOf(poolAAddr)).to.equal(threshold);
    });

    it("B2 blocked TREASURY: refill and returnToToken both revert -- funds frozen until the token unblocks (token-level)", async function () {
      await blk.setBlocked(tAddr, true);
      await expect(t.refill(0)).to.be.revertedWithCustomError(blk, "Blocked");
      await expect(t.connect(owner).returnToToken(1n)).to.be.revertedWithCustomError(blk, "Blocked");
      expect(await blk.balanceOf(tAddr)).to.equal(E(10_000));
      await blk.setBlocked(tAddr, false);
      await t.refill(0);
      expect(await blk.balanceOf(poolAAddr)).to.equal(threshold);
    });
  });

  describe("BLOCKED: truncation logic with a nearly-empty treasury (no over-send, no wrap)", function () {
    it("T1 amount is capped at the treasury balance; empty treasury reverts TreasuryEmpty (L362-365); a truncated refill consumes the cooldown (L367-369)", async function () {
      const [, owner] = await ethers.getSigners();
      const Tok = await ethers.getContractFactory("MockERC20");
      const tok = await Tok.deploy(E(1_000_000));
      await tok.waitForDeployment();
      const tokAddr = await tok.getAddress();
      const pool = await deployPool(tokAddr);
      const poolAddr = await pool.getAddress();
      const t = await deployTreasury(tokAddr, owner.address, DAY, [{ account: poolAddr, threshold: E(1000), maxThreshold: E(1000) }]);
      const tAddr = await t.getAddress();
      await expect(t.refill(0)).to.be.revertedWithCustomError(t, "TreasuryEmpty");
      expect(await t.refillAll.staticCall()).to.equal(0n);
      await tok.transfer(tAddr, 1n);
      await expect(t.refill(0)).to.emit(t, "Refilled").withArgs(0, poolAddr, (await ethers.getSigners())[0].address, 1n, 0n, true);
      expect(await tok.balanceOf(tAddr)).to.equal(0n);
      expect(await tok.balanceOf(poolAddr)).to.equal(1n);
      // Truncated (1 wei against a 1000-token need) and it STILL consumed the cooldown (L367-369);
      // pre-revision lastRefill stayed 0 here and the next deposit was pullable at once.
      const lastRefill = (await t.getPool(0)).lastRefill;
      expect(lastRefill).to.equal(BigInt(await time.latest()));
      await tok.transfer(tAddr, E(1000));
      expect(await t.previewRefill(0)).to.equal(0n);
      await expect(t.refill(0)).to.be.revertedWithCustomError(t, "CooldownActive").withArgs(0n, lastRefill + BigInt(DAY));
      expect(await t.refillAll.staticCall()).to.equal(0n);
      expect(await tok.balanceOf(tAddr)).to.equal(E(1000));
      await time.increaseTo(lastRefill + BigInt(DAY));
      await t.refill(0);
      // amount = min(target - balance = 1100e18 - 1, threshold = 1000e18, available = 1000e18) = threshold
      expect(await tok.balanceOf(poolAddr)).to.equal(E(1000) + 1n);
      expect(await tok.balanceOf(tAddr)).to.equal(0n);
    });
  });
});
