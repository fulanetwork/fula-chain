# FULA refill treasury: design and runbook

Contract: `contracts/core/FulaRefillTreasury.sol` (non-upgradeable, OpenZeppelin v5.3 `Ownable2Step` +
`Pausable` + `ReentrancyGuard` + `SafeERC20`). Config: `scripts/RefillTreasury/config.ts`.
Tests: `yarn test:refill` (118 passing: the contract's suite plus six independent-audit suites, see `04-independent-audit.md`).
Decisions recorded 2026-09-22 supersede the threshold proposals in `01-inventory-and-thresholds.md` §C.

## What it does

- Holds a FULA reserve moved out of the token contract.
- `refill(poolId)` / `refillAll()`: anyone, any time. For each registered pool, if
  `balanceOf(pool) < threshold`, send `min(threshold * 1.10 - balance, threshold, treasury balance)`.
  Above threshold: nothing (single call reverts `NotBelowThreshold`, batch skips).
  Treasury short: sends what it has, does not revert; the cooldown is still consumed (independent audit
  finding A-M1: otherwise a pool whose threshold exceeds the reserve could siphon every later deposit).
- The pool list is fixed in the constructor. Nothing can add an address later.
- FULA can only ever leave to (a) a registered pool via refill, or (b) the FULA token contract via
  `returnToToken` (owner). There is no other transfer path; the test suite asserts the ABI has no
  state-changing function taking an address other than `transferOwnership`.

## Parameters (owner decisions 2026-09-22)

| Parameter | Value |
|---|---|
| threshold | 1,000,000 FULA for every reward pool (cap 1,000,000), 5,000,000 for bridge escrows |
| target | threshold × 1.10 (constant `TARGET_BPS = 11000`) |
| maxPerRefill | = threshold |
| maxThreshold | per pool cap fixed at construction; owner can set threshold anywhere in (0, cap] |
| cooldown | 24h between two refills of the same pool, consumed by EVERY non-zero refill including a truncated one (constructor immutable, must be within 1 hour and 30 days) |
| 30-day cap | none |

The cooldown was confirmed by the owner on 2026-09-22 (as were both bridge escrows as pools). It is the only brake on a compromised pool: without it a
pool contract that can be drained by an attacker turns the treasury into an unlimited faucet in one
block. With it, the loss is bounded to `threshold` per day per pool, which is what makes the
guardian's pause useful. The constructor rejects values outside [1 hour, 30 days], so it cannot be disabled by misconfiguration.

## Registered pools per chain

See `config.ts`. Summary:

| Chain | Pool | threshold |
|---|---|---|
| Base | VIP StakingEngineLinear RewardPool `0x92c7D8…0545` | 1M |
| Base | RewardEngine StakingPool `0xE11Ad2…dc7e` | 1M |
| Base | StakingEngineLinearWithMigration RewardPool `0xdc9208…1a1F` | 1M |
| Base | TestnetMiningRewards `0x1Def72…545d` | 1M |
| Base | Bridge escrow FulaOFTAdapter `0x154b96…327a` | 5M |
| SKALE | RewardEngine StakingPool `0x470841…Db9E` | 1M |
| SKALE | TestnetMiningRewards `0x92217c…fDc9` | 1M |
| SKALE | StakingEngineLinearWithMigration RewardPool `0xb9A247…2BC1` | 1M |
| Ethereum | StakingEngineLinear RewardPool `0xDE9CE3…cBA8` | 1M |
| Ethereum | Bridge escrow FulaOFTAdapter `0x170c55…15e1` | 5M |

Bridge note: the live bridge (repo `scripts/bridge/addresses.ts` and https://fulanetwork.github.io/bridge/)
is Ethereum ↔ Base over LayerZero, not Base → SKALE. Both escrows are owned by Safe
`0x3167688A46c01CF23d7969cdBf2D9147c9767341`. On 2026-09-22 the Ethereum escrow held 2.29M FULA
(below 5M, so the first `refillAll` on Ethereum would send it 3.21M) and the Base escrow 32.7M.
Because the adapter owner can redirect escrowed funds through a peer or DVN change (see the bridge
memory note), auto-refilling the escrow extends that trust to the treasury, bounded by 5M per day.

## Guardian (owner) powers, and what it cannot do

Can: `pause` (expires by itself after 30 days; re-pause to extend) / `unpause` refills, `setPoolEnabled`, `setThreshold` (≤ cap), `returnToToken`,
`transferOwnership` (two-step), `renounceOwnership`.
Cannot: add a pool, raise a threshold above its cap, send FULA anywhere but a registered pool or
the token contract, upgrade the code.

Renouncing ownership makes the contract fully autonomous: refills keep working, nothing else does. Do it
only once every registered pool is final, since a disabled pool stays disabled and a token-blacklisted pool
would leave `refillAll` permanently reverting (single `refill` still works). Emergency order is: `pause`
first, then `returnToToken` (a refill can front-run a full-balance return otherwise).

## Deployed addresses (2026-09-22)

Deployment records live in `deployments/` (git-ignored), so the addresses are recorded here too.
All three were read back against `config.ts` and are explorer-verified (0.8.24, 200 runs, shanghai).

| Chain | FulaRefillTreasury | Deploy tx | Pools |
|---|---|---|---|
| Ethereum | `0xb2A51311aAC9aDAe8F9785129c988539b1510c2d` | `0xca6668e1e76f83d92f6c618d1e85de009fa1498fc34b78cff76b1921b84999e2` | 2 |
| Base | `0x78B54b8F2A6DbeC2A7Cf252DEc5C56E51D2A43E8` | `0x4e6dd92b0fb19f420a1e14afb04a40c874a51382bbe7d3fac70704bd9887959e` | 5 |
| SKALE | `0xb821C2023cf7DB5a9D7CF3703aEaCB1395F800Af` | `0x7c8cc54d1ec3b4f5d485b6ac72c2f0d63d9f88dec034c56c46e3e4045a315070` | 3 |

Base `0x10F9CA131e0a971113cf5B653428a4edefc16886` is a dead, unfunded duplicate from a run that crashed
after its transaction; never whitelist or fund it.

## Deploy runbook (per chain)

1. Dry run, read-only, re-verifies every pool address on-chain (code present, `token()` or
   `storageToken()` equals FULA) and prints the first refill each pool would receive:
   ```
   npx hardhat run scripts/RefillTreasury/deployRefillTreasury.ts --network base
   ```
   For Ethereum set `ETHEREUM_RPC=https://ethereum-rpc.publicnode.com` (or `ALCHEMY_KEY`).
2. Deploy: same command with `DEPLOY=1` (add `VERIFY=1` to run Etherscan verification after 6 blocks).
   Writes `deployments/FulaRefillTreasury_<network>_<ts>.json` with the constructor args.
3. Whitelist the treasury on the FULA token so `transferFromContract` can pay it:
   `createProposal(5, 0, <treasury>, 0x0, 0, 0x0)` from one ADMIN_ROLE holder, `approveProposal(id)`
   from a second, then wait the 24h whitelist lock.
4. Fund: `transferFromContract(<treasury>, amount)`. Per-call limits today: ETH 500M, Base 50M, SKALE 5M.
   Suggested first funding: Base 6M (first refills about 2.9M), SKALE 3M (first refills about 2.6M; the whole chain holds only 5.06M), Ethereum 5M (1M to the staking pool and 3.21M to the bridge
   escrow if that pool stays registered).
5. First refill and status, by anyone:
   ```
   TREASURY=0x... npx hardhat run scripts/RefillTreasury/refillTreasury.ts --network base        # status
   TREASURY=0x... SEND=1 npx hardhat run scripts/RefillTreasury/refillTreasury.ts --network base # refillAll
   ```
6. Retire the manual top-up wallet: nothing else needs it once every reward pool is registered.

## Verification done

- 24 unit and integration tests, including the real `StorageToken` whitelist + `transferFromContract`
  path into a real `StakingPool`, reentrancy through a hooked token, ABI surface assertion.
- Constructor rejects: EOA pool, the token itself, duplicate pool, threshold 0 or above cap, and any
  pool whose token getter is missing or returns another token (guards against pasting an address
  from the wrong chain; `0xE11Ad2af…` is a pool on Base but an implementation on SKALE).

## Known limits

- A burst of claims above `threshold` within one cooldown window will fail until the window ends.
  Largest observed single-month outflow is 225K (SKALE RewardEngine, Feb 2026), so a 100K/day brake
  has 30× headroom on a monthly basis but not on a single-day spike.
- Because `maxPerRefill = threshold`, an empty pool is refilled to exactly `threshold` (not to the
  110% target) and is then "not below threshold"; the first claim after that puts it below again,
  and the next top-up waits for the cooldown. That is one threshold of runway per day per pool,
  which is the parameter set you chose. Setting `maxPerRefill` above threshold would need a code change.
- A transfer fee on the token (`platformFeeBps`, currently 0) makes refills land short and the pool
  can sit just under threshold for one cooldown. The cooldown is consumed on purpose (waiving it on
  a short landing would let a self-draining pool bypass the brake). Tested.
- `refillAll` is all-or-nothing: if the token blacklists one registered pool the batch reverts until
  the owner disables that pool; `refill(id)` on the other pools keeps working. Tested. With a
  renounced owner the batch path would stay broken, single refills would not.
- `refill(id)` reverts when the pool is not eligible, so anyone can make a keeper's `refill(id)`
  transaction fail by refilling first (the pool still gets funded). Keepers should call `refillAll`,
  which never reverts on "nothing to do". The status script does this by default.
- Someone must call `refill` on Base and Ethereum and pay gas. No automation was requested.
- TokenDistributionEngine is intentionally not a pool: vesting is pre-funded and its balance is
  supposed to reach zero.
- Done since: independent audit (`04-independent-audit.md`), Sepolia rehearsal on the audited bytecode
  (21/21 steps, `04` §3b) and `refillTreasury.ts` against a rehearsal deployment. Not run: Slither (not installed on this machine), a paid audit, and the `VERIFY=1`
  explorer-verification path.
- Yarn shortcuts: `refill:dryrun:<net>`, `refill:deploy:<net>`, `refill:status:<net>`,
  `refill:rehearse:sepolia`, `test:refill` (see `scripts/RefillTreasury/README.md`).
