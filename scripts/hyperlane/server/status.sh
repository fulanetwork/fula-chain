#!/usr/bin/env bash
# One-screen status of the FULA Hyperlane agents.
set -uo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/fula-hyperlane}"
cd "$INSTALL_DIR" || exit 1
set -a; . ./.env; set +a
echo "== fula-hyperlane @ $(hostname)  $(date -u +%FT%TZ)"
echo "   lane: $BASE_CHAIN <-> $SKALE_CHAIN   image: $AGENT_TAG"
echo "   validator: ${VALIDATOR_ADDRESS:-?}   relayer: ${RELAYER_ADDRESS:-?}"
echo "   routers: base ${BASE_ROUTER:-?}  skale ${SKALE_ROUTER:-?}"
echo
docker compose ps 2>/dev/null || echo "(docker compose ps failed)"
echo
newest="$(find signatures -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1)"
if [ -n "$newest" ]; then echo "latest checkpoint: $(date -u -d @${newest%%.*} +%FT%TZ)  ($(basename "${newest#* }"))"; else echo "latest checkpoint: none yet"; fi
echo "signatures: $(find signatures -type f 2>/dev/null | wc -l) files   db: validator $(du -sh db-validator 2>/dev/null | cut -f1) relayer $(du -sh db-relayer 2>/dev/null | cut -f1)   disk: $(df -h . | awk 'NR==2{print $5}') used"
echo
echo "-- relayer metrics (delivered / retries)"
curl -fsS -m 5 http://127.0.0.1:9091/metrics 2>/dev/null | grep -E '^hyperlane_(messages_processed_count|submitter_queue_length|operations_processed_count)' | head -12 || echo "(no metrics)"
echo
echo "-- last relayer log lines"
docker logs --tail 8 fula-hl-relayer 2>&1 | cut -c1-200
echo
echo "-- last health check"
tail -6 /var/log/fula-hyperlane-health.log 2>/dev/null || echo "(no health log yet)"
