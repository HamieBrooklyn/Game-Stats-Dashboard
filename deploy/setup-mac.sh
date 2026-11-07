#!/usr/bin/env bash
# Sets up the Game Stats collector on this Mac, start to finish. Run it in Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/HamieBrooklyn/Game-Stats-Dashboard/main/deploy/setup-mac.sh | bash
#
# (or `bash deploy/setup-mac.sh` from a clone). Safe to run again: it keeps what's already set up.
# It asks for your Open Cloud key (hidden) and your Mac password (for the boot services). At the end it prints
# the dashboard secret (sign in with it) and the Mac's address for the site.
#
# Steps: Homebrew Node 24 -> clone to ~/Developer/Game-Stats-Dashboard -> collector/.env + games.local.json ->
# key check -> tests -> boot services (install-mac.sh) -> Tailscale Serve (HTTPS on your tailnet) -> health.

set -euo pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || fail "This is for macOS."
DIR="${GAME_STATS_DIR:-$HOME/Developer/Game-Stats-Dashboard}"
REPO="https://github.com/HamieBrooklyn/Game-Stats-Dashboard.git"
PORT=8090
SERVE_PORT=8443

say "1/7  Homebrew and Node 24"
BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x "$candidate" ]] && BREW="$candidate" && break; done
[[ -n "$BREW" ]] || fail "Install Homebrew first (https://brew.sh), then run this again."
eval "$("$BREW" shellenv)"
brew list node@24 >/dev/null 2>&1 || brew install node@24
NODE="$(brew --prefix node@24)/bin/node"
[[ -x "$NODE" ]] || fail "Node 24 didn't install ($NODE)."
echo "Node $("$NODE" --version) at $NODE"
command -v git >/dev/null || fail "git is missing: run xcode-select --install, then run this again."

say "2/7  The code ($DIR)"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" pull --ff-only --quiet
  echo "Updated."
else
  [[ "$DIR" =~ [[:space:]] ]] && fail "Pick a folder without spaces: GAME_STATS_DIR=/path bash setup-mac.sh"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet "$REPO" "$DIR"
  echo "Cloned."
fi
cd "$DIR"

say "3/7  Settings (collector/.env, collector/games.local.json)"
ENV="$DIR/collector/.env"
if [[ -f "$ENV" ]]; then
  echo "collector/.env already exists: kept."
else
  echo "Paste the Open Cloud API key (Creator Dashboard -> Open Cloud -> API Keys). It won't show while you type."
  read -rs -p "Key: " KEY < /dev/tty
  echo
  [[ -n "$KEY" ]] || fail "No key given."
  SECRET="$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40)"
  umask 077
  cat > "$ENV" <<EOF
ROBLOX_OPEN_CLOUD_API_KEY=$KEY
DASHBOARD_SECRET=$SECRET
ALLOWED_ORIGINS=https://pokepon.org
PORT=$PORT
# HEALTHCHECK_URL=https://hc-ping.com/<uuid>   (optional: emails you when the Mac or collection stops)
EOF
  umask 022
  unset KEY
  chmod 600 "$ENV"
  echo "Wrote collector/.env (only you can read it)."
fi
[[ -f "$DIR/collector/games.local.json" ]] || cp "$DIR/collector/games.json" "$DIR/collector/games.local.json"
echo "Games: collector/games.local.json (add a game's universeId there when it gets stats)."

say "4/7  Checking the key against the games"
(cd "$DIR/collector" && "$NODE" scripts/check.js) || fail "Fix the key's permissions above (or edit collector/.env), then run this again."

say "5/7  Tests"
(cd "$DIR/collector" && "$NODE" --test test/*.test.js >/tmp/game-stats-tests.log 2>&1) || fail "Tests failed: see /tmp/game-stats-tests.log"
echo "All pass."

say "6/7  Boot services (asks for your Mac password)"
sudo NODE_BIN="$NODE" bash "$DIR/deploy/install-mac.sh"
for _ in $(seq 1 30); do
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" && break
  sleep 2
done
curl -s --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null || fail "The collector isn't answering: see $DIR/logs/collector.log"
echo "The collector is running."

say "7/7  Tailscale Serve (the HTTPS address the site calls)"
TS=""
for candidate in "$(command -v tailscale || true)" /Applications/Tailscale.app/Contents/MacOS/Tailscale; do [[ -n "$candidate" && -x "$candidate" ]] && TS="$candidate" && break; done
ADDRESS=""
if [[ -z "$TS" ]]; then
  echo "Tailscale isn't installed: install it (https://tailscale.com/download/mac), sign in, and run this again."
else
  "$TS" serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$PORT" >/dev/null || echo "tailscale serve failed: turn on MagicDNS and HTTPS certificates in the Tailscale admin (DNS page), then run this again."
  NAME="$("$TS" status --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})')"
  [[ -n "$NAME" ]] && ADDRESS="https://$NAME:$SERVE_PORT"
fi

SECRET_NOW="$(sed -n 's/^DASHBOARD_SECRET=//p' "$ENV" | tail -1)"
say "Done"
echo "Collector health: $(curl -s --max-time 3 "http://127.0.0.1:$PORT/health")"
[[ -n "$ADDRESS" ]] && echo "The Mac's address for the site: $ADDRESS   (send this to Claude, or put it in site/config.js)"
echo "Dashboard: https://pokepon.org/Game-Stats-Dashboard/"
echo "Sign in with this secret (keep it in your password manager): $SECRET_NOW"
echo "Logs: $DIR/logs   Settings: $DIR/collector/.env, $DIR/collector/games.local.json"
