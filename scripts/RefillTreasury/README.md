# FulaRefillTreasury scripts

Same conventions as the other deployments: `npx hardhat run <script> --network <net>`, signer from
the hardhat `PK` var (mainnets) or `PK_TEST` / `ADMIN_PK_TEST` (Sepolia). Design, thresholds and the
audits are in `docs/refill-treasury/` (`04-independent-audit.md` is the one to read before changing the contract).

| Command | What it does |
|---|---|
| `yarn refill:dryrun:base` (or `:skale`, `:ethereum`) | Read-only. Re-checks every pool on-chain (has code, `token()`/`storageToken()` equals FULA), prints balance vs threshold and the first refill each pool would receive, estimates gas. No transaction. |
| `yarn refill:deploy:base` (or `:skale`, `:ethereum`) | Same script with `DEPLOY=1`: deploys the treasury, writes `deployments/FulaRefillTreasury_<net>_<ts>.json` with the constructor args, prints the next steps. Add `VERIFY=1` to verify on the explorer after 6 confirmations. |
| `yarn refill:status:base` (or `:skale`, `:ethereum`) | Status table for the newest deployment on that network (or `TREASURY=0x...`). Add `SEND=1` to call `refillAll()`, or `SEND=1 POOL=<id>` for one pool. Anyone with gas can run this. |
| `yarn refill:rehearse:sepolia` | Full end-to-end rehearsal against the testnet FULA token with stand-in pools; asserts every step. |
| `yarn test:refill` | The contract's own suite plus the six independent-audit suites (118 tests). |

Ethereum needs an RPC: set `ETHEREUM_RPC=https://ethereum-rpc.publicnode.com` (or `ALCHEMY_KEY`).

Pool addresses and thresholds live in `config.ts`. To change a threshold before deploy, edit that
file and re-run the dry run. After deploy, the owner can only move a threshold within its cap
(`setThreshold`), never add a pool.

## After deploying on a chain

1. Whitelist the treasury on the FULA token: `createProposal(5, 0, <treasury>, 0x0, 0, 0x0)` from
   one ADMIN_ROLE holder, `approveProposal(id)` from a second, wait the 24h whitelist lock.
2. `transferFromContract(<treasury>, amount)` from the token (per-call limit: ETH 500M, Base 50M, SKALE 5M).
3. `yarn refill:status:<net>` then `SEND=1 yarn refill:status:<net>`.
