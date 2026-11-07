#!/usr/bin/env bash
# Checks how deploy/update-mac.sh reads PORT from collector/.env, under the script's own `set -euo pipefail`
# (a grep that finds nothing must not stop the update). Run: bash deploy/test-update-port.sh (CI runs it).
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
start="$(grep -n '^PORT="\$({ grep' "$ROOT_DIR/deploy/update-mac.sh" | cut -d: -f1)"
[[ -n "$start" ]] || { echo "FAIL: PORT lines not found in update-mac.sh"; exit 1; }
lines="$(sed -n "${start},$((start + 1))p" "$ROOT_DIR/deploy/update-mac.sh")"
work="$(mktemp -d)"
mkdir -p "$work/collector"
failed=0

check() { # check <.env content or __NONE__> <expected port>
  rm -f "$work/collector/.env"
  [[ "$1" == __NONE__ ]] || printf 'A=1\n%s\n' "$1" > "$work/collector/.env"
  local got
  got="$(bash -c "set -euo pipefail; ROOT='$work'; $lines; echo \"\$PORT\"")" || { echo "FAIL [$1]: the update stopped"; failed=1; return; }
  if [[ "$got" == "$2" ]]; then echo "ok   [$1] -> $got"; else echo "FAIL [$1] -> $got (expected $2)"; failed=1; fi
}

check 'PORT=9000' 9000
check 'PORT="9001"' 9001
check "PORT='9002'" 9002
check '  PORT = 9003 # the port' 9003
check 'X=1' 8090
check 'PORT=abc' 8090
check __NONE__ 8090
rm -rf "$work"
exit "$failed"
