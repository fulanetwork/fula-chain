#!/usr/bin/env bash
# Cron health check for the FULA Hyperlane agents (every 5 min, installed by install.sh).
# Checks: containers up, metrics answering, validator checkpoint age, relayer Base ETH balance,
# and pings the external heartbeat. Prints one line per check; alerts via ALERT_WEBHOOK if set.
set -uo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/fula-hyperlane}"
cd "$INSTALL_DIR" || exit 1
set -a; . ./.env; set +a
ts="$(date -u +%FT%TZ)"
fail=0; msgs=()
say() { echo "$ts $1"; }
alert() { fail=1; msgs+=("$1"); say "ALERT $1"; }

for c in fula-hl-validator fula-hl-relayer; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ]; then say "ok $c running"; else alert "$c not running"; fi
done
for port in 9090 9091; do
  curl -fsS -m 5 "http://127.0.0.1:$port/metrics" >/dev/null 2>&1 && say "ok metrics :$port" || alert "metrics :$port unreachable"
done

# validator checkpoint age: newest file in signatures/
newest="$(find signatures -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1)"
if [ -n "$newest" ]; then
  age=$(( $(date +%s) - ${newest%.*} ))
  if [ "$age" -le "${VALIDATOR_MAX_CHECKPOINT_AGE_SEC:-900}" ]; then say "ok checkpoint age ${age}s"; else
    # A stale checkpoint is only a problem if the SKALE mailbox has dispatched something newer; the
    # validator signs only when the tree changes. Report as warning, alert only if very old (6h).
    [ "$age" -gt 21600 ] && alert "validator checkpoint is ${age}s old" || say "warn checkpoint age ${age}s (no new SKALE messages?)"
  fi
else alert "no validator checkpoints on disk"; fi

# relayer Base ETH balance (JSON-RPC, no node needed)
if [ -n "${RELAYER_ADDRESS:-}" ] && [ -n "${BASE_RPC:-}" ]; then
  hex="$(curl -fsS -m 10 -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$RELAYER_ADDRESS\",\"latest\"]}" "$BASE_RPC" | jq -r .result 2>/dev/null)"
  if [ -n "$hex" ] && [ "$hex" != "null" ]; then
    eth="$(printf '%s' "$hex" | python3 -c 'import sys; print(int(sys.stdin.read().strip(),16)/1e18)' 2>/dev/null || echo "")"
    if [ -n "$eth" ]; then
      awk -v e="$eth" -v m="${RELAYER_MIN_BASE_ETH:-0.005}" 'BEGIN{exit !(e+0 < m+0)}' && alert "relayer Base ETH low: $eth" || say "ok relayer Base ETH $eth"
    fi
  else say "warn could not read relayer balance"; fi
fi

# disk
use="$(df -P "$INSTALL_DIR" | awk 'NR==2{gsub("%","",$5); print $5}')"
[ "${use:-0}" -lt 90 ] && say "ok disk ${use}%" || alert "disk ${use}% used"

# heartbeat (external dead-man's switch) — only when everything above passed
if [ -n "${HEARTBEAT_URL:-}" ]; then
  if [ "$fail" = 0 ]; then curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1 && say "ok heartbeat" || say "warn heartbeat ping failed"; else say "skip heartbeat (failures above)"; fi
fi

if [ "$fail" = 1 ] && [ -n "${ALERT_WEBHOOK:-}" ]; then
  text="fula-hyperlane $(hostname): $(IFS='; '; echo "${msgs[*]}")"
  curl -fsS -m 10 -H 'content-type: application/json' --data "$(jq -cn --arg t "$text" '{text:$t}')" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
fi
exit $fail
