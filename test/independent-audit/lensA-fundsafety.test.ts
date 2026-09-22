// Independent audit, lens A: fund safety / access control / owner-as-adversary / front-running.
// Proof-of-concept tests for FulaRefillTreasury. Every "attack" here is executed by a non-owner
// signer unless the scenario is explicitly about the owner. Nothing in this file touches the
// contract under test or the other test suites.
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract } from "ethers";

const F = (n: number | string) => ethers.parseEther(String(n));
const ONE_DAY = 24 * 60 * 60;
// Mirrors of the contract constants (asserted against the chain where they matter).
const MIN_COOLDOWN = 60 * 60; // FulaRefillTreasury.MIN_COOLDOWN = 1 hour
const MAX_COOLDOWN = 30 * ONE_DAY; // FulaRefillTreasury.MAX_COOLDOWN = 30 days
const MAX_PAUSE = 30 * ONE_DAY; // FulaRefillTreasury.MAX_PAUSE = 30 days

describe("Independent audit / lens A: FulaRefillTreasury fund safety", function () {
  let owner: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let funder: HardhatEthersSigner;
  let token: Contract;

  async function deployTreasury(
    pools: { account: string; threshold: bigint; maxThreshold: bigint }[],
    cooldown = ONE_DAY,
    tokenAddr?: string,
  ): Promise<Contract> {
    const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
    const t = await Treasury.deploy(tokenAddr ?? (await token.getAddress()), owner.address, cooldown, pools);
    await t.waitForDeployment();
    return t as unknown as Contract;
  }

  async function deployPool(tokenAddr?: string): Promise<Contract> {
    const Pool = await ethers.getContractFactory("MockRefillPool");
    const p = await Pool.deploy(tokenAddr ?? (await token.getAddress()));
    await p.waitForDeployment();
    return p as unknown as Contract;
  }

  beforeEach(async function () {
    [owner, attacker, funder] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = (await MockERC20.deploy(F(100_000_000))) as unknown as Contract;
    await token.waitForDeployment();
    // The funder is a third party that tops the treasury up; nothing in the attack needs the owner.
    await token.transfer(funder.address, F(50_000_000));
  });

  // ------------------------------------------------------------------ surface
  it("I-1 (holds): the only state-changing entry points are the ten expected ones", async function () {
    const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
    const mutating = Treasury.interface.fragments
      .filter((f: any) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
      .map((f: any) => f.name)
      .sort();
    expect(mutating).to.deep.equal(
      [
        "acceptOwnership",
        "pause",
        "refill",
        "refillAll",
        "renounceOwnership",
        "returnToToken",
        "setPoolEnabled",
        "setThreshold",
        "transferOwnership",
        "unpause",
      ].sort(),
    );
    // None of them takes a destination address for tokens: the only address-typed input is
    // transferOwnership(newOwner), which never moves tokens.
    const addrInputs = Treasury.interface.fragments
      .filter((f: any) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
      .flatMap((f: any) => f.inputs.filter((i: any) => i.type === "address").map((i: any) => `${f.name}.${i.name}`));
    expect(addrInputs).to.deep.equal(["transferOwnership.newOwner"]);
  });

  // ------------------------------------------------------------------ M-1 (fixed)
  it("M-1 (fixed): every non-zero refill arms the cooldown, so deposits after a truncated refill are not immediately drainable (bridge-escrow sizing)", async function () {
    // Bridge escrow sizing from scripts/RefillTreasury/config.ts: threshold = maxThreshold = 5M,
    // i.e. the threshold exceeds any realistic reserve, so every refill is truncated. Before the
    // fix a truncated refill left `lastRefill` untouched and every later deposit could be siphoned
    // at once, with no time gate; now the brake arms on every non-zero refill, truncated or not.
    const pool = await deployPool();
    const treasury = await deployTreasury([{ account: await pool.getAddress(), threshold: F(5_000_000), maxThreshold: F(5_000_000) }]);
    await token.connect(funder).transfer(await treasury.getAddress(), F(3_000_000));

    // Attacker controls the pool (MockRefillPool.drain is unpermissioned = compromised pool).
    // One permissionless refill still moves the ENTIRE current reserve in a single call ...
    await expect(treasury.connect(attacker).refill(0))
      .to.emit(treasury, "Refilled")
      .withArgs(0, await pool.getAddress(), attacker.address, F(3_000_000), 0n, true);
    const firstRefillAt = BigInt(await time.latest());
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(F(3_000_000));
    // ... but the truncated refill DID arm the cooldown.
    expect((await treasury.getPool(0)).lastRefill).to.equal(firstRefillAt);

    // Attacker drains the pool, a third party tops the treasury up. The fresh deposit is NOT
    // immediately drainable: refill reverts CooldownActive until lastRefill + cooldown,
    // previewRefill reports 0 and refillAll moves nothing.
    await pool.connect(attacker).drain(attacker.address, F(3_000_000));
    await token.connect(funder).transfer(await treasury.getAddress(), F(1_000_000));
    const availableAt = firstRefillAt + BigInt(ONE_DAY);
    await expect(treasury.connect(attacker).refill(0))
      .to.be.revertedWithCustomError(treasury, "CooldownActive")
      .withArgs(0, availableAt);
    expect(await treasury.previewRefill(0)).to.equal(0n);
    await treasury.connect(attacker).refillAll();
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(1_000_000));
    expect(await token.balanceOf(attacker.address)).to.equal(F(3_000_000));

    // Still gated shortly before the cooldown elapses ...
    await time.increaseTo(availableAt - 10n);
    await expect(treasury.connect(attacker).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(1_000_000));
    // ... and drainable exactly from `availableAt` on (the check is `block.timestamp < availableAt`):
    // outflow is bounded to one reserve per cooldown, and that (again truncated) refill re-arms
    // the brake.
    await time.setNextBlockTimestamp(availableAt);
    await treasury.connect(attacker).refill(0);
    const secondRefillAt = BigInt(await time.latest());
    expect(secondRefillAt).to.equal(availableAt);
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(0n);
    expect((await treasury.getPool(0)).lastRefill).to.equal(secondRefillAt);
    await pool.connect(attacker).drain(attacker.address, F(1_000_000));
    expect(await token.balanceOf(attacker.address)).to.equal(F(4_000_000));

    // A deposit landing right after that refill is gated the same way: the brake now bounds
    // inflows as well as the standing reserve.
    await token.connect(funder).transfer(await treasury.getAddress(), F(6_000_000));
    await expect(treasury.connect(attacker).refill(0))
      .to.be.revertedWithCustomError(treasury, "CooldownActive")
      .withArgs(0, secondRefillAt + BigInt(ONE_DAY));
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(6_000_000));

    // Contrast (unchanged): with treasury > threshold a refill is capped at `threshold` and the
    // brake engages exactly as it always did.
    await time.increase(ONE_DAY);
    await treasury.connect(attacker).refill(0);
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(1_000_000));
    await pool.connect(attacker).drain(attacker.address, F(5_000_000));
    await expect(treasury.connect(attacker).refill(0)).to.be.revertedWithCustomError(treasury, "CooldownActive");
  });

  // ------------------------------------------------------------------ M-2
  it("M-2: after renounceOwnership nobody can stop or retire a compromised pool", async function () {
    const good = await deployPool();
    const bad = await deployPool();
    const treasury = await deployTreasury([
      { account: await good.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
      { account: await bad.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) },
    ]);
    await token.connect(funder).transfer(await treasury.getAddress(), F(1_000_000));
    await treasury.connect(owner).renounceOwnership();
    expect(await treasury.owner()).to.equal(ethers.ZeroAddress);

    // Pool 1 is compromised: it is drained after every refill. Nothing can intervene.
    let stolen = 0n;
    for (let i = 0; i < 5; i++) {
      await treasury.connect(attacker).refill(1);
      const bal = await token.balanceOf(await bad.getAddress());
      await bad.connect(attacker).drain(attacker.address, bal);
      stolen += bal;
      await time.increase(ONE_DAY);
    }
    expect(stolen).to.equal(F(500_000));
    expect(await token.balanceOf(attacker.address)).to.equal(F(500_000));

    // Every guardian lever is dead for everyone, including the former owner.
    for (const s of [owner, attacker]) {
      await expect(treasury.connect(s).pause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      await expect(treasury.connect(s).setPoolEnabled(1, false)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      await expect(treasury.connect(s).setThreshold(1, 1)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      await expect(treasury.connect(s).returnToToken(1)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    }
  });

  // ------------------------------------------------------------------ M-3 (fixed)
  it("M-3 (fixed): a pause expires after MAX_PAUSE, so pause + lost owner key cannot lock the funds forever", async function () {
    const pool = await deployPool();
    const treasury = await deployTreasury([{ account: await pool.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) }]);
    await token.connect(funder).transfer(await treasury.getAddress(), F(1_000_000));
    expect(await treasury.MAX_PAUSE()).to.equal(MAX_PAUSE);

    // A pause is time-boxed when it is taken and announces its expiry.
    const pausedAt = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(pausedAt);
    await expect(treasury.connect(owner).pause()).to.emit(treasury, "Paused").withArgs(owner.address, pausedAt + MAX_PAUSE);
    expect(await treasury.pausedUntil()).to.equal(pausedAt + MAX_PAUSE);
    expect(await treasury.paused()).to.equal(true);
    // Pausing again while paused is refused, so one call cannot keep pushing the expiry out.
    await expect(treasury.connect(owner).pause()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    // From here on, assume the owner key is gone (or the owner is hostile and simply walks away).

    await expect(treasury.connect(attacker).refill(0)).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    await expect(treasury.connect(attacker).refillAll()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    await expect(treasury.connect(attacker).unpause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    await expect(treasury.connect(attacker).returnToToken(F(1))).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    // The renounce guard still only blocks the owner from making it worse.
    await expect(treasury.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(treasury, "CannotRenounceWhilePaused");

    // Still paused shortly before the expiry: refills stay blocked and the funds stay put.
    await time.increaseTo(pausedAt + MAX_PAUSE - ONE_DAY);
    expect(await treasury.paused()).to.equal(true);
    expect(await treasury.previewRefill(0)).to.equal(0n);
    await expect(treasury.connect(attacker).refill(0)).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(1_000_000));

    // At exactly `pausedUntil` the pause lapses on its own (`paused()` is `timestamp < pausedUntil`):
    // no owner action, no permissioned exit. Refills resume for anyone.
    await time.setNextBlockTimestamp(pausedAt + MAX_PAUSE);
    await treasury.connect(attacker).refill(0);
    expect(await time.latest()).to.equal(pausedAt + MAX_PAUSE);
    expect(await treasury.paused()).to.equal(false);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(F(100_000));
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(900_000));
    // There is nothing left to unpause.
    await expect(treasury.connect(owner).unpause()).to.be.revertedWithCustomError(treasury, "ExpectedPause");

    // The guardian can extend by pausing again (a fresh MAX_PAUSE window) and can end it early.
    await expect(treasury.connect(owner).pause()).to.emit(treasury, "Paused");
    expect(await treasury.paused()).to.equal(true);
    await expect(treasury.connect(attacker).refillAll()).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    await expect(treasury.connect(owner).unpause()).to.emit(treasury, "Unpaused").withArgs(owner.address);
    expect(await treasury.paused()).to.equal(false);
    expect(await treasury.pausedUntil()).to.equal(0n);

    // Pausing and then handing ownership to an address that never unpauses no longer strands
    // the funds either: the worst case is one MAX_PAUSE of downtime per pause. Ownable2Step needs
    // the recipient to accept, so use a second signer.
    await treasury.connect(owner).pause();
    await treasury.connect(owner).transferOwnership(funder.address);
    await treasury.connect(funder).acceptOwnership();
    await expect(treasury.connect(owner).unpause()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    await expect(treasury.connect(attacker).refill(0)).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    await time.increase(MAX_PAUSE + 1);
    expect(await treasury.paused()).to.equal(false);
    await pool.connect(attacker).drain(attacker.address, F(100_000)); // pool below threshold again
    await treasury.connect(attacker).refill(0); // the 1-day cooldown has long passed as well
    expect(await token.balanceOf(await pool.getAddress())).to.equal(F(100_000));
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(800_000));
  });

  // ------------------------------------------------------------------ L-1
  it("L-1: a refill can front-run the guardian's full returnToToken and make it revert", async function () {
    const pool = await deployPool();
    const treasury = await deployTreasury([{ account: await pool.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) }]);
    await token.connect(funder).transfer(await treasury.getAddress(), F(150_000));
    // Guardian intends to pull everything back to the token contract.
    const everything = await token.balanceOf(await treasury.getAddress());
    // Attacker lands first (pool is below threshold, so the refill is legal).
    await treasury.connect(attacker).refill(0);
    await expect(treasury.connect(owner).returnToToken(everything)).to.be.revertedWithCustomError(treasury, "InsufficientTreasuryBalance");
    // Mitigation available: pause() first, since pause does not gate returnToToken.
    await treasury.connect(owner).pause();
    const rest = await token.balanceOf(await treasury.getAddress());
    await treasury.connect(owner).returnToToken(rest);
    expect(await token.balanceOf(await token.getAddress())).to.equal(rest);
  });

  // ------------------------------------------------------------------ holds
  it("holds: a hostile owner (or ownership thief) cannot route FULA to itself or any non-pool address", async function () {
    const pool = await deployPool();
    const treasury = await deployTreasury([{ account: await pool.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) }]);
    await token.connect(funder).transfer(await treasury.getAddress(), F(1_000_000));

    await treasury.connect(owner).transferOwnership(attacker.address);
    await treasury.connect(attacker).acceptOwnership();
    expect(await treasury.owner()).to.equal(attacker.address);

    const before = await token.balanceOf(attacker.address);
    await treasury.connect(attacker).setThreshold(0, F(100_000)); // cap: cannot exceed maxThreshold
    await expect(treasury.connect(attacker).setThreshold(0, F(100_000) + 1n)).to.be.revertedWithCustomError(treasury, "InvalidThreshold");
    await treasury.connect(attacker).returnToToken(F(400_000));
    await treasury.connect(attacker).refill(0);
    expect(await token.balanceOf(attacker.address)).to.equal(before);
    expect(await token.balanceOf(await token.getAddress())).to.equal(F(400_000));
    expect(await token.balanceOf(await pool.getAddress())).to.equal(F(100_000));
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(F(500_000));
  });

  it("holds: refill amount is bounded by min(target - balance, threshold, treasury) and never exceeds threshold", async function () {
    const pool = await deployPool();
    const treasury = await deployTreasury([{ account: await pool.getAddress(), threshold: F(100_000), maxThreshold: F(100_000) }]);
    await token.connect(funder).transfer(await treasury.getAddress(), F(10_000_000));
    await token.connect(funder).transfer(await pool.getAddress(), F(60_000));
    expect(await treasury.previewRefill(0)).to.equal(F(50_000)); // 110k - 60k
    await treasury.connect(attacker).refill(0);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(F(110_000));
    await expect(treasury.connect(attacker).refill(0)).to.be.revertedWithCustomError(treasury, "NotBelowThreshold");
    // Donation cannot make a refill larger, only smaller / unnecessary.
    await pool.connect(attacker).drain(attacker.address, F(110_000));
    await time.increase(ONE_DAY);
    await treasury.connect(attacker).refill(0);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(F(100_000)); // capped at threshold, not 110k
  });

  it("holds: reentrancy from a hooked token/pool cannot double-refill", async function () {
    const Hooked = await ethers.getContractFactory("MockReentrantToken");
    const hooked = (await Hooked.deploy(F(1_000_000))) as unknown as Contract;
    await hooked.waitForDeployment();
    const RPool = await ethers.getContractFactory("MockReentrantPool");
    const rpool = (await RPool.deploy(await hooked.getAddress())) as unknown as Contract;
    await rpool.waitForDeployment();
    const treasury = await deployTreasury(
      [{ account: await rpool.getAddress(), threshold: F(1_000), maxThreshold: F(1_000) }],
      // Shortest cooldown the constructor accepts (0 is refused). The re-entrant call lands inside
      // the same transaction, so no time passes and the guard is what has to stop it.
      MIN_COOLDOWN,
      await hooked.getAddress(),
    );
    await hooked.transfer(await treasury.getAddress(), F(10_000));
    await rpool.arm(await treasury.getAddress(), 0);
    await treasury.connect(attacker).refill(0);
    expect(await rpool.attempted()).to.equal(true);
    expect(await rpool.reentered()).to.equal(false);
    // min(target 1100 - 0, threshold 1000) = 1000, delivered exactly once.
    expect(await hooked.balanceOf(await rpool.getAddress())).to.equal(F(1_000));
  });

  it("holds: constructor refuses the token, itself, EOAs, zero, and contracts that do not report the token", async function () {
    const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
    const tokenAddr = await token.getAddress();
    const pool = await deployPool();
    const good = { account: await pool.getAddress(), threshold: F(1), maxThreshold: F(1) };
    // A valid cooldown, so each case below reaches the pool checks (cooldown is validated first).
    const cd = ONE_DAY;
    await expect(Treasury.deploy(tokenAddr, owner.address, cd, [{ ...good, account: tokenAddr }])).to.be.revertedWithCustomError(Treasury, "InvalidPoolAccount");
    await expect(Treasury.deploy(tokenAddr, owner.address, cd, [{ ...good, account: attacker.address }])).to.be.revertedWithCustomError(Treasury, "NotAContract");
    await expect(Treasury.deploy(tokenAddr, owner.address, cd, [{ ...good, account: ethers.ZeroAddress }])).to.be.revertedWithCustomError(Treasury, "ZeroAddress");
    const other = await deployPool((await (await ethers.getContractFactory("MockERC20")).deploy(1n)).getAddress());
    await expect(Treasury.deploy(tokenAddr, owner.address, cd, [{ ...good, account: await other.getAddress() }])).to.be.revertedWithCustomError(Treasury, "PoolTokenMismatch");
    await expect(Treasury.deploy(tokenAddr, owner.address, cd, [good, good])).to.be.revertedWithCustomError(Treasury, "DuplicatePool");
    await expect(Treasury.deploy(tokenAddr, ethers.ZeroAddress, cd, [good])).to.be.revertedWithCustomError(Treasury, "OwnableInvalidOwner");
  });

  it("holds (regression): constructor bounds cooldown to [MIN_COOLDOWN, MAX_COOLDOWN], so the brake can neither be disabled nor brick refills", async function () {
    const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
    const tokenAddr = await token.getAddress();
    const pool = await deployPool();
    const good = [{ account: await pool.getAddress(), threshold: F(1), maxThreshold: F(1) }];

    // Zero (or anything under an hour) would remove the only brake on a compromised pool.
    await expect(Treasury.deploy(tokenAddr, owner.address, 0, good))
      .to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange")
      .withArgs(0, MIN_COOLDOWN, MAX_COOLDOWN);
    await expect(Treasury.deploy(tokenAddr, owner.address, MIN_COOLDOWN - 1, good))
      .to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange")
      .withArgs(MIN_COOLDOWN - 1, MIN_COOLDOWN, MAX_COOLDOWN);
    // Too large, or an absolute timestamp passed by mistake, would freeze every pool for good
    // (the value is immutable): `lastRefill + cooldown` would never be reached.
    await expect(Treasury.deploy(tokenAddr, owner.address, MAX_COOLDOWN + 1, good))
      .to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange")
      .withArgs(MAX_COOLDOWN + 1, MIN_COOLDOWN, MAX_COOLDOWN);
    const now = await time.latest();
    await expect(Treasury.deploy(tokenAddr, owner.address, now, good))
      .to.be.revertedWithCustomError(Treasury, "CooldownOutOfRange")
      .withArgs(now, MIN_COOLDOWN, MAX_COOLDOWN);

    // Both bounds are inclusive and the value is stored as given.
    const lo = await deployTreasury(good, MIN_COOLDOWN);
    const hi = await deployTreasury(good, MAX_COOLDOWN);
    expect(await lo.MIN_COOLDOWN()).to.equal(MIN_COOLDOWN);
    expect(await lo.MAX_COOLDOWN()).to.equal(MAX_COOLDOWN);
    expect(await lo.cooldown()).to.equal(MIN_COOLDOWN);
    expect(await hi.cooldown()).to.equal(MAX_COOLDOWN);

    // Even at the minimum the brake is real: two refills of one pool need an hour between them.
    await token.connect(funder).transfer(await lo.getAddress(), F(10));
    await lo.connect(attacker).refill(0);
    const refilledAt = BigInt(await time.latest());
    await pool.connect(attacker).drain(attacker.address, F(1));
    await expect(lo.connect(attacker).refill(0))
      .to.be.revertedWithCustomError(lo, "CooldownActive")
      .withArgs(0, refilledAt + BigInt(MIN_COOLDOWN));
    await time.increase(MIN_COOLDOWN + 1);
    await lo.connect(attacker).refill(0);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(F(1));
  });
});
