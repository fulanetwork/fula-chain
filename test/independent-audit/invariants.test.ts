// Independent-audit invariants for FulaRefillTreasury.
//
// 1. Seeded random operation sequences (fuzz) over 3 pools, asserting after EVERY step:
//    - a refill never sends more than the pool's threshold
//    - a non-truncated refill lands exactly at min(target, balance + threshold)
//    - lastRefill advances on every non-zero refill, truncated or not (audit fix A-M1 / F-S4)
//    - previewRefill(i) equals the amount a single refill(i) sends, and bounds each refillAll share
//    - the treasury balance never goes negative and equals initial + funding - sum(out)
//    - every token Transfer whose `from` is the treasury has `to` in {registered pools} ∪ {token}
// 2. ABI surface: every state-changing selector is either refill/refillAll, owner-only, or ownership
//    handover; only refill/refillAll/returnToToken ever emit a token Transfer from the treasury.
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const F = (n: number | string) => ethers.parseEther(String(n));
const ONE_DAY = 24 * 60 * 60;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// Deterministic PRNG (mulberry32) so a failure is reproducible from the seed.
function rng(seed: number) {
    let a = seed >>> 0;
    return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe("FulaRefillTreasury independent-audit invariants", function () {
    this.timeout(600_000);

    async function setup(cooldown: number) {
        const [deployer, owner, anyone, sink] = await ethers.getSigners();
        const Mock = await ethers.getContractFactory("MockERC20");
        const token = await Mock.deploy(F(1_000_000_000));
        const tokenAddr = await token.getAddress();
        const PoolA = await ethers.getContractFactory("MockRefillPool");
        const PoolS = await ethers.getContractFactory("MockRefillPoolStorageToken");
        const pools = [await PoolA.deploy(tokenAddr), await PoolA.deploy(tokenAddr), await PoolS.deploy(tokenAddr)];
        const poolAddrs = await Promise.all(pools.map((p) => p.getAddress()));
        const caps = [F(100_000), F(100_000), F(5_000_000)];
        const thresholds = [F(100_000), F(50_000), F(5_000_000)];
        const Treasury = await ethers.getContractFactory("FulaRefillTreasury");
        const treasury = await Treasury.deploy(tokenAddr, owner.address, cooldown, poolAddrs.map((a, i) => ({ account: a, threshold: thresholds[i], maxThreshold: caps[i] })));
        const tAddr = await treasury.getAddress();
        return { deployer, owner, anyone, sink, token, tokenAddr, pools, poolAddrs, caps, treasury, tAddr };
    }

    for (const [seed, cooldown] of [[1, ONE_DAY], [2, 3600], [3, 7 * ONE_DAY], [4, ONE_DAY]] as const) {
        it(`fuzz seed ${seed}, cooldown ${cooldown}s: 300 random ops keep every invariant`, async function () {
            const { deployer, owner, anyone, sink, token, tokenAddr, pools, poolAddrs, caps, treasury, tAddr } = await setup(cooldown);
            const rand = rng(seed);
            const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
            const allowed = new Set([...poolAddrs, tokenAddr].map((a) => a.toLowerCase()));
            const iface = treasury.interface;

            let treasuryIn = 0n, treasuryOut = 0n;
            await token.transfer(tAddr, F(2_000_000)); treasuryIn += F(2_000_000);
            let paused = false;
            const enabled = [true, true, true];

            for (let step = 0; step < 300; step++) {
                const op = pick(["refill", "refill", "refillAll", "drain", "donate", "fund", "wait", "setThreshold", "toggle", "pauseToggle", "return"] as const);
                const i = Math.floor(rand() * 3);
                const before = { pool: await token.balanceOf(poolAddrs[i]), tre: await token.balanceOf(tAddr), p: await treasury.getPool(i) };
                let receipt: any = null;
                const previews = (op === "refill" || op === "refillAll") ? await Promise.all([0, 1, 2].map((k) => treasury.previewRefill(k))) : null;
                try {
                    if (op === "refill") receipt = await (await treasury.connect(anyone).refill(i)).wait();
                    else if (op === "refillAll") receipt = await (await treasury.connect(anyone).refillAll()).wait();
                    else if (op === "drain") { const b = await token.balanceOf(poolAddrs[i]); if (b > 0n) { const amt = BigInt(Math.floor(rand() * 1e6)) * b / 1_000_000n; if (amt > 0n) await pools[i].drain(sink.address, amt); } }
                    else if (op === "donate") { const amt = F(Math.floor(rand() * 60_000)); if (amt > 0n) await token.transfer(poolAddrs[i], amt); }
                    else if (op === "fund") { const amt = F(Math.floor(rand() * 300_000)); if (amt > 0n) { await token.transfer(tAddr, amt); treasuryIn += amt; } }
                    else if (op === "wait") await time.increase(Math.floor(rand() * 2 * ONE_DAY));
                    else if (op === "setThreshold") { const t = BigInt(Math.floor(rand() * 1e6) + 1) * caps[i] / 1_000_000n; await treasury.connect(owner).setThreshold(i, t); }
                    else if (op === "toggle") { enabled[i] = !enabled[i]; await treasury.connect(owner).setPoolEnabled(i, enabled[i]); }
                    else if (op === "pauseToggle") { if (paused) await treasury.connect(owner).unpause(); else await treasury.connect(owner).pause(); paused = !paused; }
                    else if (op === "return") { const b = await token.balanceOf(tAddr); if (b > 0n) { const amt = BigInt(Math.floor(rand() * 1e6) + 1) * b / 1_000_000n; if (amt > 0n) { receipt = await (await treasury.connect(owner).returnToToken(amt)).wait(); } } }
                } catch (e: any) {
                    // Reverts are legal outcomes (NotBelowThreshold, CooldownActive, EnforcedPause, PoolDisabled,
                    // TreasuryEmpty). They must be one of ours, and must not have moved anything.
                    const data = e?.data ?? e?.info?.error?.data ?? "";
                    let name = ""; try { name = iface.parseError(data)?.name ?? ""; } catch { /* not decodable */ }
                    expect(["NotBelowThreshold", "CooldownActive", "EnforcedPause", "PoolDisabled", "TreasuryEmpty", "ZeroAmount", "InsufficientTreasuryBalance"], `step ${step} op ${op} reverted with ${name || e?.shortMessage}`).to.include(name);
                    expect(await token.balanceOf(tAddr)).to.equal(before.tre);
                    continue;
                }

                if (receipt) {
                    // Every Transfer out of the treasury must go to a registered pool or the token.
                    let outThisTx = 0n;
                    for (const log of receipt.logs) {
                        if (log.address.toLowerCase() !== tokenAddr.toLowerCase() || log.topics[0] !== TRANSFER_TOPIC) continue;
                        const from = ("0x" + log.topics[1].slice(26)).toLowerCase(), to = ("0x" + log.topics[2].slice(26)).toLowerCase();
                        if (from !== tAddr.toLowerCase()) continue;
                        expect(allowed.has(to), `step ${step}: transfer from treasury to unregistered ${to}`).to.equal(true);
                        outThisTx += BigInt(log.data);
                    }
                    treasuryOut += outThisTx;

                    // Refilled events: amount bounds and cooldown bookkeeping.
                    for (const log of receipt.logs) {
                        let parsed: any; try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
                        if (parsed?.name !== "Refilled") continue;
                        const id = Number(parsed.args.poolId), amount: bigint = parsed.args.amount, truncated: boolean = parsed.args.truncated;
                        const p = await treasury.getPool(id);
                        const target = p.threshold * 11000n / 10000n;
                        expect(amount, `step ${step}: amount > threshold`).to.be.lte(p.threshold);
                        expect(amount, `step ${step}: zero refill emitted`).to.be.gt(0n);
                        const after = await token.balanceOf(p.account);
                        expect(after, `step ${step}: pool overshot target`).to.be.lte(target > parsed.args.poolBalanceBefore + p.threshold ? parsed.args.poolBalanceBefore + p.threshold : target);
                        // Every non-zero refill consumes the cooldown, truncated or not (audit fix A-M1 / F-S4).
                        expect(p.lastRefill, `step ${step}: lastRefill not advanced`).to.equal(await time.latest());
                        if (!truncated) {
                            expect(after, `step ${step}: non-truncated refill did not land at min(target, before+threshold)`).to.equal(target - parsed.args.poolBalanceBefore > p.threshold ? parsed.args.poolBalanceBefore + p.threshold : target);
                        } else {
                            expect(await token.balanceOf(tAddr), `step ${step}: truncated but treasury not empty`).to.equal(0n);
                        }
                        // previewRefill must agree with what refill actually sends (single call: exact;
                        // batch: an upper bound, since earlier pools in the batch may have emptied the treasury).
                        if (previews) {
                            if (op === "refill") expect(amount, `step ${step}: preview mismatch`).to.equal(previews[id]);
                            else expect(amount, `step ${step}: batch share exceeds preview`).to.be.lte(previews[id]);
                        }
                    }
                }

                // Global accounting: treasury balance is exactly what came in minus what went out.
                expect(await token.balanceOf(tAddr), `step ${step}: treasury accounting`).to.equal(treasuryIn - treasuryOut);
            }
            // Nothing ever reached the sink or deployer from the treasury.
            expect(await token.balanceOf(anyone.address)).to.equal(0n);
            expect(await token.balanceOf(owner.address)).to.equal(0n);
        });
    }

    it("ABI surface: only refill/refillAll/returnToToken move tokens; every other mutator is owner-only or ownership handover", async function () {
        const { owner, anyone, token, tAddr, treasury } = await setup(3600);
        await token.transfer(tAddr, F(10));
        const mutators = treasury.interface.fragments.filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)) as any[];
        const names = mutators.map((f) => f.name).sort();
        expect(names).to.deep.equal(["acceptOwnership", "pause", "refill", "refillAll", "renounceOwnership", "returnToToken", "setPoolEnabled", "setThreshold", "transferOwnership", "unpause"]);
        for (const f of mutators) {
            if (["refill", "refillAll", "acceptOwnership"].includes(f.name)) continue;
            // Every remaining mutator must reject a non-owner.
            const args = f.inputs.map((inp: any) => (inp.type === "address" ? anyone.address : inp.type === "bool" ? true : 1n));
            await expect((treasury.connect(anyone) as any)[f.name](...args)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
        }
        // acceptOwnership by a non-pending address is rejected too.
        await expect(treasury.connect(anyone).acceptOwnership()).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
        // No payable functions, no receive/fallback: sending ETH reverts.
        expect(mutators.some((f) => f.stateMutability === "payable")).to.equal(false);
        await expect(anyone.sendTransaction({ to: tAddr, value: 1n })).to.be.reverted;
        void owner;
    });
});
