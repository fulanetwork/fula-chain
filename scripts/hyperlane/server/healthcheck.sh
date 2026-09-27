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

# agent wallet balances (JSON-RPC, no node needed). The relayer pays Base gas for every SKALE->Base
# delivery — running dry is the most common self-hosted bridge outage. Both agents also need a
# non-zero (free) SKALE balance to send transactions there.
balance_of() { # addr rpc -> decimal native balance or ""
  local hex; hex="$(curl -fsS -m 10 -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$1\",\"latest\"]}" "$2" | jq -r .result 2>/dev/null)"
  [ -n "$hex" ] && [ "$hex" != "null" ] && printf '%s' "$hex" | python3 -c 'import sys; print(int(sys.stdin.read().strip(),16)/1e18)' 2>/dev/null || true
}
if [ -n "${RELAYER_ADDRESS:-}" ] && [ -n "${BASE_RPC:-}" ]; then
  eth="$(balance_of "$RELAYER_ADDRESS" "$BASE_RPC")"
  if [ -n "$eth" ]; then awk -v e="$eth" -v m="${RELAYER_MIN_BASE_ETH:-0.005}" 'BEGIN{exit !(e+0 < m+0)}' && alert "relayer Base ETH low: $eth" || say "ok relayer Base ETH $eth"; else say "warn could not read relayer Base balance"; fi
fi
if [ -n "${SKALE_RPC:-}" ]; then
  for who in RELAYER VALIDATOR; do
    addr="$(eval "echo \${${who}_ADDRESS:-}")"; [ -n "$addr" ] || continue
    b="$(balance_of "$addr" "$SKALE_RPC")"
    if [ -n "$b" ]; then awk -v e="$b" 'BEGIN{exit !(e+0 < 0.0001)}' && alert "$who SKALE gas balance ~0 ($b): claim from the faucet" || say "ok $who SKALE gas $b"; else say "warn could not read $who SKALE balance"; fi
  done
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
