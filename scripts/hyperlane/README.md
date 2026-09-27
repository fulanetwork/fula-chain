# scripts/hyperlane — FULA Base ↔ SKALE bridge (Hyperlane warp route)

Design, security statement, status and the mainnet runbook: **`docs/bridge-hyperlane-skale.md`**.

## Layout

| Path | What |
|---|---|
| `config.ts` | chains, tokens, owners, lanes, stages, validator/relayer addresses — the single source of truth |
| `lib/hl.ts` | Hyperlane CLI runner (Windows path shim), registry paths, YAML/JSON IO, records, wallets |
| `lib/artifacts.ts` | loads `artifacts-shanghai`, refuses non-Shanghai builds, `deploy()` waits for code visibility |
| `hl-contracts/` | standalone Hardhat project that compiles `@hyperlane-xyz/core` 12.1.0 for **evm shanghai** (`npm run build`) |
| `artifacts-shanghai/` | committed ABI+bytecode + `SOURCES.md` manifest (skaled 5.2 has no Cancun opcodes) |
| `registry/` | local Hyperlane registry: `chains/<name>/metadata.yaml` + `addresses.yaml`, `deployments/warp_routes/<id>-{deploy,config}.yaml` |
| `deployCore.ts` | Hyperlane core on a SKALE chain (dry run by default, `DEPLOY=1`) |
| `deployWarp.ts` | both routers + ISM trees + enrollment on a lane (`DEPLOY=1`, `HL_VALIDATOR=`, `MOCK_TOKENS=` testnet) |
| `agentConfig.ts` | `server/config/agent-config.<lane>.json` for the validator/relayer containers |
| `canary.ts` | approve → transferRemote → wait for `Mailbox.delivered` |
| `laneStatus.ts` | escrows, caps, pause state, pending/delivered dispatches (exit 2 on alert) |
| `pause.ts` | pause / unpause / unenroll / enroll (Safe calldata with `DRY_RUN=1`) |
| `applyStage.ts` | new cap: new RateLimitedIsm + aggregation, switch ISM |
| `burnProxyAdmins.ts` | SKALE mailbox + router ProxyAdmins → dead address (`CONFIRM=BURN`) |
| `server/` | `install.sh`, `docker-compose.yml`, `healthcheck.sh`, `status.sh`, `uninstall.sh`, `.env.example`, `config/agent-config.*.json` |
| `testnet/` | throwaway helpers: `fundSigner.ts`, `deployMockToken.ts`, `seedMock.ts` |

`yarn hl:*` in `package.json` wraps the common invocations. Tests: `yarn test:hyperlane`.

## Prerequisites

- `npm i -g @hyperlane-xyz/cli@44.0.2` (pinned; used only for `registry agent-config` / `warp read`).
- `hardhat vars`: `PK_TEST` + `ADMIN_PK_TEST` (testnets), `PK` (mainnet SKALE deploys — the only
  address whitelisted to create contracts on Europa).
- On Windows the CLI is run through `lib/win-path-shim.js` automatically (see `lib/hl.ts`).

## Quick paths

Testnet (Base Sepolia ↔ SKALE Base Sepolia, mock token, already deployed):

```
yarn hl:status:testnet
ROUTE=MCK/basesepolia-skalebasesepolia AMOUNT=1 npx hardhat run scripts/hyperlane/canary.ts --network base-sepolia
```

Mainnet: follow `docs/bridge-hyperlane-skale.md` §4 step by step (server → core → warp → agent config
→ canaries → burn → governance → website).
