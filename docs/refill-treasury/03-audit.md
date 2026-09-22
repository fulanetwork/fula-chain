# FulaRefillTreasury: security and gas audit (author's pass)

> Superseded in part by the independent audit in `04-independent-audit.md` (2026-09-22). Rows that
> no longer hold: row 7 (a truncated refill now DOES consume the cooldown, finding A-M1/F-S4); the
> cooldown is now bounded to [1 hour, 30 days]; a pause now expires after 30 days; OZ `Pausable` is no
> longer inherited. Line numbers below refer to the pre-independent-audit revision.

Scope: `contracts/core/FulaRefillTreasury.sol` at the state after this audit's fixes (24 tests passing,
Sepolia rehearsal recorded below). Solidity 0.8.24, OpenZeppelin 5.3.0, viaIR, optimizer 200.
Reviewers: line-by-line pass by the authoring session, plus two external model reviewers (Google
Antigravity "agy" reading the repo, NVIDIA Nemotron on the pasted source). Static analysis (Slither)
was NOT run: it is not installed on this machine. A paid human audit has NOT been done. Treat this as
a pre-audit, not a substitute.

## 0. The question that matters: can tokens end up at an unauthorized address?

Every path that moves FULA out of the contract, exhaustively (the ABI is asserted by a test to have
no other state-changing function taking an address except `transferOwnership`):

| Path | Who can call | Destination | Can the destination be influenced? |
|---|---|---|---|
| `refill(poolId)` / `refillAll()` (`_refill`, L301) | anyone | `_pools[poolId].account` | No. The `account` field is written only inside the constructor loop (L147-153) and never again. There is no setter, no array push outside the constructor, no delegatecall, no upgrade. |
| `returnToToken(amount)` (L218) | owner | `address(token)`, an immutable set once in the constructor | No. The function takes only an amount. |

Things that therefore cannot happen, with the reason:

- **Owner or compromised owner sends funds to their wallet.** No function accepts a destination. The
  owner's full power set is `pause`, `unpause`, `setThreshold` (bounded by an immutable per-pool cap),
  `setPoolEnabled`, `returnToToken`, `transferOwnership`, `renounceOwnership`.
- **Someone registers a new pool later.** The pool array is only written in the constructor. Verified
  by reading every write to `_pools` and `_poolIdPlusOne`: L147, L154, L196 (threshold only), L202
  (enabled flag only).
- **Front-running changes where a refill goes.** A refill's destination is decided by `poolId`, which
  selects a constructor-fixed address. A front-runner can only make the same transfer happen first
  (same destination) or cause the victim's single `refill(id)` to revert with `NotBelowThreshold`.
  Neither moves tokens anywhere new. `refillAll` cannot be made to revert this way.
- **Someone passes a poolId that maps to an attacker address.** `poolId >= _pools.length` reverts
  (L165), and every id below maps to a constructor-registered contract.
- **Reentrancy through the token to double-spend a refill.** `refill`, `refillAll`, `returnToToken`
  are `nonReentrant`; state (`lastRefill`) is written before the transfer (L299); FULA has no transfer
  hooks anyway. Tested with a hooked mock token (re-entry rejected).
- **Upgrade to code that adds a destination.** Not upgradeable: plain constructor deployment, no
  proxy, no `delegatecall`, no `selfdestruct`.
- **Wrong-chain address registered by mistake.** The constructor requires every pool to have code and
  to return the FULA address from `token()` or `storageToken()` (L145, L323-335). The same address
  exists on several chains with different roles; a paste from the wrong chain reverts at deploy.
- **ETH stuck or used as a vector.** No `receive`/`fallback`; sending ETH reverts.

Residual, accepted risks (not code defects):

- A registered pool contract itself is compromised: the treasury keeps feeding it, bounded to one
  threshold per pool per 24h cooldown, until the owner pauses or disables it. Bridge escrows are 5M
  per day. This bound is the reason the cooldown exists.
- The token's own governance blacklists the treasury: funds are frozen inside the treasury until
  un-blacklisted. The token admins could equally freeze any holder; not specific to this contract.
- `returnToToken` puts funds under the token contract's existing ADMIN_ROLE governance (whitelisted
  recipients only, 2-admin proposals). That is the pre-existing trust boundary, not a new one.

## 1. Line-by-line findings

Severity scale: Critical / High / Medium / Low / Info / Gas. "Fixed" means changed in this audit.

| # | Lines | Severity | Finding | Status |
|---|---|---|---|---|
| 1 | 129-157 constructor | Info | Pool list, token, cooldown, admin all validated; `Ownable(admin)` rejects zero. `code.length` checks on token and each pool. Duplicate check via `_poolIdPlusOne`. | Correct |
| 2 | 143-144 | Low | `threshold * TARGET_BPS` could overflow for absurd thresholds and permanently brick that pool's refill. | Fixed: `MAX_THRESHOLD = type(uint128).max` bound on `maxThreshold`, so the product fits with 128 bits to spare |
| 3 | 323-335 `_poolHoldsToken` / `_getterReturns` | Low | Previous `try/catch` version: a target that returns empty or malformed data makes the ABI decode fail in the caller, which try/catch does not catch, so the constructor reverted with a generic error instead of `PoolTokenMismatch`. Fail-closed either way, but unclear. | Fixed: raw `staticcall`, require exactly 32 bytes and a clean address word |
| 4 | 63-69 `Pool` struct | Gas | Original field order used 4 slots per pool. | Fixed: `address + uint64 + bool` packed into one slot, 3 slots per pool (measured: deploy gas 1,803,056 to 1,703,133 on Base dry run) |
| 5 | 269-303 `_refill` | Info | Order: enabled, threshold, cooldown, amount, effects (`lastRefill`), interaction (`safeTransfer`), event. Checks-effects-interactions respected. `strict` flag gives revert-vs-skip semantics for single vs batch. | Correct (see finding 21 for the ordering fix) |
| 6 | 299 | Medium (design) | A refill that lands short because of a token transfer fee still consumes the cooldown, so the pool may sit under threshold for 24h. Waiving the cooldown on a short landing was considered and rejected: a pool able to drain itself during the transfer would then bypass the brake entirely. Fee is 0 today. | Documented + tested, by design |
| 7 | 299 | Info | A refill truncated by the treasury balance does NOT consume the cooldown; correct because the pool is still below threshold and the treasury is now empty, so there is nothing left to protect. | Correct, tested |
| 8 | 171-177 `refillAll` | Low | All-or-nothing: a token-side revert for one pool (blacklist) fails the whole batch until that pool is disabled. Single `refill` unaffected. Bounded loop over at most 5 pools. | Documented + tested, accepted |
| 9 | 174 | Info | `total +=` is checked arithmetic (0.8 default); each term is at most `MAX_THRESHOLD`, no overflow possible in practice. A reviewer flagged this as unchecked; it is not. | Correct |
| 10 | 208-211 `renounceOwnership` | Medium | Renouncing while paused would brick refills forever (no one could unpause). | Fixed: reverts `CannotRenounceWhilePaused`; owner unpauses first. Tested |
| 11 | 214-220 `returnToToken` | Info | Only destination is the immutable token address; zero and over-balance guarded; `nonReentrant`. `safeTransfer` kept (StorageToken returns bool, but a hard-wired `transfer` would save ~200 gas; not worth losing the return-value check). | Correct |
| 12 | 191-197 `setThreshold` | Info | Bounded by immutable `maxThreshold`; zero rejected. Cannot raise the outflow ceiling above what was fixed at deploy. | Correct |
| 13 | 251-259 `previewRefill` | Info | Returns 0 when paused, disabled, cooling down, above threshold, or treasury empty; otherwise the exact amount `refill` would send, including truncation. A reviewer suggested ignoring pause in the preview; kept as "what would happen right now", which is what the status script needs. | Correct |
| 14 | 279-291, 307-318 | Gas | `p.threshold` was read from storage three times per refill. | Fixed: cached once, passed to `_amountFor`; `_amountFor` arithmetic is `unchecked` (bounds proven by L143-144 and the `balance < threshold` guard) |
| 15 | 137-156, 172-175 loops | Gas | Checked `i++`. | Fixed: `unchecked { ++i; }` |
| 16 | 84-86 immutables, 105-119 custom errors, 97-101 events | Gas/Info | Immutables for token and cooldown; custom errors instead of strings; events on every state change with indexed ids and accounts. | Correct |
| 17 | 218, 301 | Info | StorageToken `transfer` reverts on amount 0: `_refill` returns/reverts before transferring 0 (L286-289); `returnToToken` rejects 0 (L213). | Correct |
| 18 | whole contract | Info | No `receive`/`fallback`, no `selfdestruct`, no `delegatecall`, no assembly, no external calls except `token.balanceOf`/`safeTransfer` and the constructor-time getter probes. | Correct |
| 19 | whole contract | Info | Tokens other than FULA sent here by mistake are stuck (no sweep). Adding a sweep would add a destination-taking function, which the design forbids. | Accepted |
| 20 | 48-49 docs | Low | `refill(id)` can be made to revert by anyone who refills first (griefing of a keeper's single-pool call). Pool still gets funded. | Documented: keepers use `refillAll` |

## 2. External reviewer findings and disposition

### Nemotron 3 120B (pasted source)

- A1 try/catch on malformed return: taken (finding 3).
- A2 token must have code, A3 loop bound, B2 "unchecked" total, C1 target vs cap, C3 renounce guard
  as griefing, D2 use plain `transfer`, E1 preview ignoring pause: rejected with reasons in the table
  above (rows 1, 8, 9, 12, 10, 11, 13).
- D1 treasury blacklisted by token governance: accepted residual risk (section 0).
- Its output was truncated by its own token cap after finding F6; nothing in the visible part was
  Critical or High.

### Antigravity / agy (read the repo)

Reviewed the pre-fix revision. No Critical or High findings. Its items and disposition:

- Medium: `try/catch` does not catch an ABI-decode failure on empty/malformed return data, so the
  constructor would revert generically instead of with `PoolTokenMismatch`. Taken (finding 3).
- Gas: redundant `p.threshold` SLOAD across `_refill`/`_amountFor`; checked `i++` in both loops;
  checked `target - balance` and `threshold * TARGET_BPS`. All taken (findings 14, 15).
- Gas: `unchecked { total += ... }` in `refillAll`. Not taken: saves a few gas per pool, and the
  checked add is the last line of defence if a future edit ever loosens `MAX_THRESHOLD`.
- Confirmed correct, with reasons: constructor validation and `memory` parameters (calldata is not
  available to constructors), zero-amount interception, fee/blacklist behaviour, CEI ordering and
  `nonReentrant` placement, `uint64` cooldown math, truncated-refill cooldown rule, struct packing,
  `MAX_THRESHOLD`, the renounce guard (also clears `_pendingOwner` via `super`), `returnToToken`
  reading live balance, event ordering, no custom-error selector collisions, and that `refillAll`
  neutralises the front-run griefing of single `refill` calls.

### Check-order change made during the rehearsal (finding 21)

| # | Lines | Severity | Finding | Status |
|---|---|---|---|---|
| 21 | 279-288 `_refill`, 251-259 `previewRefill` | Low (UX) | Cooldown was evaluated before the threshold, so a pool that was simply full but recently refilled reported `CooldownActive` ("wait") instead of `NotBelowThreshold` ("nothing to do"). Surfaced by the first Sepolia run. | Fixed: threshold first, then cooldown. Costs one `balanceOf` call on pools that are both below threshold and cooling down. Tests unchanged and passing |

## 3. Sepolia rehearsal (final bytecode, 2026-09-22)

Script: `scripts/RefillTreasury/rehearseSepolia.ts` (`yarn refill:rehearse:sepolia`). Real testnet FULA
token `0x32d6929c9F552068D54481FeAe75674fD29F337e`; three stand-in pool contracts (two exposing
`token()`, one `storageToken()`); cooldown 90s for the rehearsal. Record:
`deployments/FulaRefillTreasury_rehearsal_sepolia_1790062399269.json`.

- Treasury `0xb30159D0013eE92B21109902962B3dA9f675267E`, deploy tx
  `0x5c99b27e7312afae9178feb28b4e83c667e0d9feb332bd7c36ac6ce750c394d6`, 1,460,100 gas.
- Deployer/"anyone" `0x694451c2…`, guardian `0x68d36F6A…`. Total ETH spent 0.0028.
- `refillAll` for three pools: 163,521 gas.

All 20 asserted steps passed: constructor rejects an EOA pool; funding via the token's
`transferFromContract` path; previews match; `refillAll` fills three pools to exact amounts
(100K / 55K / 20K); full pool reverts `NotBelowThreshold`; batch with nothing eligible returns 0;
drained pool inside cooldown reverts `CooldownActive`; after the live 90s cooldown it is topped to the
110% target; non-owner `pause` reverts; refills revert `EnforcedPause` while paused; `renounceOwnership`
while paused reverts; `returnToToken` works while paused and lands in the token contract; `setThreshold`
above the cap reverts and within the cap applies; a refill truncated by an empty treasury sends what is
left, flags `truncated=true`, leaves `lastRefill` unchanged; empty treasury reverts `TreasuryEmpty`;
after refunding, the pool is refilled immediately (no cooldown burned); disabled pool reverts
`PoolDisabled`; cleanup returns the remainder to the token contract.

A first run on the previous bytecode stopped at step 6 because the cooldown check preceded the
threshold check (finding 21); its 865K FULA were returned via `returnToToken`
(tx `0x99ffa607e5ffc441cb62d3fcef4e3a4cbb5569f4da7e4d58fa91defaa1ef6d8c`). The status script
`refillTreasury.ts` was run against the final rehearsal treasury and reports correctly.

## 4. Not done

- Slither / Mythril / Echidna: not installed here. Recommended before mainnet, along with a human audit.
- Fuzzing of `_amountFor` bounds beyond the unit tests.
- Mainnet deployment: not performed. See `02-design-and-runbook.md`.
