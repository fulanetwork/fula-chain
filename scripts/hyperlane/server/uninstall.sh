#!/usr/bin/env bash
# Stops and removes the FULA Hyperlane agents. Keeps keys, .env and databases unless --purge.
#   sudo ./uninstall.sh            # stop containers, remove unit + cron, keep /opt/fula-hyperlane
#   sudo ./uninstall.sh --purge    # ALSO delete /opt/fula-hyperlane (keys, databases, signatures)
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/fula-hyperlane}"
SERVICE_NAME="fula-hyperlane"
PURGE=0; [ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/$SERVICE_NAME.service" /etc/cron.d/fula-hyperlane
systemctl daemon-reload
( cd "$INSTALL_DIR" 2>/dev/null && docker compose down --remove-orphans ) || true
if [ "$PURGE" = 1 ]; then
  echo "PURGING $INSTALL_DIR in 10s (keys and databases will be gone; Ctrl-C to abort)"; sleep 10
  rm -rf "$INSTALL_DIR"
  echo "purged."
else
  echo "stopped. $INSTALL_DIR kept (keys, .env, db). Re-run install.sh to restore."
fi
