#!/usr/bin/env bash
# Every 10 minutes (com.gamestats.update): if main moved on GitHub, pull it, run the collector's tests, and
# restart the collector (launchd starts it again at once). If the tests fail, or the new collector doesn't
# answer /health within a minute, it goes back to the commit that was running. The Mac only ever pulls: no
# GitHub runner, so nobody else's code runs here. Changes to deploy/ need `sudo bash deploy/install-mac.sh`.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NODE="${NODE_BIN:-node}"
BRANCH="${DEPLOY_BRANCH:-main}"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# (launchd never overlaps runs of the same job)

git fetch --quiet origin "$BRANCH"
current="$(git rev-parse HEAD)"
latest="$(git rev-parse "origin/$BRANCH")"
if [[ "$current" == "$latest" ]]; then
  exit 0
fi
# A commit that passed the tests but didn't start is skipped until a newer one is pushed
BAD="$ROOT/collector/data/bad-commit"
if [[ -f "$BAD" && "$(cat "$BAD")" == "$latest" ]]; then
  exit 0
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  # (the Mac's own games list belongs in collector/games.local.json, which git ignores)
  log "local changes to tracked files; not updating: $(git status --porcelain --untracked-files=no | tr '\n' ' ')"
  exit 1
fi

log "updating ${current:0:7} -> ${latest:0:7}"
git merge --ff-only --quiet "origin/$BRANCH"
if ! (cd collector && "$NODE" --test test/*.test.js >/dev/null 2>&1); then
  log "tests failed on ${latest:0:7}; staying on ${current:0:7} (and skipping ${latest:0:7})"
  echo "$latest" > "$BAD"
  git reset --quiet --hard "$current"
  exit 1
fi

PID_FILE="$ROOT/collector/data/collector.pid"
# The collector's port: PORT in collector/.env (read like the collector does: quotes and a trailing comment
# allowed), else 8090
# (grep finds nothing when PORT isn't set: `|| true` keeps set -e / pipefail from stopping the update here)
PORT="$({ grep -E '^[[:space:]]*PORT[[:space:]]*=' "$ROOT/collector/.env" 2>/dev/null || true; } | tail -1 | sed -e 's/^[^=]*=//' -e 's/#.*//' | tr -d "\"' \t\r")"
[[ "$PORT" =~ ^[0-9]+$ ]] || PORT=8090
# The collector's pid, only if that process really is the collector (a pid can be reused after a crash)
collector_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid; pid="$(cat "$PID_FILE")"
  ps -p "$pid" -o command= 2>/dev/null | grep -q 'src/main.js' && echo "$pid"
}
restart() {
  local pid; pid="$(collector_pid || true)"
  [[ -n "$pid" ]] && kill -TERM "$pid"
  # launchd starts it again; wait for a new process that answers /health (200 or 503 both mean it runs)
  for _ in $(seq 1 30); do
    sleep 2
    local now; now="$(collector_pid || true)"
    if [[ -n "$now" && "$now" != "$pid" ]]; then
      local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health" || true)"
      [[ "$code" == 200 || "$code" == 503 ]] && return 0
    fi
  done
  return 1
}

if restart; then
  log "restarted the collector on ${latest:0:7}"
else
  log "the collector didn't come back on ${latest:0:7}; going back to ${current:0:7} (and skipping ${latest:0:7})"
  echo "$latest" > "$BAD"
  git reset --quiet --hard "$current"
  restart || log "the collector doesn't start on ${current:0:7} either: check logs/collector.log"
  exit 1
fi
