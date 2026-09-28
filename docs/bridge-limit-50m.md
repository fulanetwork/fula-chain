# Raising the Ethereum↔Base bridge to 50M FULA per day — what would have to change

Status: **analysis only, nothing changed** (owner decision 2026-09-27: "leave changing limits aside
and unchanged"). This records what the "5M daily limit" actually is, what the chain says today, and
the exact steps if the decision is revisited.

## 1. There is no 5M *daily* limit on chain

Live reads of both `FulaOFTAdapter`s on 2026-09-27 (ad-hoc ethers script against public RPCs;
re-confirm with `verifyOAppConfig.ts` before acting on any of this):

| | Ethereum adapter `0x170c553e…` | Base adapter `0x154b9654…` |
|---|---|---|
| `rateLimits` (outbound, departures) | 200,000,000 / 24h | 200,000,000 / 24h |
| `inboundRateLimits` (releases from escrow) | 25,000,000 / 24h | 25,000,000 / 24h |
| `availableLiquidity()` (escrow) | **2,292,142 FULA** | **32,709,912 FULA** |

The repo docs still describe the inbound bucket as 20M/24h (`bridge-audit-escrow.md` lines 111, 120,
259, 265; `bridge-liquidity-runbook.md` line 105; `bridge-mainnet-readiness.md` lines 77, 82, 83).
The chain says 25M. Treat the chain as authoritative and update those lines when the limit is next
touched.

The two places where "5M" really exists:

1. **The bridge page's per-transfer cap** — `fulawebsite/bridge/index.html:377`
   `UI_MAX: 5000000n * ONE` ("per-transfer limit" in the limits line). Pure front-end; the contracts
   accept larger transfers.
2. **The refill treasury's escrow threshold** — `scripts/RefillTreasury/config.ts:30`
   `BRIDGE_CAP = 5_000_000` (threshold = maxThreshold = 5M for both escrow pools, immutable per
   deployment). This only governs how far `FulaRefillTreasury` tops an escrow back up (to 5.5M, at
   most once per 24h). It is not a transfer limit.

## 2. What actually binds today

- **Escrow liquidity, not limits.** A transfer to Ethereum larger than 2.29M parks on arrival
  (`InsufficientLiquidity`) regardless of any limit. Toward Base the ceiling is 32.7M.
- **The Ethereum inbound limiter is inert.** `_credit` checks liquidity before the inbound bucket,
  so a limit (25M) above the escrow (2.29M) can never fire; a forged or maliciously authorised
  message can take the whole Ethereum escrow. `verifyOAppConfig.ts` flags exactly this
  (sizing check at lines 313–319). Policy in `bridge-liquidity-runbook.md`: inbound limit = 10–25% of
  escrow.
- **All three refill treasuries hold 0 FULA** (2026-09-28), so the treasury cannot top either escrow
  up until governance funds it.

## 3. Steps to move 50M/day (per transfer and per day)

Order matters: seed first, then raise the limit, then the page. Each step is verifiable on chain.

1. **Seed the escrows** so that 50M inbound stays inside the 10–25% policy: 200M–500M per side.
   At 200M: Ethereum needs ≈197.7M more, Base ≈167.3M more. Source is the token's own balance via
   governance `transferFromContract(adapter, amount)` on each chain — the adapters already received
   their initial escrow this way. Each call is bounded by the caller role's `transactionLimit`
   (`StorageToken.sol:165`, revert `LowAllowance`), so split into as many calls as that limit
   requires. Escrowed FULA is not circulating; `reconcileSupply.ts` must still balance afterwards.
2. **Raise the inbound bucket** on both adapters to 50M / 86400s. Owner is the 2-of-2 Safe
   `0x3167688A…7341`, so produce calldata, do not send:
   ```
   set DRY_RUN=1 && set ADAPTER=0x170c553e… && set EID=<Base eid> && set INBOUND=50000000 && yarn hardhat run scripts/bridge/setLimits.ts --network mainnet
   set DRY_RUN=1 && set ADAPTER=0x154b9654… && set EID=<Ethereum eid> && set INBOUND=50000000 && yarn hardhat run scripts/bridge/setLimits.ts --network base
   ```
   (`WINDOW` defaults to 86400; leave `OUTBOUND` unset — 200M/day already exceeds 50M.) Two Safe
   transactions, one per chain. `setLimits.ts` fails closed on an untrimmed `DRY_RUN` on purpose.
3. **Raise the page cap**: `UI_MAX` 5M → 50M in `fulawebsite/bridge/index.html:377`. Deploys on push.
4. **Optional — treasury cap.** The treasuries' 5M escrow threshold is immutable; a 50M cap needs
   new deployments (`BRIDGE_CAP` in `scripts/RefillTreasury/config.ts`, redeploy, re-whitelist, 48h).
   Owner decision 2026-09-27: keep 5M and seed manually.

Verification after each step: `REMOTE=<other> ADAPTER=<this> REMOTE_ADAPTER=<other adapter> yarn
hardhat run scripts/bridge/verifyOAppConfig.ts --network <net>` on both chains (must report the
inbound limit inside 10–25% of escrow, peers locked, DVN set unchanged), then `yarn bridge:reconcile`.

## 4. What does not need to change

- Outbound limits (200M/day both directions).
- DVN configuration, peers (locked), the adapters' code.
- The refill treasury registrations (escrows stay pools 1 / 4).
