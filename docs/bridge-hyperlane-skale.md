# FULA Base ↔ SKALE bridge on Hyperlane — decision record, design and runbook

Status (2026-09-27): **contracts, scripts, tests and server tooling built; testnet contracts deployed
and two canary messages dispatched; agents (validator + relayer) NOT yet run anywhere** — see
"Where things stand". Mainnet is not deployed.

## 1. Why this exists, and why it looks like this

The live FULA bridge is a LayerZero lock/release pair between Ethereum and Base
(`docs/bridge-design.md`). The owner wanted SKALE Europa reachable too. Findings on 2026-09-26/27:

| Option | Verdict | Why |
|---|---|---|
| LayerZero to SKALE | rejected | LayerZero marks SKALE `DEPRECATED`; exactly one live DVN on SKALE (1-of-1 = the Kelp/rsETH shape); SKALE endpoint charges fees in SKL (Alt endpoint); the live adapters have locked peers so new adapters were needed anyway. |
| SKALE IMA | rejected | Ethereum↔SKALE only; needs a mint/burn token on SKALE (ours is not) and chain-owner approval. |
| Meson and similar | not applicable | stablecoin liquidity networks; someone must hold FULA inventory on both chains, i.e. us again. |
| **Hyperlane Warp Route** | **chosen** | permissionless, collateral routers = the same lock/release model, audited stock contracts, open-source agents. Cost: Hyperlane has **no infrastructure on SKALE at all** (not in its registry), so we deploy the core ourselves and run one validator + one relayer. |
| Base, not Ethereum, as the other end | chosen | the relayer pays destination gas out of pocket (cents on Base, dollars on Ethereum, and SKALE's free gas invites spam); Base holds most FULA and all reward pools; Ethereum reaches SKALE in two hops through the existing bridge. |

Owner constraints: **one Linux server** (validator + relayer on that box); SKALE owner = the admin
EOA `0xFa8b0259…D446` with the mailbox and router **ProxyAdmins burned** after final configuration
(no Safe contracts exist on SKALE Europa; canonical Safe 1.3.0/1.4.1 addresses have no code);
Base owner = the existing 2-of-2 Safe `0x3167688A…7341` (v1.4.1).

### The honest security statement

- **SKALE → Base releases are attested by ONE validator we run.** If its key (or the server) is
  compromised, an attacker can forge releases from the Base escrow up to the **daily inbound cap**
  until the Safe pauses. `test/hyperlane/warpRoute.test.ts` ("LOSS BOUND") proves the bound with the
  real bytecode: a forged message at the cap succeeds, one above it can never be released, and the
  owner's pause stops even a compromised validator.
- **Base → SKALE releases are attested by Hyperlane's public Base validator set (3 of 5: Abacus
  Works, Zee Prime, Substance Labs, Luganodes, Enigma)** plus our cap and pause.
- Loss bound = daily cap + time-to-pause; escrow size is the hard ceiling. Stage 1: 1M FULA escrow
  per side, 100k/day cap. Stage 2 after 7 clean days: 5M / 500k.
- Two independent reviewers (Google and NVIDIA model families) rated the single validator on one
  server as the dominant risk and recommended ≥2 validators on separate machines. The owner accepted
  the bound. **First upgrade when a second machine exists: a second validator → 2-of-2 multisig ISM.**
- The Google-family reviewer argued against burning the SKALE ProxyAdmins (no emergency patch
  path). The owner chose burn: under a single-key owner an upgradeable mailbox is a forge lever; the
  escape hatch for a router bug is pause → unenroll → deploy a new route and let users migrate.

### Finding that changed the build: skaled has no Cancun

SKALE chains run **skaled 5.2**: PUSH0 (Shanghai) works; **MCOPY, TSTORE/TLOAD (Cancun) and BASEFEE
do not** (probed with `eth_call` on Europa from the whitelisted deployer and on SKALE Base Sepolia;
`scripts/hyperlane/deployCore.ts` re-probes PUSH0 before deploying). `@hyperlane-xyz/core` ships
bytecode compiled with solc 0.8.33 for `cancun`, and the Hyperlane CLI deploys that bytecode — its
first proxy creation on SKALE burned the whole 55M gas limit on an invalid opcode. **So the Hyperlane
CLI cannot deploy to any SKALE chain today.** We therefore recompile the same sources for
`evmVersion: shanghai` (`scripts/hyperlane/hl-contracts`, artifacts committed under
`scripts/hyperlane/artifacts-shanghai` with a manifest) and deploy with our own scripts. The CLI is
still used for `registry agent-config`, `warp read` and `warp check`.

Two more Windows-side facts: the CLI's FileSystemRegistry builds paths with backslashes and matches
them with forward-slash regexes, so a local registry is silently empty on Windows — `lib/hl.ts`
preloads `lib/win-path-shim.js` to fix `path.join`. And public RPCs (Base Sepolia's publicnode,
`mainnet.base.org`) serve stale state for seconds after a transaction; every deploy waits until the
new code is visible before the next transaction (`lib/artifacts.ts`).

## 2. Architecture

| Piece | Base (8453) | SKALE Europa (2046399126, domain = chain id) |
|---|---|---|
| Mailbox | registry `0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D` | ours (`deployCore.ts`): Mailbox proxy, defaultHook = our MerkleTreeHook, requiredHook = ProtocolFee(0), defaultIsm = TrustedRelayerIsm placeholder (our router never uses it), ValidatorAnnounce, the two static ISM factories. ProxyAdmin → `0x…dEaD` after final config. |
| Router | `HypERC20Collateral` (lock/release), token `0x9e12735d…A4cB`, owner Safe | same, owner admin EOA; router ProxyAdmin burned too |
| Hook | Base registry `merkleTreeHook` `0x19dc38ae…0117` **by address** | our MerkleTreeHook |
| ISM (verifies inbound) | `StaticAggregationIsm` 3-of-3: `StaticMessageIdMultisigIsm{[ourValidator],1}` + `RateLimitedIsm{cap,86400,recipient=router}` + `PausableIsm` | same shape with the public Base 3-of-5 |
| Gas | users pay Base gas only; no IGP (the router hook is the merkle hook alone) | free (sFUEL); the agent config's `interchainGasPaymaster` points at the ProtocolFee hook, a real contract that never emits GasPayment |
| Kill switches | `pause.ts` (PausableIsm), unenroll, `applyStage.ts` to a zero-cap ISM | same |

Deploy-order note (reviewer concern): the router is initialised with ISM = 0 (mailbox default)
because the RateLimitedIsm needs the router address first. That window is closed by ordering, not by
luck: no remote router is enrolled until AFTER `setInterchainSecurityModule` on both chains, and
`handle()` rejects any sender that is not the enrolled remote router — so nothing can be released
through the default ISM. Read-back checks both facts.

Why the hook is the merkle hook **by address**: Base's mailbox required hook is `protocolFee`
(type 8) and the merkle hook lives in the *default* fallback-routing hook, so a custom hook on the
router replaces the merkle hook unless it *is* the merkle hook — and the default hook's IGP has no
SKALE gas oracle and would revert. A rate-limit hook would drop validator coverage; the cap is
therefore enforced on the receiving side (RateLimitedIsm), which is where a theft is bounded anyway.

Agents (`scripts/hyperlane/server`): one `validator` (origin = the SKALE chain, `localStorage`
checkpoint syncer on a shared volume) and one `relayer` (`--relayChains base,skaleeuropa`,
`--allowLocalCheckpointSyncers`, `HYP_WHITELIST` = our two routers as sender and recipient,
`gasPaymentEnforcement: none`, `index.from` = our deployment blocks). No S3/KMS.

## 3. Where things stand (2026-09-27)

Built and verified:
- `scripts/hyperlane/hl-contracts` → `artifacts-shanghai` (15 contracts, `SOURCES.md` manifest).
- `deployCore.ts`, `deployWarp.ts`, `agentConfig.ts`, `canary.ts`, `laneStatus.ts`, `pause.ts`,
  `applyStage.ts`, `burnProxyAdmins.ts`, `config.ts`, `lib/*`, `registry/*`; `yarn hl:*` scripts.
- `test/hyperlane/warpRoute.test.ts`: 15 tests against the real Shanghai bytecode (both
  directions, replay, wrong validator, message-id binding, loss bound, cap exhaustion and refill,
  pause/unpause, owner-only setters, unenroll/enroll, hostile router, escrow conservation, burned
  ProxyAdmin). `yarn test:hyperlane`.
- Server: `install.sh` (idempotent, `--check`, generates keys, whitelists routers, systemd + cron
  healthcheck + external heartbeat), `docker-compose.yml`, `healthcheck.sh`, `status.sh`,
  `uninstall.sh`, `selfcheck.sh` (bash -n + shellcheck clean). **Not yet run on a real server** —
  this machine has no Docker and its WSL has no network.
- Testnet (SKALE Base Sepolia 324705682 ↔ Base Sepolia; SKALE's Europa testnet hostname is dead):
  core deployed on SKALE Base Sepolia (mailbox `0x2777033d…`), mock-token route
  `MCK/basesepolia-skalebasesepolia` (routers Base Sepolia `0x5F0C9486…`, SKALE `0x1a93D27c…`), both
  escrows seeded 50,000, **one canary dispatched each way and PENDING** (they deliver when the agents
  start: `yarn hl:status:testnet`). Testnet StorageToken on SKALE Base Sepolia:
  `0x75b02f2665A1df52Fd802Ab14A832c4FeF5B67fb` (governance timelock until 2026-09-28 05:54 UTC).
- Website: `E:\GitHub\fulawebsite\bridge\index.html` has a second lane (Hyperlane protocol
  adapter), hidden until `CONFIG.CHAINS.base.hyperlane.router` and `skale.hyperlane.*` are filled in;
  `?testnet=1` swaps in the rehearsal route.

Not done:
1. **Agents rehearsal** (install.sh on the server with `--testnet`, canaries delivered, cap/pause/
   restart drills — see §5). Needs the server.
2. Real-token testnet route (FULA) after the StorageToken governance unlocks (whitelist the router,
   `transferFromContract`).
3. Mainnet: everything in §4.

## 4. Mainnet runbook (in order)

0. `yarn hl:build` once per dependency change (commits `artifacts-shanghai`). `npm i -g @hyperlane-xyz/cli@44.0.2`.
1. **Server first** (the validator address goes into the Base ISM): copy `scripts/hyperlane/server`
   to the box, `sudo ./install.sh --no-start`; note the printed VALIDATOR and RELAYER addresses; fund
   the validator with a little sFUEL (announce tx) and the relayer with ~0.02 ETH on Base + sFUEL.
2. `DEPLOY=1 yarn hl:core:deploy:skale` (signer = `PK`, the only address whitelisted to deploy on
   Europa). Read-back must be all `ok`.
3. `DEPLOY=1 HL_VALIDATOR=0x… yarn hl:warp:deploy:mainnet` (Base side may use `HL_BASE_KEY`). Read-back
   all `ok` on both chains. Record the two router addresses.
4. `yarn hl:agent-config:mainnet` → copy `server/config/agent-config.mainnet.json` to the server as
   `config/agent-config.json`; `sudo ./install.sh --base-router 0x… --skale-router 0x…
   --base-index-from N --skale-index-from N`; `./status.sh` shows both containers up and a checkpoint
   file once the validator is announced.
5. Canaries: send 10 FULA into each router by plain transfer, then `AMOUNT=1 yarn hl:canary:base` and
   `yarn hl:canary:skale`; both must print DELIVERED. `yarn hl:status:mainnet` clean.
6. `CANARIES=<id1>,<id2> CONFIRM=BURN npx hardhat run scripts/hyperlane/burnProxyAdmins.ts --network skale`.
7. Governance: `createProposal(5, 0, <router>, …)` on the Base and SKALE tokens (AddWhitelist),
   second admin approves, 24h lock, `transferFromContract(router, 1_000_000e18)` on each (Base
   per-call cap 50M, SKALE 5M). FulaRefillTreasury pools are constructor-fixed, so these escrows are
   NOT auto-refilled.
8. Website: fill `hyperlane.router` / `rateLimitedIsm` / SKALE `mailbox` in `bridge/index.html`
   CONFIG, test with a small transfer, push (the site deploys on push).
9. Operate: `hl:status:mainnet` on a schedule (exit 2 = alert), `status.sh`/`healthcheck.sh` on the
   server, external heartbeat, weekly diff of Hyperlane's `defaultMultisigConfigs.base` against the
   SKALE-side multisig validators (`laneStatus` prints them). Stage 2 after 7 clean days:
   `STAGE=2 npx hardhat run scripts/hyperlane/applyStage.ts --network skale` and the same with
   `DRY_RUN=1 --network base` → Safe.

## 5. Rehearsal checklist (testnet, real agents)

`sudo ./install.sh --testnet --base-router 0x5F0C9486Eda50f7a4b36c46aabed90D5cbCab6ED --skale-router
0x1a93D27cE441e86D3Fe0B2c3C7f76a9B6BA936f3 --base-index-from 47361226 --skale-index-from 2938084`
with `config/agent-config.json` = `server/config/agent-config.testnet.json`, then:

- [ ] both containers running, metrics on :9090/:9091, checkpoint file within 5 min
- [ ] the two pending canaries deliver (`yarn hl:status:testnet` → 2 delivered)
- [ ] `ROUTE=MCK/basesepolia-skalebasesepolia AMOUNT=1 npx hardhat run scripts/hyperlane/canary.ts --network base-sepolia` and `--network skale-base-sepolia` both DELIVERED; record timings
- [ ] cap: send 1,001 (testnet cap 1,000) → stays pending; `laneStatus` shows it; after 24h it still cannot deliver (above cap); send 600 + 600 → second parks until refill
- [ ] pause: `ACTION=pause … pause.ts --network skale-base-sepolia`, send → pending; unpause → delivered
- [ ] relayer stopped (`docker stop fula-hl-relayer`), send, start → delivered
- [ ] `docker compose down && up -d` → resumes from DB, no re-delivery
- [ ] a transfer from a non-whitelisted contract is ignored by the relayer (deploy a second router on Base Sepolia aimed at ours; message stays undelivered)
- [ ] 20 mixed transfers; escrowA + escrowB ≥ seeds; `install.sh` run a second time reports no changes
- [ ] real-token route (`FULA/basesepolia-skalebasesepolia`) after governance: whitelist + `transferFromContract`, one canary each way

## 6. Incident playbook

| Symptom | Do |
|---|---|
| `laneStatus` PENDING > 15 min | `./status.sh`; relayer logs (`docker logs fula-hl-relayer`); relayer Base ETH low? top up. Validator checkpoint age old? `docker logs fula-hl-validator`, SKALE RPC reachable? Restart: `systemctl restart fula-hyperlane`. Messages are safe in escrow; they deliver when the relayer catches up. |
| Suspected key/server compromise | `ACTION=pause` on **both** routers (Base via Safe calldata from `DRY_RUN=1`), then rotate: new validator key on a clean box → `applyStage.ts`-style new multisig ISM (deploy via factory) → `setInterchainSecurityModule`; new relayer key. |
| Relayer DB corrupt | `docker compose down`, delete `db-relayer/`, `up -d` (re-indexes from `index.from`; delivered messages are skipped because the destination Mailbox reports them delivered). |
| Server lost | new box: `install.sh` with the SAME keys copied from a backup of `/opt/fula-hyperlane/.env` (or new keys + new multisig ISM as above). |
| Public Base validator set rotated | `laneStatus` prints the SKALE-side validators; compare with `hyperlane registry` / SDK `defaultMultisigConfigs.base`; if changed, deploy a new multisig ISM via the factory and a new aggregation, switch with `setInterchainSecurityModule`. |
| Need to raise/lower the cap | `applyStage.ts` (`STAGE=` or `CAP=`), Safe on Base, EOA on SKALE. |

## 7. Addresses

Testnet — see §3 and `scripts/hyperlane/registry` (`chains/skalebasesepolia/addresses.yaml`,
`deployments/warp_routes/MCK/basesepolia-skalebasesepolia-config.yaml`). Mainnet — to be filled in
by the deploy records (`deployments/HyperlaneCore_skale_*.json`, `HyperlaneWarp_skale_*.json`) and
`registry/chains/skaleeuropa/addresses.yaml`.
