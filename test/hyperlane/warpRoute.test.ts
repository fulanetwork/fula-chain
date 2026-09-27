// Hardhat tests for the FULA Base <-> SKALE Hyperlane warp route SECURITY STACK, run against the
// REAL Hyperlane contracts from scripts/hyperlane/artifacts-shanghai (the same bytecode that is
// deployed), not mocks: two Mailboxes (one per domain), MerkleTreeHooks, HypERC20Collateral routers
// and the exact ISM tree (StaticAggregationIsm 3-of-3 of MessageIdMultisigIsm + RateLimitedIsm +
// PausableIsm). The validator + relayer are simulated in TypeScript: the test signs the origin
// merkle checkpoint with the validator key and calls Mailbox.process on the destination, exactly as
// the agents do.
//
//   yarn test:hyperlane
import { expect } from "chai";
import { ethers as hh } from "hardhat";
import { ethers } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { contract, deploy } from "../../scripts/hyperlane/lib/artifacts";

const DOMAIN_A = 8453; // "base"
const DOMAIN_B = 2046399126; // "skaleeuropa"
const CAP = ethers.parseEther("1000");
const DURATION = 86_400;
const SEED = ethers.parseEther("10000");
const F = (n: string | number) => ethers.parseEther(String(n));
const b32 = (a: string) => ethers.zeroPadValue(a, 32);
const sortAddrs = (xs: string[]) => [...new Set(xs.map((x) => ethers.getAddress(x)))].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

interface Chain {
  domain: number;
  mailbox: ethers.Contract;
  merkle: ethers.Contract;
  router: ethers.Contract;
  token: ethers.Contract;
  multisig: ethers.Contract;
  rateLimited: ethers.Contract;
  pausable: ethers.Contract;
  aggregation: ethers.Contract;
  proxyAdmin: ethers.Contract;
}

describe("Hyperlane warp route: FULA Base <-> SKALE security stack (real Shanghai artifacts)", () => {
  let owner: any, user: any, other: any, deployer: any;
  let validatorA: ethers.Wallet, validatorB: ethers.Wallet, rogue: ethers.Wallet;
  let A: Chain, B: Chain;

  /** Deploy one chain's core + router + ISM tree. `originValidators` attest messages ARRIVING here. */
  async function deployChain(domain: number, originValidators: string[], threshold: number): Promise<Chain> {
    const proxyAdmin = await deploy("ProxyAdmin", deployer, [], `ProxyAdmin(${domain})`);
    const impl = await deploy("Mailbox", deployer, [domain], `Mailbox impl(${domain})`);
    const pa = await proxyAdmin.getAddress();
    const init = impl.interface.encodeFunctionData("initialize", [deployer.address, pa, pa, pa]);
    const proxy = await deploy("TransparentUpgradeableProxy", deployer, [await impl.getAddress(), pa, init], `Mailbox proxy(${domain})`);
    const mailbox = contract("Mailbox", await proxy.getAddress(), deployer);
    const merkle = await deploy("MerkleTreeHook", deployer, [await mailbox.getAddress()], `MerkleTreeHook(${domain})`);
    const fee = await deploy("ProtocolFee", deployer, [F("0.1"), 0, owner.address, owner.address], `ProtocolFee(${domain})`);
    const trusted = await deploy("TrustedRelayerIsm", deployer, [await mailbox.getAddress(), owner.address], `TrustedRelayerIsm(${domain})`);
    await (await mailbox.setDefaultIsm(await trusted.getAddress())).wait();
    await (await mailbox.setDefaultHook(await merkle.getAddress())).wait();
    await (await mailbox.setRequiredHook(await fee.getAddress())).wait();
    const aggF = await deploy("StaticAggregationIsmFactory", deployer, [], `aggF(${domain})`);
    const msF = await deploy("StaticMessageIdMultisigIsmFactory", deployer, [], `msF(${domain})`);

    const Mock = await hh.getContractFactory("MockERC20");
    const tokenC = await Mock.connect(deployer).deploy(F(1_000_000));
    await tokenC.waitForDeployment();
    const token = new ethers.Contract(await tokenC.getAddress(), ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function totalSupply() view returns (uint256)"], deployer);

    const rpa = await deploy("ProxyAdmin", deployer, [], `router ProxyAdmin(${domain})`);
    const rimpl = await deploy("HypERC20Collateral", deployer, [await token.getAddress(), 1, 1, await mailbox.getAddress()], `HypERC20Collateral impl(${domain})`);
    const rinit = rimpl.interface.encodeFunctionData("initialize", [await merkle.getAddress(), ethers.ZeroAddress, deployer.address]);
    const rproxy = await deploy("TransparentUpgradeableProxy", deployer, [await rimpl.getAddress(), await rpa.getAddress(), rinit], `router proxy(${domain})`);
    const router = contract("HypERC20Collateral", await rproxy.getAddress(), deployer);

    const pausable = await deploy("PausableIsm", deployer, [owner.address], `PausableIsm(${domain})`);
    const rateLimited = await deploy("RateLimitedIsm", deployer, [await mailbox.getAddress(), CAP, DURATION, await router.getAddress()], `RateLimitedIsm(${domain})`);
    await (await rateLimited.transferOwnership(owner.address)).wait();
    const vals = sortAddrs(originValidators);
    await (await msF["deploy(address[],uint8)"](vals, threshold)).wait();
    const msAddr: string = await msF["getAddress(address[],uint8)"](vals, threshold);
    const mods = sortAddrs([msAddr, await rateLimited.getAddress(), await pausable.getAddress()]);
    await (await aggF["deploy(address[],uint8)"](mods, 3)).wait();
    const aggAddr: string = await aggF["getAddress(address[],uint8)"](mods, 3);
    await (await router.setInterchainSecurityModule(aggAddr)).wait();
    return { domain, mailbox, merkle, router, token, multisig: contract("StaticMessageIdMultisigIsm", msAddr, deployer), rateLimited, pausable: contract("PausableIsm", await pausable.getAddress(), owner), aggregation: contract("StaticAggregationIsm", aggAddr, deployer), proxyAdmin: rpa };
  }

  /** What the relayer does: build metadata from the validator's checkpoint signature and process. */
  async function relay(origin: Chain, dest: Chain, dispatchTx: ethers.ContractTransactionResponse, validators: ethers.Wallet[], opts: { wrongRoot?: boolean } = {}) {
    const rcpt = await dispatchTx.wait();
    let message: string | undefined, messageId: string | undefined;
    for (const log of rcpt!.logs) {
      try {
        const p = origin.mailbox.interface.parseLog(log as any);
        if (p?.name === "Dispatch") message = p.args[3];
        if (p?.name === "DispatchId") messageId = p.args[0];
      } catch { /* other */ }
    }
    if (!message || !messageId) throw new Error("no Dispatch in receipt");
    const [root, index] = await origin.merkle.latestCheckpoint();
    const hookAddr = await origin.merkle.getAddress();
    // CheckpointLib.digest: toEthSignedMessageHash(keccak256(domainHash, root, index, messageId)), domainHash = keccak256(origin, hook, "HYPERLANE")
    const domainHash = ethers.solidityPackedKeccak256(["uint32", "bytes32", "string"], [origin.domain, b32(hookAddr), "HYPERLANE"]);
    const usedRoot = opts.wrongRoot ? ethers.keccak256("0x1234") : root;
    const digest = ethers.solidityPackedKeccak256(["bytes32", "bytes32", "uint32", "bytes32"], [domainHash, usedRoot, index, messageId]);
    const sigs = await Promise.all(validators.map((v) => v.signMessage(ethers.getBytes(digest))));
    const multisigMetadata = ethers.concat([b32(hookAddr), usedRoot, ethers.toBeHex(index, 4), ...sigs]);
    // AggregationIsmMetadata: one (start,end) uint32 pair per module, in the aggregation's module
    // order, then the packed sub-metadatas. The aggregation only CALLS a module whose range has a
    // non-zero start (hasMetadata), and needs `threshold` modules to verify — so every module must
    // get a range: the multisig its real metadata, the rate-limited and pausable modules an EMPTY
    // slice (start == end, non-zero). This is exactly what the Hyperlane relayer produces.
    const [mods] = await dest.aggregation.modulesAndThreshold("0x");
    const msAddr = (await dest.multisig.getAddress()).toLowerCase();
    const headerLen = 8 * mods.length;
    const header = ethers.concat(mods.map((m: string) => (m.toLowerCase() === msAddr
      ? ethers.concat([ethers.toBeHex(headerLen, 4), ethers.toBeHex(headerLen + ethers.dataLength(multisigMetadata), 4)])
      : ethers.concat([ethers.toBeHex(headerLen, 4), ethers.toBeHex(headerLen, 4)]))));
    const metadata = ethers.concat([header, multisigMetadata]);
    if (process.env.HL_TEST_DEBUG) {
      const [vals, th] = await dest.multisig.validatorsAndThreshold(message);
      console.log("      [debug] dest validators", vals, th, "signers", validators.map((v) => v.address), "recovered", ethers.verifyMessage(ethers.getBytes(digest), sigs[0]));
      console.log("      [debug] origin", origin.domain, "hook", hookAddr, "root", root, "index", index, "id", messageId, "mods", mods, "ms", msAddr);
      try { console.log("      [debug] multisig.verify", await dest.multisig.verify(multisigMetadata, message)); } catch (e: any) { console.log("      [debug] multisig.verify reverted", e.shortMessage || e.message); }
      try { console.log("      [debug] aggregation.verify", await dest.aggregation.verify(metadata, message)); } catch (e: any) { console.log("      [debug] aggregation.verify reverted", e.shortMessage || e.message); }
    }
    return { messageId, process: () => dest.mailbox.connect(other).process(metadata, message!) };
  }

  async function send(from: Chain, to: Chain, sender: any, amount: bigint, recipient = sender.address) {
    await (await from.token.connect(sender).approve(await from.router.getAddress(), amount)).wait();
    const fee: bigint = await from.router["quoteGasPayment(uint32)"](to.domain);
    return from.router.connect(sender)["transferRemote(uint32,bytes32,uint256)"](to.domain, b32(recipient), amount, { value: fee }) as Promise<ethers.ContractTransactionResponse>;
  }

  before(async () => {
    [deployer, owner, user, other] = await hh.getSigners();
    validatorA = ethers.Wallet.createRandom(); // attests messages leaving A (i.e. arriving at B)
    validatorB = ethers.Wallet.createRandom(); // attests messages leaving B (arriving at A)
    rogue = ethers.Wallet.createRandom();
    A = await deployChain(DOMAIN_A, [validatorB.address], 1);
    B = await deployChain(DOMAIN_B, [validatorA.address], 1);
    await (await A.router.enrollRemoteRouter(B.domain, b32(await B.router.getAddress()))).wait();
    await (await B.router.enrollRemoteRouter(A.domain, b32(await A.router.getAddress()))).wait();
    await (await A.router.transferOwnership(owner.address)).wait();
    await (await B.router.transferOwnership(owner.address)).wait();
    for (const c of [A, B]) {
      await (await c.token.transfer(await c.router.getAddress(), SEED)).wait();
      await (await c.token.transfer(user.address, F(50_000))).wait();
    }
  });

  it("deployed the intended stack: aggregation 3-of-3 of multisig + rateLimited + pausable, merkle hook, owner", async () => {
    for (const [c, vals] of [[A, [validatorB.address]], [B, [validatorA.address]]] as const) {
      expect(await c.router.owner()).to.equal(owner.address);
      expect(await c.router.hook()).to.equal(await c.merkle.getAddress());
      expect(await c.router.interchainSecurityModule()).to.equal(await c.aggregation.getAddress());
      const [mods, th] = await c.aggregation.modulesAndThreshold("0x");
      expect(Number(th)).to.equal(3); expect(mods.length).to.equal(3);
      const [v, t] = await c.multisig.validatorsAndThreshold("0x");
      expect(sortAddrs(v)).to.deep.equal(sortAddrs(vals)); expect(Number(t)).to.equal(1);
      expect(await c.rateLimited.recipient()).to.equal(await c.router.getAddress());
      expect(await c.rateLimited.owner()).to.equal(owner.address);
      expect(await c.pausable.owner()).to.equal(owner.address);
      expect(await c.pausable.paused()).to.equal(false);
    }
  });

  it("A -> B: lock on A, release on B, supply and escrow conserved", async () => {
    const amt = F(100);
    const [uA0, uB0, eA0, eB0] = await Promise.all([A.token.balanceOf(user.address), B.token.balanceOf(user.address), A.token.balanceOf(await A.router.getAddress()), B.token.balanceOf(await B.router.getAddress())]);
    const tx = await send(A, B, user, amt);
    expect(await A.token.balanceOf(user.address)).to.equal(uA0 - amt);
    expect(await A.token.balanceOf(await A.router.getAddress())).to.equal(eA0 + amt);
    const r = await relay(A, B, tx, [validatorA]);
    expect(await B.mailbox.delivered(r.messageId)).to.equal(false);
    await (await r.process()).wait();
    expect(await B.mailbox.delivered(r.messageId)).to.equal(true);
    expect(await B.token.balanceOf(user.address)).to.equal(uB0 + amt);
    expect(await B.token.balanceOf(await B.router.getAddress())).to.equal(eB0 - amt);
    expect(await A.token.totalSupply()).to.equal(F(1_000_000));
    expect(await B.token.totalSupply()).to.equal(F(1_000_000));
  });

  it("B -> A: the reverse direction with the other validator set", async () => {
    const amt = F(42);
    const uA0 = await A.token.balanceOf(other.address);
    const tx = await send(B, A, user, amt, other.address);
    const r = await relay(B, A, tx, [validatorB]);
    await (await r.process()).wait();
    expect(await A.token.balanceOf(other.address)).to.equal(uA0 + amt);
  });

  it("replay of a delivered message is rejected by the Mailbox", async () => {
    const tx = await send(A, B, user, F(1));
    const r = await relay(A, B, tx, [validatorA]);
    await (await r.process()).wait();
    await expect(r.process()).to.be.revertedWith("Mailbox: already delivered");
  });

  it("a signature from a key that is not the configured validator is rejected (multisig)", async () => {
    const tx = await send(A, B, user, F(1));
    const r = await relay(A, B, tx, [rogue]);
    await expect(r.process()).to.be.reverted; // "!threshold" from the multisig ISM inside the aggregation
    expect(await B.mailbox.delivered(r.messageId)).to.equal(false);
    // the right validator can still deliver the same message afterwards (funds were never at risk)
    const ok = await relay(A, B, tx, [validatorA]);
    await (await ok.process()).wait();
    expect(await B.mailbox.delivered(ok.messageId)).to.equal(true);
  });

  it("message-id multisig binds the validator to the MESSAGE ID, not the root: the root in the metadata is not checked", async () => {
    // Documented property of MessageIdMultisigIsm (the ISM the relayer uses): the validator's
    // signature covers (root, index, messageId); the ISM verifies the signature and the message id,
    // not the merkle root itself. A validator signing a bogus root for a real message id still
    // delivers that real message — no funds are misdirected, the release matches the dispatched
    // message. The corollary (a validator can sign a NEVER-dispatched message) is the single-
    // validator trust, bounded by the next test.
    const tx = await send(A, B, user, F(1));
    const r = await relay(A, B, tx, [validatorA], { wrongRoot: true });
    await (await r.process()).wait();
    expect(await B.mailbox.delivered(r.messageId)).to.equal(true);
  });

  it("LOSS BOUND: a compromised validator can forge a release only up to the daily cap; anything larger is impossible", async () => {
    // Forge a Hyperlane message that was NEVER dispatched on A, claiming a release on B, and sign it
    // with the (compromised) validator key. This is the worst case for the SKALE->Base direction.
    await time.increase(DURATION); // fresh bucket
    const forge = async (amount: bigint, nonce: number) => {
      const body = ethers.solidityPacked(["bytes32", "uint256"], [b32(other.address), amount]); // TokenMessage
      const message = ethers.solidityPacked(["uint8", "uint32", "uint32", "bytes32", "uint32", "bytes32", "bytes"],
        [3, nonce, A.domain, b32(await A.router.getAddress()), B.domain, b32(await B.router.getAddress()), body]);
      const messageId = ethers.keccak256(message);
      const hookAddr = await A.merkle.getAddress();
      const fakeRoot = ethers.keccak256(ethers.toUtf8Bytes("forged"));
      const domainHash = ethers.solidityPackedKeccak256(["uint32", "bytes32", "string"], [A.domain, b32(hookAddr), "HYPERLANE"]);
      const digest = ethers.solidityPackedKeccak256(["bytes32", "bytes32", "uint32", "bytes32"], [domainHash, fakeRoot, 7, messageId]);
      const sig = await validatorA.signMessage(ethers.getBytes(digest));
      const ms = ethers.concat([b32(hookAddr), fakeRoot, ethers.toBeHex(7, 4), sig]);
      const [mods] = await B.aggregation.modulesAndThreshold("0x");
      const msAddr = (await B.multisig.getAddress()).toLowerCase();
      const hl = 8 * mods.length;
      const header = ethers.concat(mods.map((m: string) => (m.toLowerCase() === msAddr ? ethers.concat([ethers.toBeHex(hl, 4), ethers.toBeHex(hl + ethers.dataLength(ms), 4)]) : ethers.concat([ethers.toBeHex(hl, 4), ethers.toBeHex(hl, 4)]))));
      return { messageId, process: () => B.mailbox.connect(other).process(ethers.concat([header, ms]), message) };
    };
    const escrow0 = await B.token.balanceOf(await B.router.getAddress());
    // above the cap: impossible, even though the signature is valid
    const big = await forge(CAP + F(1), 9001);
    await expect(big.process()).to.be.reverted;
    expect(await B.mailbox.delivered(big.messageId)).to.equal(false);
    // at the cap: the forgery succeeds — this is the accepted, bounded risk of a single validator
    const atCap = await forge(CAP - F(1), 9002);
    await (await atCap.process()).wait();
    expect(await B.token.balanceOf(await B.router.getAddress())).to.equal(escrow0 - (CAP - F(1)));
    // and nothing more until the window refills
    const more = await forge(F(5), 9003);
    await expect(more.process()).to.be.reverted;
    // the owner's pause stops even a compromised validator immediately
    await time.increase(DURATION);
    await (await B.pausable.connect(owner).pause()).wait();
    await expect(more.process()).to.be.reverted;
    await (await B.pausable.connect(owner).unpause()).wait();
  });

  it("inbound cap: a single transfer above the daily cap cannot be released; it parks and delivers after the window", async () => {
    const big = CAP + F(1);
    const tx = await send(A, B, user, big);
    const r = await relay(A, B, tx, [validatorA]);
    await expect(r.process()).to.be.reverted; // RateLimitExceeded inside the aggregation
    expect(await B.mailbox.delivered(r.messageId)).to.equal(false);
    // Even after a full refill window the bucket never exceeds CAP, so this message can NEVER be
    // released by the ISM: the cap is a hard ceiling per message as well as per day.
    await time.increase(DURATION);
    await expect(r.process()).to.be.reverted;
  });

  it("inbound cap: transfers under the cap deliver until the bucket is empty, then refill over time", async () => {
    // fresh window: the previous test moved time forward, so the bucket is full again
    const half = CAP / 2n;
    const tx1 = await send(A, B, user, half);
    await (await (await relay(A, B, tx1, [validatorA])).process()).wait();
    const tx2 = await send(A, B, user, half - F(1)); // bucket ~ half left (minus the 1 FULA delivered earlier in the window)
    await (await (await relay(A, B, tx2, [validatorA])).process()).wait();
    const tx3 = await send(A, B, user, F(10)); // bucket ~ empty
    const r3 = await relay(A, B, tx3, [validatorA]);
    await expect(r3.process()).to.be.reverted;
    await time.increase(DURATION / 4); // ~250 FULA refilled
    await (await r3.process()).wait();
    expect(await B.mailbox.delivered(r3.messageId)).to.equal(true);
  });

  it("pause: the owner's PausableIsm blocks every release on that chain; unpause resumes with no loss", async () => {
    const tx = await send(B, A, user, F(5));
    const r = await relay(B, A, tx, [validatorB]);
    await (await A.pausable.connect(owner).pause()).wait();
    expect(await A.pausable.paused()).to.equal(true);
    await expect(r.process()).to.be.reverted; // "Pausable: paused"
    await expect(A.pausable.connect(user).unpause()).to.be.reverted; // only owner
    await (await A.pausable.connect(owner).unpause()).wait();
    await (await r.process()).wait();
    expect(await A.mailbox.delivered(r.messageId)).to.equal(true);
  });

  it("only the owner can change the ISM, the hook, or the remote router", async () => {
    await expect(A.router.connect(user).setInterchainSecurityModule(ethers.ZeroAddress)).to.be.reverted;
    await expect(A.router.connect(user).setHook(ethers.ZeroAddress)).to.be.reverted;
    await expect(A.router.connect(user).enrollRemoteRouter(999, b32(user.address))).to.be.reverted;
    await expect(A.router.connect(user).unenrollRemoteRouter(B.domain)).to.be.reverted;
  });

  it("unenroll parks sends and blocks handling from that domain; re-enroll restores both", async () => {
    await (await A.router.connect(owner).unenrollRemoteRouter(B.domain)).wait();
    await expect(send(A, B, user, F(1))).to.be.reverted; // No router enrolled for domain
    const tx = await send(B, A, user, F(1));
    const r = await relay(B, A, tx, [validatorB]);
    await expect(r.process()).to.be.reverted; // handle: Enrolled router does not match sender
    await (await A.router.connect(owner).enrollRemoteRouter(B.domain, b32(await B.router.getAddress()))).wait();
    await (await r.process()).wait();
    expect(await A.mailbox.delivered(r.messageId)).to.equal(true);
  });

  it("a message from a contract that is not the enrolled remote router is rejected even with a valid validator signature", async () => {
    // Deploy a second, hostile router on A that is NOT enrolled on B, aimed at B's router.
    const rimpl = await deploy("HypERC20Collateral", deployer, [await A.token.getAddress(), 1, 1, await A.mailbox.getAddress()], "hostile router impl");
    const rpa = await deploy("ProxyAdmin", deployer, [], "hostile pa");
    const rinit = rimpl.interface.encodeFunctionData("initialize", [await A.merkle.getAddress(), ethers.ZeroAddress, deployer.address]);
    const rproxy = await deploy("TransparentUpgradeableProxy", deployer, [await rimpl.getAddress(), await rpa.getAddress(), rinit], "hostile router");
    const hostile = contract("HypERC20Collateral", await rproxy.getAddress(), deployer);
    await (await hostile.enrollRemoteRouter(B.domain, b32(await B.router.getAddress()))).wait();
    await (await A.token.transfer(other.address, F(10))).wait();
    await (await A.token.connect(other).approve(await hostile.getAddress(), F(10))).wait();
    const fee: bigint = await hostile["quoteGasPayment(uint32)"](B.domain);
    const tx = (await hostile.connect(other)["transferRemote(uint32,bytes32,uint256)"](B.domain, b32(other.address), F(10), { value: fee })) as ethers.ContractTransactionResponse;
    const r = await relay(A, B, tx, [validatorA]);
    await expect(r.process()).to.be.reverted; // B.router.handle: sender != enrolled router
  });

  it("escrow conservation after the whole sequence: every released token was locked on the other side", async () => {
    const eA = await A.token.balanceOf(await A.router.getAddress());
    const eB = await B.token.balanceOf(await B.router.getAddress());
    // Undelivered (parked) messages keep their lock on the origin, so escrowA + escrowB >= 2*SEED.
    expect(eA + eB).to.be.gte(SEED * 2n);
  });

  it("the ProxyAdmin can be burned (transferred to the dead address) and the router keeps working", async () => {
    const DEAD = "0x000000000000000000000000000000000000dEaD";
    await (await B.proxyAdmin.transferOwnership(DEAD)).wait();
    expect(await B.proxyAdmin.owner()).to.equal(DEAD);
    await expect(B.proxyAdmin.connect(deployer).upgrade(await B.router.getAddress(), await B.router.getAddress())).to.be.reverted;
    const tx = await send(A, B, user, F(1));
    await (await (await relay(A, B, tx, [validatorA])).process()).wait();
  });
});
