#!/usr/bin/env bash
# =====================================================================================================
# FULA Base <-> SKALE Hyperlane agents — server installer (ONE Linux box: validator + relayer).
#
#   sudo ./install.sh --check                      # report what is missing / would change, touch nothing
#   sudo ./install.sh                              # install what is missing, (re)deploy config, start
#   sudo ./install.sh --base-router 0x.. --skale-router 0x..   (index.from comes from config/agent-config.json;
#                                                                --base-index-from/--skale-index-from are informational)
#   sudo ./install.sh --testnet                    # basesepolia <-> skalebasesepolia names + RPCs
#   sudo ./install.sh --no-start                   # install + configure, do not start containers
#
# Idempotent: re-running never regenerates existing keys, never overwrites a filled .env value with
# an empty one, and only (re)installs packages that are absent. Safe to run after every git pull.
#
# What it does, in order:
#   1. OS check (Debian/Ubuntu or RHEL-family), packages: curl jq git ca-certificates chrony
#      unattended-upgrades (Debian) / dnf-automatic (RHEL).
#   2. Docker Engine + compose plugin from Docker's official repository (not the distro's).
#   3. System user `hyperlane` (no shell), /opt/fula-hyperlane/{config,signatures,db-validator,db-relayer}.
#   4. Copies docker-compose.yml, agent-config.json, healthcheck.sh, status.sh, uninstall.sh; writes
#      .env from .env.example (keeps existing values), generates VALIDATOR_KEY/RELAYER_KEY if empty,
#      prints the two ADDRESSES (never the keys), renders RELAYER_WHITELIST from the router addresses.
#   5. systemd unit fula-hyperlane.service (docker compose up -d on boot), cron: healthcheck every 5 min.
#   6. Pulls the pinned agent image, starts, and runs a self-test (compose config valid, both containers
#      up, metrics answering, a checkpoint file appears within 5 min once the validator is announced).
#
# It NEVER: prints private keys, sends funds, touches the token contracts, or opens ports beyond
# 127.0.0.1 (metrics are localhost-only).
# =====================================================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/fula-hyperlane}"
SERVICE_NAME="fula-hyperlane"
AGENT_USER="hyperlane"
CHECK=0; START=1; TESTNET=0
BASE_ROUTER=""; SKALE_ROUTER=""; BASE_INDEX_FROM=""; SKALE_INDEX_FROM=""
changes=0; problems=0

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok  \033[0m %s\n' "$*"; }
todo() { printf '\033[1;33m  TODO\033[0m %s\n' "$*"; changes=$((changes+1)); }
bad()  { printf '\033[1;31m  BAD \033[0m %s\n' "$*"; problems=$((problems+1)); }
die()  { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$CHECK" = 1 ]; then todo "$*"; else log "$*"; "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --no-start) START=0 ;;
    --testnet) TESTNET=1 ;;
    --base-router) BASE_ROUTER="$2"; shift ;;
    --skale-router) SKALE_ROUTER="$2"; shift ;;
    --base-index-from) BASE_INDEX_FROM="$2"; shift ;;
    --skale-index-from) SKALE_INDEX_FROM="$2"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ "$(id -u)" = 0 ] || die "run as root (sudo)."
[ -f "$SELF_DIR/docker-compose.yml" ] || die "docker-compose.yml not found next to install.sh"
[ -f "$SELF_DIR/.env.example" ] || die ".env.example not found next to install.sh"

# ------------------------------------------------------------------ 1. OS + packages
. /etc/os-release
PKG=""
case "${ID_LIKE:-$ID} $ID" in
  *debian*|*ubuntu*) PKG=apt ;;
  *rhel*|*fedora*|*centos*|*rocky*|*alma*) PKG=dnf ;;
  *) die "unsupported distribution: $ID ($PRETTY_NAME). Debian/Ubuntu or RHEL-family only." ;;
esac
log "OS: $PRETTY_NAME (package manager: $PKG)  mode: $([ "$CHECK" = 1 ] && echo CHECK || echo INSTALL)"

need_pkgs=()
for p in curl jq git ca-certificates python3; do command -v "$p" >/dev/null 2>&1 || need_pkgs+=("$p"); done
if [ "$PKG" = apt ]; then
  command -v chronyd >/dev/null 2>&1 || systemctl is-active --quiet systemd-timesyncd || need_pkgs+=(chrony)
  dpkg -s unattended-upgrades >/dev/null 2>&1 || need_pkgs+=(unattended-upgrades)
else
  command -v chronyd >/dev/null 2>&1 || need_pkgs+=(chrony)
  rpm -q dnf-automatic >/dev/null 2>&1 || need_pkgs+=(dnf-automatic)
fi
if [ ${#need_pkgs[@]} -gt 0 ]; then
  if [ "$CHECK" = 1 ]; then todo "install packages: ${need_pkgs[*]}"; else
    log "installing packages: ${need_pkgs[*]}"
    if [ "$PKG" = apt ]; then DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${need_pkgs[@]}"; else dnf install -y -q "${need_pkgs[@]}"; fi
  fi
else ok "base packages present (curl jq git ca-certificates, time sync, unattended updates)"; fi
if [ "$CHECK" = 0 ]; then
  if [ "$PKG" = apt ]; then systemctl enable --now chrony >/dev/null 2>&1 || systemctl enable --now chronyd >/dev/null 2>&1 || true
    dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
  else systemctl enable --now chronyd >/dev/null 2>&1 || true; systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 || true; fi
fi

# ------------------------------------------------------------------ 2. Docker
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker $(docker --version | sed 's/Docker version //;s/,.*//') + compose $(docker compose version --short)"
else
  if [ "$CHECK" = 1 ]; then todo "install Docker Engine + compose plugin from download.docker.com"; else
    log "installing Docker Engine + compose plugin"
    if [ "$PKG" = apt ]; then
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
      DEBIAN_FRONTEND=noninteractive apt-get update -q
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
    else
      dnf -y -q install dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      dnf install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
    fi
  fi
fi
if [ "$CHECK" = 0 ]; then
  systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "docker daemon is not running (try: systemctl start docker)"
fi

# ------------------------------------------------------------------ 3. user + directories
if id "$AGENT_USER" >/dev/null 2>&1; then ok "system user $AGENT_USER exists (uid $(id -u $AGENT_USER))"; else
  run useradd --system --create-home --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$AGENT_USER"
fi
if [ "$CHECK" = 0 ]; then AGENT_UID=$(id -u "$AGENT_USER"); AGENT_GID=$(id -g "$AGENT_USER"); else AGENT_UID=1000; AGENT_GID=1000; fi
for d in "" config signatures db-validator db-relayer; do
  p="$INSTALL_DIR/$d"
  if [ -d "$p" ]; then ok "dir $p"; else run install -d -m 0750 -o "$AGENT_USER" -g "$AGENT_USER" "$p"; fi
done

# ------------------------------------------------------------------ 4. files + .env + keys
for f in docker-compose.yml healthcheck.sh status.sh uninstall.sh; do
  if [ -f "$INSTALL_DIR/$f" ] && cmp -s "$SELF_DIR/$f" "$INSTALL_DIR/$f"; then ok "$f up to date"; else run install -m 0640 -o root -g "$AGENT_USER" "$SELF_DIR/$f" "$INSTALL_DIR/$f"; fi
done
[ "$CHECK" = 0 ] && chmod 0750 "$INSTALL_DIR"/*.sh 2>/dev/null || true
if [ -f "$SELF_DIR/config/agent-config.json" ]; then
  if [ -f "$INSTALL_DIR/config/agent-config.json" ] && cmp -s "$SELF_DIR/config/agent-config.json" "$INSTALL_DIR/config/agent-config.json"; then ok "agent-config.json up to date"; else run install -m 0640 -o root -g "$AGENT_USER" "$SELF_DIR/config/agent-config.json" "$INSTALL_DIR/config/agent-config.json"; fi
else
  [ -f "$INSTALL_DIR/config/agent-config.json" ] && ok "agent-config.json present (no new copy shipped)" || bad "config/agent-config.json missing: generate it with 'yarn hl:agent-config' in the repo and copy it next to install.sh"
fi

ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then run install -m 0600 -o root -g "$AGENT_USER" "$SELF_DIR/.env.example" "$ENV_FILE"; fi
# read a value from .env
envget() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
# set a value in .env (only if CHECK=0)
envset() {
  local k="$1" v="$2"
  if [ "$CHECK" = 1 ]; then todo "set $k in .env"; return; fi
  if grep -qE "^$k=" "$ENV_FILE"; then
    # use a temp file to avoid sed escaping issues with JSON values
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp" && cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else echo "$k=$v" >> "$ENV_FILE"; fi
}
[ "$CHECK" = 0 ] && chmod 0600 "$ENV_FILE" && chown root:"$AGENT_USER" "$ENV_FILE"

if [ "$TESTNET" = 1 ]; then
  envset BASE_CHAIN basesepolia; envset SKALE_CHAIN skalebasesepolia
  envset BASE_CHAIN_UPPER BASESEPOLIA; envset SKALE_CHAIN_UPPER SKALEBASESEPOLIA
  envset BASE_RPC https://base-sepolia-rpc.publicnode.com
  envset SKALE_RPC https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha
fi
envset AGENT_UID "$AGENT_UID"; envset AGENT_GID "$AGENT_GID"
[ -n "$BASE_INDEX_FROM" ] && envset BASE_INDEX_FROM "$BASE_INDEX_FROM"
[ -n "$SKALE_INDEX_FROM" ] && envset SKALE_INDEX_FROM "$SKALE_INDEX_FROM"

# keys: generate only if empty (32 random bytes from /dev/urandom); print addresses only.
addr_of() { # address of a hex private key, via a throwaway node container (no local node needed)
  docker run --rm -e K="$1" node:22-alpine sh -c 'npm -s i ethers@6 >/dev/null 2>&1 && node -e "console.log(new (require(\"ethers\").Wallet)(process.env.K).address)"' 2>/dev/null
}
for role in VALIDATOR RELAYER; do
  cur="$(envget ${role}_KEY)"
  if [ -n "$cur" ]; then ok "${role}_KEY present"; else
    if [ "$CHECK" = 1 ]; then todo "generate ${role}_KEY"; else
      k="0x$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; envset "${role}_KEY" "$k"; log "generated ${role}_KEY"
    fi
  fi
done
if [ "$CHECK" = 0 ]; then
  VADDR="$(addr_of "$(envget VALIDATOR_KEY)")"; RADDR="$(addr_of "$(envget RELAYER_KEY)")"
  envset VALIDATOR_ADDRESS "$VADDR"; envset RELAYER_ADDRESS "$RADDR"
  log "VALIDATOR address: $VADDR   (needs a little gas on the SKALE chain for the announce tx)"
  log "RELAYER   address: $RADDR   (needs ETH on Base for deliveries + a little SKALE gas)"
fi

# whitelist from router addresses
if [ -n "$BASE_ROUTER" ] && [ -n "$SKALE_ROUTER" ]; then
  wl=$(printf '[{"senderAddress":["%s","%s"],"recipientAddress":["%s","%s"]}]' "$BASE_ROUTER" "$SKALE_ROUTER" "$BASE_ROUTER" "$SKALE_ROUTER")
  envset RELAYER_WHITELIST "$wl"; envset BASE_ROUTER "$BASE_ROUTER"; envset SKALE_ROUTER "$SKALE_ROUTER"
elif [ "$(envget RELAYER_WHITELIST)" = "[]" ] || [ -z "$(envget RELAYER_WHITELIST)" ]; then
  bad "RELAYER_WHITELIST is empty: pass --base-router 0x.. --skale-router 0x.. (the relayer must only serve OUR routers)"
else ok "RELAYER_WHITELIST set"; fi

# ------------------------------------------------------------------ 5. systemd + cron
UNIT=/etc/systemd/system/$SERVICE_NAME.service
unit_body="[Unit]
Description=FULA Hyperlane agents (validator + relayer)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
"
if [ -f "$UNIT" ] && [ "$(cat "$UNIT")" = "$unit_body" ]; then ok "systemd unit $SERVICE_NAME"; else
  if [ "$CHECK" = 1 ]; then todo "write $UNIT and enable it"; else printf '%s' "$unit_body" > "$UNIT"; systemctl daemon-reload; systemctl enable "$SERVICE_NAME" >/dev/null 2>&1; log "systemd unit installed + enabled"; fi
fi
CRON=/etc/cron.d/fula-hyperlane
cron_body="*/5 * * * * root $INSTALL_DIR/healthcheck.sh >> /var/log/fula-hyperlane-health.log 2>&1
"
if [ -f "$CRON" ] && [ "$(cat "$CRON")" = "$cron_body" ]; then ok "cron healthcheck every 5 min"; else
  if [ "$CHECK" = 1 ]; then todo "install $CRON (healthcheck every 5 min)"; else printf '%s' "$cron_body" > "$CRON"; chmod 0644 "$CRON"; log "cron installed"; fi
fi

# ------------------------------------------------------------------ 6. start + self-test
if [ "$CHECK" = 1 ]; then
  echo; log "check complete: $changes change(s) would be made, $problems problem(s) need input."
  [ "$problems" = 0 ] && exit 0 || exit 2
fi
[ "$problems" = 0 ] || die "$problems problem(s) above must be fixed before starting."
cd "$INSTALL_DIR"
docker compose config -q || die "docker compose config is invalid"
ok "compose config valid"
docker compose pull -q
if [ "$START" = 1 ]; then
  systemctl start "$SERVICE_NAME"
  sleep 8
  for c in fula-hl-validator fula-hl-relayer; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ]; then ok "$c running"; else bad "$c NOT running — see: docker logs $c"; fi
  done
  for port in 9090 9091; do
    if curl -fsS "http://127.0.0.1:$port/metrics" >/dev/null 2>&1; then ok "metrics on :$port"; else bad "no metrics on :$port (agent may still be starting; re-check with status.sh)"; fi
  done
  log "waiting up to 5 min for the first validator checkpoint (needs the validator to be announced + funded)..."
  for i in $(seq 1 30); do
    if [ -n "$(ls -A "$INSTALL_DIR/signatures" 2>/dev/null)" ]; then ok "validator wrote checkpoints to signatures/"; break; fi
    sleep 10
    [ "$i" = 30 ] && bad "no checkpoint yet — fund the validator address on the SKALE chain and check: docker logs fula-hl-validator"
  done
fi
echo; log "done: $problems problem(s). Next: ./status.sh ; docker logs -f fula-hl-relayer"
[ "$problems" = 0 ] && exit 0 || exit 2
