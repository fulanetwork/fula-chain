# FulaRefillTreasury: independent audit

Date: 2026-09-22. Subject: `contracts/core/FulaRefillTreasury.sol` (solc 0.8.24, viaIR, optimizer 200,
OpenZeppelin 5.3.0). Deployed-bytecode keccak256 of the audited artifact:
`0xfd7fe4bd6cdb73cd488efb78f83b8db946097067565e364b46703d0fcbff7651` (4,703 bytes).

Why this document exists: `03-audit.md` was written by the contract's author. This pass was run so
that reviewers who never saw the author's reasoning could try to break the contract. Each reviewer
received the source with all comments stripped, the threat model, the token and pool sources, and a
different lens. None received `03-audit.md`, the runbook, the deployment records, git history, or
(for the security lenses) the existing test file. Every reviewer had to end with an explicit answer
to the owner's question and list every file it opened.

The owner's question, verbatim: "if we put a large token amount in the contract, no one can either
misplace the tokens (for example withdraw to an unauthorized wallet or address) and also no one can
front-run or do anything that misplaces the tokens to an unauthorized address."

## 1. Tooling results

### Slither 0.11.6 (solc 0.8.24, `--via-ir --optimize --optimize-runs 200 --evm-version shanghai`)

20 results, 102 detectors, no High or Medium on the contract. Every hit on the contract:

| Detector | Lines | Disposition |
|---|---|---|
| incorrect-equality (`amount == 0`) | 292 | Rejected: `amount` is a computed transfer size; zero means "nothing to send" and is exactly the case to stop on. Not a balance equality check. |
| calls-loop (`balanceOf` inside `refillAll` loop, staticcall inside constructor loop) | 280, 312, 329 | Accepted: the loop is over the constructor-fixed pool list (2 to 5 entries). Bounded gas, no unbounded growth. |
| timestamp (cooldown comparisons) | 258, 285 | Accepted: a 24h cooldown tolerates the seconds of miner drift the detector warns about. `getPool`/`targetOf` are false positives (index bound checks). |
| low-level-calls (`staticcall` in `_getterReturns`) | 329 | Accepted, intended: the probe must not revert on a target without the getter. Return length and high bits are checked. |
| cyclomatic-complexity (constructor = 12) | 129-158 | Info: it is a validation chain; each branch is a distinct revert reason and is unit-tested. |
| missing-zero-check (`Ownable2Step.transferOwnership`) | OZ | Dependency; a zero pending owner can never call `acceptOwnership`. |
| assembly, dead-code, pragma, solc-version, unindexed-event-address | OZ only | Dependency noise. |

### solhint (`solhint:recommended`, scratch config)

67 warnings, 0 errors. All are `use-natspec` (missing `@param`/`@notice` on the guardian and view
functions) and `gas-strict-inequalities` (`>=` used for index bounds). No security rule fired.
Disposition: NatSpec gaps recorded as Info (finding I-1); the inequalities are correct as written.

### Storage layout (from `artifacts/build-info`)

```
slot 0  _owner (address)            slot 1  _pendingOwner (address) | _paused (bool @20)
slot 2  _status (ReentrancyGuard)    slot 3  _pools (Pool[])          slot 4  _poolIdPlusOne
Pool: 96 bytes = 3 slots: [account @0 | lastRefill uint64 @20 | enabled bool @28] [threshold] [maxThreshold]
```

### Gas (hardhat-gas-reporter, 24-test suite)

| Method | Min | Max | Avg |
|---|---|---|---|
| refill | 56,346 | 104,351 | 75,170 |
| refillAll (2 pools) | 40,951 | 103,769 | 59,151 |
| returnToToken | 56,825 | 61,028 | 60,419 |
| setThreshold | 35,276 | 35,300 | 35,292 |
| setPoolEnabled | | | 32,492 |
| pause / unpause | | | 47,017 / 24,795 |
| deploy | 1,266,165 | 1,363,390 | 1,308,912 |

Deployed size 4.593 KiB (init 6.404 KiB), far under the 24 KiB limit.

### Invariant fuzz (`test/independent-audit/invariants.test.ts`)

Four seeded runs (cooldown 24h, 0, 1h, 24h), 300 random operations each drawn from
{refill(i), refillAll, drain pool, donate to pool, fund treasury, time jump, setThreshold within cap,
enable/disable, pause/unpause, returnToToken}. After every operation:

- every token `Transfer` whose `from` is the treasury has `to` in {registered pools} ∪ {token}
- every `Refilled.amount` ≤ that pool's threshold and > 0
- a non-truncated refill lands the pool at exactly `min(target, before + threshold)`
- `lastRefill` advances iff the refill was not truncated; a truncated refill leaves the treasury at 0
- the treasury balance equals inflows minus outflows at every step
- every revert is one of the contract's own documented errors and moves nothing

Result: all 1,200 operations passed; the "anyone" caller and the owner ended with a zero balance.
ABI-surface test: the only state-changing functions are `refill`, `refillAll`, `returnToToken`,
`pause`, `unpause`, `setThreshold`, `setPoolEnabled`, `transferOwnership`, `acceptOwnership`,
`renounceOwnership`; every one except the first two and `acceptOwnership` rejects a non-owner;
nothing is payable; sending ETH reverts.

## 2. Independent reviewer findings

### Lens B: arithmetic, casts, cooldown state machine (NVIDIA Nemotron 3 120B, stripped source pasted)

Answer to the owner's question: NO, tokens cannot leave to any other address; the only transfers are
`safeTransfer(p.account, …)` with `p.account` from the constructor-populated array, and
`returnToToken` to `address(token)`.

| id | lines | severity | finding | disposition |
|---|---|---|---|---|
| B-1 | 307-311 | Info | The `unchecked` subtraction in `_amountFor` relies on the `balance >= threshold` guard at the call sites; if a future edit dropped that guard the subtraction would wrap. | Fixed: subtraction moved out of `unchecked` (multiplication stays unchecked, provably safe by `MAX_THRESHOLD`). Cost is one checked SUB. |
| B-2 | 286 | Low | `CooldownActive(poolId, uint64(lastRefill + cooldown))` truncates if both operands are near `2^64`; the comparison itself is done in 256 bits so only the error argument could mislead. | Fixed: error argument widened to `uint256`. |
| B-3 | constructor, `cooldown` | Medium (configuration) | With `cooldown == 0` a compromised pool could be drained at one threshold per transaction. | Fixed together with C-L3 / D-Q7 / E-1: the constructor now rejects any cooldown outside [1 hour, 30 days], so zero can no longer be deployed. Mainnet config is 24h (owner reconfirmed 2026-09-22). |
| B-4 | `refillAll` total | Low | Suggested `total` could wrap. | Rejected: the addition is checked (0.8 default) and each term ≤ `MAX_THRESHOLD`. |
| B-5 | `previewRefill` | Info | Returns 0 while paused although `refill` reverts. | Accepted: documented behaviour ("what would happen right now"); the status script relies on it. |
| B-6 | `poolIdOf` | Info | `UnknownPool(type(uint256).max)` as the "not registered" sentinel is unconventional. | Not taken (see consolidated row 15). |
| B-7 | `_refill` | Info | CEI and `nonReentrant` confirmed; no reentrancy path. | Holds. |

Not examined by this lens (its relay flagged the omissions): the fastest drain schedule under a
compromised pool given the truncated-refill rule, huge `cooldown`, the `_poolIdPlusOne` off-by-one,
the constructor loop, and revert-forever paths. Those are covered by lenses A, D, E and F.

### Lens D: gas and code quality (fresh subagent with the test file; measured with the gas reporter and build-info)

Answer: NO through this contract's own code; the only movements are `safeTransfer(p.account, …)`
(account set solely in the constructor) and `safeTransfer(address(token), …)`, no approve, value
call, delegatecall, selfdestruct, receive or fallback. Caveat it raised: if the token's governable
`platformFeeBps` is ever set above zero, the token itself diverts that fraction of every transfer to
the token's fee Treasury, which is neither a pool nor the token. The fee is 0 today.

| id | lines | severity | finding | disposition |
|---|---|---|---|---|
| D-Q7 | 86, 135 | Low | `cooldown` is immutable, unbounded and has no setter: a mistyped constructor value (e.g. seconds vs days) would freeze every pool after its first refill, forever, and the only remedy is redeploy. | Fixed: `MAX_COOLDOWN = 30 days`, constructor reverts `CooldownTooLong` above it. |
| D-G2 | 280, 301-302, 285-286 | Gas | `p.account` read from storage three times and `p.lastRefill` twice per refill; the reads after the external calls cannot be merged by the optimizer. | Fixed: both cached once from the already-warm slot. |
| D-G6 | 164, 171 | Gas | `nonReentrant` runs before `whenNotPaused`, so a paused call pays the guard's SSTORE before reverting. | Fixed: modifier order swapped. `onlyOwner` on the `renounceOwnership` override is redundant with Ownable's but kept so a non-owner gets `OwnableUnauthorizedAccount` before the pause check. |
| D-G5 | 156, 175 | Info | `unchecked { ++i; }` is redundant since solc 0.8.22 auto-unchecks loop counters. | Fixed: plain `++i` for readability. |
| D-Q1 | header L39 | Info (NatSpec) | "Refill never reverts for lack of treasury balance" is only true of `refillAll`; `refill(id)` reverts `TreasuryEmpty` on an empty treasury. | Fixed: comment corrected. |
| D-Q2 | header L28, L32 | Info (NatSpec) | "bringing it to threshold × 1.10" is false when the pool is below 10% of threshold (it lands at threshold); "never redirect funds anywhere else" ignores the token fee. | Fixed: both caveats stated in the header. |
| D-Q5 | 143, 236 | Info | `InvalidThreshold` reused for the `maxThreshold > MAX_THRESHOLD` case; `poolIdOf` reverts with a `uint256` sentinel for an address lookup. | Not taken (see consolidated row 15). |
| D-G1 | 90, 165, 172, … | Gas (~2.1k per refill, ~3%) | `Pool[]` costs a cold length SLOAD and a bounds check on every entry; a `mapping` plus immutable `poolCount` would avoid it. | Not taken: a storage-shape rewrite late in the audit buys 3% and re-opens every reviewed line. Recorded for a future version. |
| D-G3 | 312 | Gas (~1-1.5k per extra pool in refillAll) | `balanceOf(this)` is called once per pool inside `refillAll`; it could be read once and decremented. | Not taken: conflicts with the live-read rule (amounts always from `balanceOf`, never internal accounting), which is the property the fuzz proves. |
| D-G4 | 67-68 | Gas (deploy ~20k per pool) | `threshold`/`maxThreshold` are bounded to 128 bits but stored as two `uint256` slots. | Not taken: changes the `getPool` ABI and the layout after the Sepolia rehearsal; deploy-only saving. |
| D-G7 | 50 | Info | `ReentrancyGuardTransient` would save ~2k per call but needs Cancun on all three chains; config pins `shanghai` and SKALE support is unverified. | Not taken. |
| D-G8, D-G9 | 98, 101, 216 | Info | Un-indexing `caller` in events; dropping the pre-check in `returnToToken`. | Not taken: indexed caller is what keeper monitoring filters on; the pre-check gives a typed error on an owner-only path. |
| D-Q3, D-Q4 | 245-260 | Info | `targetOf` never used internally; `previewRefill` re-implements `_refill` eligibility, so the two could drift. | Q4 mitigated by a new invariant test asserting `previewRefill(i)` equals the amount `refill(i)` actually sends for every fuzz step; Q3 cosmetic, not taken. |
| D-Q6, D-Q8 | 323, 165+ | Info | Helper visibility; five copies of the bounds check; dated "agreed 2026-09-22" in source comments. | Bounds check factored into `_checkPool(poolId)`; date removed from the source; helpers made private. |
| D-T1 | tests | Info | Missing: 5-pool `refillAll` gas case, threshold of 1 wei, re-enable path, a weak `not.equal(undefined)` assertion. | Partly: the re-enable path and boundary cases are covered by lens E; the 5-pool gas case and the 1-wei threshold test were not added. |

### Lens A: fund safety, access control, owner as adversary, front-running (fresh subagent; 9 PoC tests in `test/independent-audit/lensA-fundsafety.test.ts`, all passing)

Answer: NO; the only two `safeTransfer` sites have hard-coded destinations (immutable token;
`_pools[poolId].account` written solely by the constructor), there is no approve, call, delegatecall
or pool-mutation function, bounds checks precede every pool lookup, and the mutating ABI has no other
token-moving entry. Same fee caveat as lens C.

Full inventory produced: every external call (constructor staticcalls, `balanceOf`, the two
`safeTransfer`s), every storage write (constructor pushes, `threshold`, `enabled`, `lastRefill`,
`_paused`, `_status`, OZ ownership slots), and both outflow paths.

| id | lines | severity | finding | disposition |
|---|---|---|---|---|
| A-M1 | 299, 307-317, config | **Medium** (author-disagreement: `03-audit.md` row 7 called the truncated-refill rule "correct") | For the bridge escrows threshold = 5M is at or above the whole per-chain treasury, so a refill is truncated; a truncated refill does not set `lastRefill`, so a compromised escrow could take every later deposit in the next block with no time gate for the guardian. PoC: 3M treasury emptied by one refill, `lastRefill` stays 0, the next 1M deposit taken in the next block; with treasury > threshold the brake engages. | **Fixed: every non-zero refill now consumes the cooldown, truncated or not.** Trade-off accepted: after refunding an empty treasury a pool may wait up to one cooldown, and a 1-wei donation to an empty treasury can burn a pool's cooldown once (bounded delay, no loss, dust stays in the pool). The `truncated` event flag is kept for monitoring. |
| A-M3 | 183, 209 | Low-Medium (agy rates Info) | `pause()` followed by loss of the owner key locks refills forever: no timeout, no permissionless unpause; the same state is reachable by transferring ownership to an accepter that never unpauses. Owner is an EOA. | **Fixed: a pause expires after `MAX_PAUSE` = 30 days**; the guardian can re-pause at any time to extend. OZ `Pausable` replaced by a timestamp-based pause so the expiry is enforced in the modifier, not by anyone's action. |
| A-M2 | 208-211 | Low (agy rates Info) | After `renounceOwnership` nobody can disable a compromised pool or retire migrated pools; remaining FULA is stranded. | Accepted, documented intent; the runbook now says renounce only once every registered pool is final and the token's blacklist power is no longer a concern. |
| A-L1 | 164, 214 | Low | A `refill` can front-run `returnToToken(fullBalance)` so it reverts `InsufficientTreasuryBalance`; a single refill can pre-empt `pause`. | Accepted: pause first (pause does not gate `returnToToken`), then return what remains; documented. |
| A-L2 | 135 | Low | Unbounded `cooldown` (same as D-Q7, C-I6). | Fixed by the constructor bound. |
| A-L3 | 173-176 | Low | Blacklisted pool bricks `refillAll` (same as C-L2). | Accepted. |
| A-I1 | 129, 214 | Info | The owner is the token's ADMIN_ROLE holder; a compromised owner can only relocate the treasury into the token contract, where extraction needs the token's whitelist + quorum + limit. Concentration, not misplacement. | Documented. |
| A-I2 | 145 | Info | The getter probe accepts any contract answering the token address; verify `PoolRegistered` events against `config.ts` before funding. | Runbook step added. |

Considered and not exploitable (each with a test or a line-level argument): reentrancy, poolId
manipulation, the `unchecked` block, truncation abuse when the treasury is rich, donations, SKALE
spam (stateless reverts, no extractable value), pendingOwner tricks, pool internal accounting.

### Lens C: ERC20 integration and external calls (fresh subagent; 17 PoC tests in `test/independent-audit/lensC-erc20.test.ts`, all passing, run against the real StorageToken proxy)

Answer: YES only as the token's own platform fee; no caller, front-runner or compromised treasury
owner can name a destination. Outflow paths found: (1) refill to a registered pool, (2)
`returnToToken` to the token, (3) if token governance ever sets `platformFeeBps` (impossible today:
the token's `ChangeTreasuryFee` proposal never stores the amount, so it can only set 0; a token
upgrade could change that), that fraction of any transfer goes to the token's fee Treasury, whose
only exit is back to the token contract.

| id | lines | severity | finding | disposition |
|---|---|---|---|---|
| C-L1 | 301, 218 | Low | Fee-on-transfer split by the token: pool lands short, fee sits in the token's fee Treasury, cooldown consumed. Unreachable through current token governance. | Accepted and documented (bounded by the fee cap, sink forwards only to the token). Not re-probing the pool balance after transfer, because waiving the cooldown on a short landing would let a self-draining pool bypass the brake. |
| C-L2 | 301, 218 | Low | Token governance blacklisting the treasury freezes it; blacklisting one pool bricks `refillAll` until that pool is disabled, permanently if the owner has renounced. Single `refill` unaffected. | Accepted: keepers fall back to per-pool `refill`; runbook says do not renounce while blacklisting is a live token power. |
| C-L3 | 141-145, 285-299 | Low | Pool trust is decided once; a pool proxy upgraded or compromised later keeps receiving one threshold per cooldown; with `cooldown = 0` it drains the whole reserve (PoC: 5× threshold reserve emptied in a loop; with 24h the loop stops at one threshold). | Fixed: constructor now requires `MIN_COOLDOWN (1 hour) <= cooldown <= MAX_COOLDOWN (30 days)`. Guardian keeps `setPoolEnabled(false)`. |
| C-I1 | 328-334 | Info | The getter probe is a typo-catcher, not authorization: any contract answering a clean 32-byte token address to any selector passes. | Documented in the runbook; correctness of the pool list rests on the dry run and the deployer. |
| C-I2 | 164-171, 299-301 | Info | Reentrancy: a hooked token re-entering `refill` on a different eligible pool is blocked only by the guard, which holds. | Holds. |
| C-I3 | 280, 312 | Info | Donations to a pool make it ineligible; donations to the treasury only raise what is available. | Holds. |
| C-I4 | 301; OFT adapter | Info | Refilling the bridge escrow turns reserve into bridge liquidity that can only leave as legitimate releases to users who locked on the other chain, bounded by the inbound rate limit. StakingPool and TestnetMiningRewards have no internal ledger a refill can desync (PoC: `totalAllocation` unchanged). | Holds; threshold and cooldown for the adapter should be read against the inbound rate limit. |
| C-I5 | 214-220 | Info | `returnToToken` works while paused; funds return to the token where only its ADMIN quorum can move them. Token UUPS governance is the trust root above this contract. | Holds, documented. |
| C-I6 | 285-288 | Info | `cooldown = uint64.max` makes every pool refillable once. | Fixed by the same bound as C-L3. |

Confirmed holding, each backed by an executed test: SafeERC20 semantics against this token (reverts
bubble with original data), zero amount never reaches the token, token pause blocks outflows
atomically, exact amount math and the truncated flag, no unguarded external call, all constructor
rejections, owner surface bounds, and that the only permanent-revert paths are token governance or a
lost owner while paused.

### Lens E: test-coverage gaps (fresh subagent with the test file; 31 new tests in `test/independent-audit/lensE-coverage.test.ts`, all passing, 55/55 together with the original suite)

Answer: NO at this contract's level, with the same token-fee caveat.

Branch map: every `if`/`revert`/`return`/modifier path in the contract is now exercised by a named
test. Previously untested and now covered: zero pool address; the treasury's own address as a pool
(predicted CREATE address); 64-byte and dirty-high-bit getter returns; `PoolRegistered` arguments;
`refill` return value; `refillAll` skipping a pool in cooldown; `Refilled` with non-zero
`poolBalanceBefore`; the exact `available == amount` boundary; the cooldown boundary at exactly
`lastRefill + cooldown` (reverts one second before, succeeds at); `previewRefill` for truncated and
empty cases and a full `previewRefill == refill.staticCall` matrix; `poolIdOf` arguments;
`MAX_THRESHOLD` end-to-end; partial-fill sequences; `refillAll` reentrancy; pause/unpause events and
double-pause; configuration changes while paused; re-enable; `setThreshold` below current balance
and not resetting `lastRefill`; `returnToToken` of the full balance; Ownable2Step edges (events,
pending overwrite, non-pending accept, renounce clearing pending, renounce with a disabled pool);
treasury blacklisted; token contract blacklisted; fee on `returnToToken` and on `refillAll`; the real
StorageToken paused by its governance `emergencyAction` (all three outflows revert with the token's
error, `previewRefill` is blind to it, unpause after the 30-minute cooldown restores).

| id | lines | severity | finding | disposition |
|---|---|---|---|---|
| E-1 | 129, 285 | Low | `lastRefill == 0` is compared as a real timestamp, so a `cooldown` ≥ `block.timestamp` (an absolute timestamp passed where a duration was meant) makes every pool `CooldownActive` from deployment. Funds recoverable via `returnToToken`; redeploy needed. | Fixed by the constructor bound (`MAX_COOLDOWN` = 30 days). |
| E-2 | header L28 | Info | "bringing it to threshold × 1.10" is not always true (same as D-Q2). | Fixed in the header. |
| E-3 | 251-260 | Info | `previewRefill` is blind to token-level rejections (token paused, treasury or pool blacklisted): returns non-zero while `refill` would revert. | Accepted: keepers should simulate (`refillAll.staticCall`); noted in the script and runbook. |
| E-4 | events | Info | Events report the gross amount; with a fee the recipient gets less, on `returnToToken` too. | Accepted, documented. |
| E-5 | 208-211 | Info (Nemotron would say Medium) | Renouncing with a pool disabled leaves it disabled forever. | Accepted, documented (same as A-M2). |
| E-6 | token | Info (Nemotron would say High) | Token governance blacklisting the treasury freezes it; blacklisting the token's own address bricks `returnToToken` only. Reversible, outside this contract. | Accepted, documented (same as C-L2). |

Reviewer disagreement surfaced: Nemotron rates E-5 Medium and E-6 High; lenses A, C, E and agy
rate them Info/Low because both require an intentional or reversible action by a trusted party and
never move funds to a third address. Recorded here for the owner.

Lens D's "checked and correct" list independently confirms: the `unchecked` multiplication bound
(product < 2^142), zero-amount transfers never attempted, CEI ordering and guard placement,
timestamp casts, immutables/constants/errors/events all used, constructor-only helpers absent from
runtime bytecode, the probe rejecting empty/malformed/non-address returns, dedup logic, and cached
loop bounds.

## 3. Consolidated findings and disposition

Deduplicated by root cause. Every Medium is fixed; nothing was accepted without a stated reason.

| # | root cause | raised by | severity (highest given) | disposition |
|---|---|---|---|---|
| 1 | Truncated refill did not consume the cooldown, so a pool whose threshold ≥ reserve (the bridge escrows) could siphon every later deposit with no time gate. | A-M1, F-S4 (agy concurred with F) | Medium | **Fixed**: every non-zero refill sets `lastRefill`. Regression tests in the main suite, lens A, lens F, the fuzz, and the Sepolia rehearsal. `03-audit.md` row 7 is superseded. |
| 2 | `cooldown` unbounded: 0 removes the only brake on a compromised pool; a huge value or an absolute timestamp freezes every pool forever; the value is immutable. | B-3, C-L3, C-I6, D-Q7, E-1, F-S3, F-C5, A-L2 | Medium (config) / Low | **Fixed**: constructor requires 1 hour ≤ cooldown ≤ 30 days (`CooldownOutOfRange`). |
| 3 | Pause + lost owner key = permanent lock (no timeout, no permissionless exit). | A-M3 (agy: Info) | Low-Medium | **Fixed**: a pause expires after 30 days (`pausedUntil`); the guardian can re-pause. OZ `Pausable` replaced by a timestamp check; error and event names kept (`EnforcedPause`, `ExpectedPause`, `Paused(account, until)`, `Unpaused`). |
| 4 | `unchecked` subtraction in `_amountFor` relied on a guard elsewhere. | B-1 | Info | Fixed: subtraction is checked; only the provably safe multiplication stays unchecked (in `_target`). |
| 5 | `CooldownActive` reported a `uint64`-truncated timestamp in an edge case. | B-2, D-Q8 | Low | Fixed: `uint256`. |
| 6 | Redundant storage reads of `account`/`lastRefill`; modifier order paid the reentrancy SSTORE before the pause check; redundant `unchecked { ++i; }`; five copies of the bounds check; helpers not private. | D-G2, D-G6, D-G5, D-Q8, D-Q6 | Gas / Info | Fixed. |
| 7 | Header comments overstated "lands at 1.10×" and "never anywhere else" (token fee), and "refill never reverts for lack of balance". | D-Q1, D-Q2, E-2 | Info | Fixed in the header; NatSpec added on all public functions (solhint `use-natspec` clean). |
| 8 | Token-level fee would divert a slice of every transfer to the token's fee Treasury. | C-L1, D, E-4, F-S1, A-I1 | Low | Accepted: 0 today and unreachable through the token's current governance path; documented in the header and runbook. |
| 9 | Token-level blacklist of the treasury freezes it; of one pool bricks `refillAll` (permanently after renounce). | C-L2, A-L3, E-6 (Nemotron: High) | Low | Accepted: reversible by token governance; keepers fall back to per-pool `refill`; runbook says do not renounce while that power is live. |
| 10 | Renounce strands config (disabled pools, thresholds) and removes `returnToToken`. | A-M2, E-5 (Nemotron: Medium) | Info | Accepted, documented intent; runbook: renounce only once pools are final. |
| 11 | `refill` can front-run a full-balance `returnToToken` or pre-empt a `pause` by one threshold. | A-L1 | Low | Accepted: emergency order is pause first, then return; documented. |
| 12 | Getter probe is a typo-catcher, not authorization. | C-I1, A-I2 | Info | Documented; runbook step to verify `PoolRegistered` events against `config.ts` before funding. |
| 13 | `previewRefill` blind to token-level rejections; returns 0 while paused. | E-3, B-5 | Info | Accepted; keepers simulate `refillAll`; a fuzz invariant now asserts `previewRefill` equals what `refill` sends. |
| 14 | Structural gas ideas: mapping instead of array (~3%), single `balanceOf` per batch, `uint128` pair, transient reentrancy guard, un-indexing `caller`. | D-G1, D-G3, D-G4, D-G7, D-G8 | Gas | Not taken, reasons in lens D table. |
| 15 | Cosmetic renames (`UnknownPoolAccount(address)`, `MaxThresholdTooHigh`). | B-6, D-Q5 | Info | Not taken: would churn three reviewer test files for no behavioural gain; recorded. |

Reviewer disagreements surfaced to the owner: Nemotron rates the token-blacklist dependency High
and the renounce consequences Medium; every other reviewer rates them Info/Low because both need an
intentional or reversible act by an already-trusted party and never move funds to a third address.
agy rated A-M1 a genuine rate-limit bypass; the built-in reviewer called it "bounded by inflows".
It was fixed regardless, since the bridge-escrow sizing makes the bound equal to every deposit.

## 3b. Verification after the fixes

Audited artifact: deployed-bytecode keccak256
`0xd908dce7bdb6b6f47d17a91a06564d0149edd0307605a04b254986407cf3c193` (4,771 bytes), size 4.659 KiB.
(The hash at the top of this document is the pre-fix artifact the reviewers received.)

- `yarn test:refill`: 118 passing across six files: the original suite (26), invariants/fuzz (5),
  lens A (10), lens C (18), lens E (33), lens F (26). Every reviewer PoC that demonstrated a finding
  was rewritten by a separate agent into a regression test of the fix, with assertions strengthened
  (`withArgs` on every `CooldownActive`, exact expiry boundaries pinned with `setNextBlockTimestamp`).
- Coverage (solidity-coverage, instrumented build): main suite alone 98.9% statements / 94.4%
  branches / 100% functions and lines; independent-audit suites 100% / 97.2% / 100% / 100%. The four
  seeded fuzz tests fail only under instrumentation; they pass in the normal build. Cause (verified):
  under the instrumented build a legitimate revert (e.g. refilling an ineligible pool) is surfaced
  with no error data, and the fuzz asserts that every revert decodes to one of the contract's named
  errors, so the assertion fails on `undefined`. A harness artifact, not a contract behaviour.
- Slither re-run on the final source: same informational categories only (strict equality on
  `amount == 0`, bounded calls-in-loop, timestamp use in cooldown and pause, intended low-level
  staticcall, constructor complexity 13); one new `unindexed-event-address` on `Paused(address,uint64)`
  (kept unindexed on purpose: it is a rare guardian event, and indexing costs the reader nothing).
- solhint: NatSpec warnings resolved by the added `@notice`/`@param` tags; `gas-strict-inequalities`
  hits are the intentional `>=` bounds checks.
- Storage layout after the fixes: slot 0 `_owner`, slot 1 `_pendingOwner` (OZ `_paused` no longer
  packed beside it), slot 2 `_status`, slot 3 `_pools`, slot 4 `_poolIdPlusOne`, slot 5 `pausedUntil`
  (uint64, new slot). `Pool` is still 3 slots.
- `npx tsc --noEmit`: clean for the contract's own test and scripts. The four reviewer test files
  use the untyped-`Contract` pattern of the repo's older tests, which strict `tsc` flags but Hardhat
  (transpile-only) runs; left as-is to avoid churning reviewer-authored files.
- Dry runs (`yarn refill:dryrun:base|skale|ethereum`): pass with the 24h cooldown inside the new
  bound; deploy gas 1.72M / 1.51M / 1.40M.
- Sepolia rehearsal on the audited bytecode, 21/21 steps passed (`yarn refill:rehearse:sepolia`,
  record `deployments/FulaRefillTreasury_rehearsal_sepolia_1790068386955.json`): treasury
  `0x221bcd9E1787b9aB5D836B0dD6252585Dc267382`, deploy tx `0xb1bb2d1c…95fee15d`, 1,572,802 gas, four
  stand-in pools (the fourth pre-funded exactly at threshold so the batch skips it and it can exercise
  the truncation steps untouched by the 1-hour cooldown), 0.0031 Sepolia ETH spent. Live-proven on the
  real testnet FULA token: constructor rejects an EOA pool and a zero cooldown (revert names decoded via
  `eth_call`), funding via `transferFromContract`, previews, batch refill of three pools to exact
  amounts (171,440 gas), full pool reverts `NotBelowThreshold`, cooldown blocks a drained pool and
  `previewRefill` reports 0, non-owner pause rejected, refills revert `EnforcedPause`, renounce refused
  while paused, `returnToToken` while paused, threshold cap, **truncated refill sets `lastRefill` and a
  refund is then blocked by `CooldownActive` (the A-M1/F-S4 fix)**, disabled pool reverts, cleanup to 0.
  The live one-hour cooldown wait is skipped unless `WAIT_COOLDOWN=1`; the `TreasuryEmpty` branch is
  unreachable live within the cooldown and is covered by unit tests. Two earlier runs on the same
  bytecode stopped on rehearsal-script issues (a stale read from a lagging public RPC node, a step that
  used a pool inside its cooldown); the script now retries state checks. Every abandoned rehearsal
  treasury was drained back to the token contract via `returnToToken`.

## 4. Answer to the owner's question

Six review passes (four fresh reviewers with no access to the author's reasoning, one
arithmetic-focused model on the stripped source, one red team whose only goal was to move funds to a
wrong address), Slither, solhint, a 1,200-step seeded fuzz, and a Sepolia rehearsal all reached the
same conclusion. Honest scope of "independent": lenses A, C, D, E and F were fresh Claude subagents
(no prior context, comments stripped, different briefs) and so share the author's model family;
Nemotron (lens B) was the only uncorrelated model that reviewed the revised source; the Google
reviewer refused the ERC20 lens and contributed only as a secondary inside some subagents. A human
audit has not been done.

**No.** Through this contract's own code, FULA can only ever go to a pool address fixed in the
constructor (permissionless `refill`, at most one threshold per pool per cooldown, only while the
pool is below threshold) or to the token contract (owner-only `returnToToken`). There is no function
that takes a destination, no way to add a pool, no upgrade, no delegatecall, no fallback. A
front-runner can only make the same transfer happen first or make a single `refill(id)` revert; it
can never change where tokens go. A compromised owner can pause (30 days at a time), disable a pool,
lower a threshold, or push funds back into the token contract, where only the token's two-admin
governance can move them further.

Two residual dependencies remain, both outside this contract and both documented: the token's own
governance (fee, blacklist, pause, upgrade) sits above every holder including this one; and a
registered pool that is itself compromised keeps receiving at most one threshold per cooldown until
the guardian disables it, which after the fixes above is now a true bound on inflows as well as on
the standing reserve.
