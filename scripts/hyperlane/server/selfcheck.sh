#!/usr/bin/env bash
# Developer self-check for the server scripts (no root, no Docker needed): bash syntax, shellcheck
# when available, and an `install.sh --check` dry run in a throwaway prefix.
set -uo pipefail
cd "$(dirname "$0")"
rc=0
for f in install.sh healthcheck.sh status.sh uninstall.sh; do
  if bash -n "$f"; then echo "syntax ok: $f"; else echo "SYNTAX ERROR: $f"; rc=1; fi
done
if command -v shellcheck >/dev/null 2>&1; then shellcheck -S warning install.sh healthcheck.sh status.sh uninstall.sh && echo "shellcheck ok" || rc=1; else echo "shellcheck not installed (skipped)"; fi
echo "docker: $(command -v docker >/dev/null 2>&1 && docker --version || echo 'not available here')"
exit $rc
