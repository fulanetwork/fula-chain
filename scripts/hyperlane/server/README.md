# FULA Hyperlane agents — server setup (one Linux box)

Runs ONE Hyperlane validator (origin = the SKALE chain) and ONE relayer (both directions) in Docker.
Everything is installed by `install.sh`; nothing else needs to be on the box.

## Install

```
# on the server, as root, from a copy of this directory:
cp <repo>/scripts/hyperlane/server/config/agent-config.<lane>.json ./config/agent-config.json
sudo ./install.sh --check                          # what would change (nothing is touched)
sudo ./install.sh --base-router 0x... --skale-router 0x... --base-index-from N --skale-index-from N
#   add --testnet for the Base Sepolia <-> SKALE Base Sepolia rehearsal
```

`install.sh` is idempotent: run it again after every git pull. It installs Docker + compose from
Docker's repo, jq/curl/git, time sync and unattended security updates; creates the `hyperlane`
system user and `/opt/fula-hyperlane/{config,signatures,db-validator,db-relayer}`; writes `.env`
from `.env.example` (never overwrites a filled value), **generates the validator and relayer keys if
absent and prints only their addresses**, renders the relayer whitelist from the router addresses,
installs the `fula-hyperlane` systemd unit (compose up on boot) and a cron health check every 5 min,
pulls the pinned agent image, starts, and self-tests (containers up, metrics on 127.0.0.1:9090/9091,
first checkpoint file).

Then fund: the **validator** address with a little SKALE gas (announce transaction; sFUEL/CREDIT is
free from the faucet) and the **relayer** address with ~0.02 ETH on Base (deliveries) plus a little
SKALE gas. Watch `docker logs -f fula-hl-validator` until it announces and writes the first checkpoint.

## Day to day

- `./status.sh` — one screen: containers, latest checkpoint, metrics, last log lines, last health check.
- `/var/log/fula-hyperlane-health.log` — the 5-minute health check (containers, metrics, checkpoint
  age, relayer Base ETH, disk, heartbeat). Set `HEARTBEAT_URL` (healthchecks.io-style) in `.env` so a
  dead server alerts from OUTSIDE the box, and `ALERT_WEBHOOK` for chat alerts.
- `docker compose logs -f relayer` / `validator`.
- Upgrade agents: change `AGENT_TAG` in `.env`, `docker compose pull && docker compose up -d`.
- Rotate keys: stop (`systemctl stop fula-hyperlane`), edit `.env`, start; a NEW validator key also
  needs a new multisig ISM on the Base router (see `docs/bridge-hyperlane-skale.md` §6).
- Move to a new box: back up `/opt/fula-hyperlane/.env` (keys!), run `install.sh` there, restore
  `.env` before starting. Databases are re-indexed from `index.from`; nothing is re-delivered.
- `sudo ./uninstall.sh` stops and removes the unit/cron, keeps keys and databases; `--purge` deletes all.

## Files

`docker-compose.yml` (pinned `ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.3.0`, shared
`./signatures` volume, localhost-only metrics, log rotation, memory limits) · `.env.example` ·
`config/agent-config.json` (from `yarn hl:agent-config:<lane>`; chain metadata + core addresses;
`interchainGasPaymaster` on the SKALE chain points at the ProtocolFee hook because we deploy no IGP)
· `healthcheck.sh` · `status.sh` · `uninstall.sh` · `selfcheck.sh` (developer: bash -n + shellcheck).

Security notes: keys live only in `/opt/fula-hyperlane/.env` (0600, root:hyperlane). The relayer is
whitelisted to our two routers, so free-gas spam on SKALE cannot make it spend Base ETH. Ports are
bound to 127.0.0.1. The containers run as the unprivileged `hyperlane` user.
