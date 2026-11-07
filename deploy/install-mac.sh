#!/usr/bin/env bash
# One-time setup of the collector on the Mac that runs it 24/7. Run from the repo: sudo bash deploy/install-mac.sh
# Run it again after pulling changes to deploy/ (the launchd files are only installed here).
#
# What it does:
# - Power: never sleep, restart after a power cut (pmset). See the FileVault note in README.md.
# - Services start at BOOT, not login (LaunchDaemons, run as your user):
#     com.gamestats.collector  node collector/src/main.js, restarted if it stops
#     com.gamestats.tunnel     cloudflared (the dashboard's API hostname -> 127.0.0.1:8090)
#     com.gamestats.update     every 10 minutes: pull, test, restart (deploy/update-mac.sh)
# - Logs rotate (newsyslog), and collector/.env is readable by you only.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/install-mac.sh" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$ROOT" =~ [[:space:]] ]]; then
  echo "Move the repo to a folder without spaces ($ROOT): launchd and log rotation files can't hold them." >&2
  exit 1
fi
RUN_USER="${SUDO_USER:-$(stat -f %Su "$ROOT")}"
# The first that exists. node@24 is keg-only (not on PATH); its /opt path is stable across brew upgrades,
# unlike the versioned Cellar path it points into, so that path is used as is (never resolved).
first_existing() { for candidate in "$@"; do [[ -n "$candidate" && -x "$candidate" ]] && { echo "$candidate"; return 0; }; done; return 0; }
NODE="$(first_existing "${NODE_BIN:-}" /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node \
  "$(sudo -u "$RUN_USER" zsh -lc 'command -v node' 2>/dev/null || true)")"
CLOUDFLARED="$(first_existing "${CLOUDFLARED_BIN:-}" /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared \
  "$(sudo -u "$RUN_USER" zsh -lc 'command -v cloudflared' 2>/dev/null || true)")"
LOGS="$ROOT/logs"
if [[ -n "${NODE_BIN:-}" && ! -x "$NODE_BIN" ]]; then echo "NODE_BIN=$NODE_BIN isn't an executable file." >&2; exit 1; fi

if [[ -z "$NODE" ]]; then echo "Install Node 24 first (brew install node@24), or set NODE_BIN=/path/to/node." >&2; exit 1; fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 24 )); then echo "$NODE is Node $NODE_MAJOR; the collector needs 24+ (built-in SQLite). Set NODE_BIN." >&2; exit 1; fi
echo "Node: $NODE"
if [[ ! -f "$ROOT/collector/.env" ]]; then
  echo "Create collector/.env first (copy collector/.env.example and fill it in)." >&2
  exit 1
fi

echo "Power: no sleep, restart after a power cut, wake for network"
pmset -a sleep 0 disksleep 0 autorestart 1 womp 1

mkdir -p "$LOGS" "$ROOT/collector/data"
chown -R "$RUN_USER" "$LOGS" "$ROOT/collector/data"
chmod 600 "$ROOT/collector/.env"
chown "$RUN_USER" "$ROOT/collector/.env"

install_daemon() {
  local label="$1" template="$2"
  local target="/Library/LaunchDaemons/$label.plist"
  sed -e "s#__ROOT__#$ROOT#g" -e "s#__USER__#$RUN_USER#g" -e "s#__NODE__#$NODE#g" -e "s#__CLOUDFLARED__#$CLOUDFLARED#g" \
    "$ROOT/deploy/$template" > "$target"
  chown root:wheel "$target"
  chmod 644 "$target"
  launchctl bootout system "$target" 2>/dev/null || true
  launchctl bootstrap system "$target"
  echo "Started $label"
}

install_daemon com.gamestats.collector com.gamestats.collector.plist
install_daemon com.gamestats.update com.gamestats.update.plist
if [[ -n "$CLOUDFLARED" && -f "/Users/$RUN_USER/.cloudflared/config.yml" ]]; then
  install_daemon com.gamestats.tunnel com.gamestats.tunnel.plist
else
  echo "Skipped the tunnel: install cloudflared and create ~/.cloudflared/config.yml first (README.md), then run this again."
fi

sed -e "s#__ROOT__#$ROOT#g" -e "s#__USER__#$RUN_USER#g" "$ROOT/deploy/newsyslog.conf" > /etc/newsyslog.d/gamestats.conf
echo "Log rotation: /etc/newsyslog.d/gamestats.conf"

echo
echo "Done. Check: curl -s http://127.0.0.1:8090/health"
