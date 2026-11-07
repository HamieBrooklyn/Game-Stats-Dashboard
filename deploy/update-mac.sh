#!/usr/bin/env bash
# Every 10 minutes (com.gamestats.update): if main moved on GitHub, pull it, run the collector's tests, and
# restart the collector (launchd starts it again at once). If the tests fail, it goes back to the commit that
# was running. The Mac only ever pulls: no GitHub runner, so nobody else's code runs here.

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
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  log "local changes in the checkout; not updating"
  exit 1
fi

log "updating ${current:0:7} -> ${latest:0:7}"
git merge --ff-only --quiet "origin/$BRANCH"
if ! (cd collector && "$NODE" --test test/*.test.js >/dev/null 2>&1); then
  log "tests failed on ${latest:0:7}; staying on ${current:0:7}"
  git reset --quiet --hard "$current"
  exit 1
fi

PID_FILE="$ROOT/collector/data/collector.pid"
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill -TERM "$(cat "$PID_FILE")"
  log "restarted the collector on ${latest:0:7}"
else
  log "updated to ${latest:0:7}; the collector wasn't running (launchd will start it)"
fi
