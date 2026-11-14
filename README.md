# Game Stats

A private dashboard for every game that has the [Spotlight Admin](https://github.com/HamieBrooklyn/Spotlight-Admin) panel: players, funnels, money, live servers and player feedback across all games, live, with light and dark themes.

```
Roblox game servers ── every 60 s ──> each game's DataStore + MemoryStore   (Spotlight Admin's built-in stats)
                                              │ Open Cloud, read-only key
                                              ▼
Mac: collector (Node 24, SQLite)  ── launchd, starts at boot, restarts if it stops
      reads every game, keeps a copy, builds the same numbers as the in-game panel, serves the site and its API
                                              │ http://127.0.0.1:8090, published by its own Cloudflare Tunnel
                                              ▼
Browser: https://stats.pokepon.org ── sign in with Roblox (invite only), sees only their games
```

**Why it's accurate:** the games already write their stats to their own DataStores; the collector only reads them, so nothing is counted twice and nothing is lost when the Mac is off (it catches up). The numbers come from a port of the panel's own math, checked against the package's real Luau (`collector/test/parity.test.js`). Days and hours are UTC, like the panel. Buckets are re-read until they're final (15 minutes after their hour/day ended) and the last two days are re-read every hour. What the collector adds on top, the 15-second "players online" samples and the sales feed (what each read of an hour bucket added), is backed up daily.

**Intended differences from the in-game panel:** D1 shows "—" instead of 0% before a day is old enough; the hour or day still in progress is drawn dashed; the Live server list leaves out player names; there's no Lookup tab.

**Honest labels:** "Players" across games is a sum (someone who plays two games counts twice); per-game peaks aren't added up (the online line uses samples); D1 shows "—" until a day is old enough; Robux is what players spent (you keep about 70%).

## Pages

- **Overview**: all games (playing now, players, new, sessions, Robux, conversion, D1, players online over 24 h, every game's status) or one game (the panel's Overview tab).
- **Funnels**: one game's funnels (each player once per step), where players stop and quit, recent sessions.
- **Monetization**: one game or all of them.
  - **Sales right now:** this hour, the hour before, today and yesterday, plus a feed of the latest sales (about 1–2 minutes behind: servers merge every minute and the collector reads every minute).
  - **What to change:** suggestions on prices and prompts.
  - **Robux and purchases over time**, and each item over time.
  - **Every item:** price now, prompts, purchases, rate, Robux and its change, share, Robux per prompt.
  - **Price history:** every price change of the last 60 days, before and after.
  - **Where prompts come from**, and minutes played before the first purchase.

  The tiles and item numbers are the in-game panel's Money tab. Suggestions are things to test, not sure things:
  - An item that clearly sells far more easily than the game's typical item (and to at least 1 in 10 prompts) → try a higher price.
  - One that clearly sells far less easily, or not at all → try a lower one.
  - Hundreds of prompts and under 1% buying → show it at a better moment first.
  - A price change that earns less per prompt than before → undo it.

  "Clearly" means beyond a 90% interval, so a few lucky sales don't count. An item's price is what its sales cost (Robux ÷ purchases per day), so price changes are found without any setup. Rates and most suggestions need the game to report prompts (`Stats.prompt`) as well as purchases.
- **Live**: players online and servers, every 15 seconds.
- **Feedback**: every game's feedback, newest first, filter by game, sentiment, status or text.

## Set up on the Mac (once)

**Quick way:** in Terminal on the Mac run

```
curl -fsSL https://raw.githubusercontent.com/HamieBrooklyn/Game-Stats-Dashboard/main/deploy/setup-mac.sh | bash
```

It does the steps below (asks for the key and your Mac password), checks the key against every game (`collector/scripts/check.js`), and prints the dashboard's address and secret. Safe to run again.

The steps by hand:

1. **Node 24**: `brew install node@24`, or the official build from nodejs.org (it shares nothing with Homebrew; pass its path as `NODE_BIN` in step 7).
2. **Clone** this repo somewhere permanent, e.g. `~/Developer/Game-Stats-Dashboard`.
3. **Open Cloud key** (Creator Dashboard → Open Cloud → API Keys → Create): add every game's universe with
   - DataStores: **Read Entry** and **List Entry Keys**
   - Memory Stores: **Read sorted map** (`memory-store.sorted-map:read`)

   Nothing else: it never writes. Restrict it to your home IP if that's stable.
4. **`collector/.env`**: copy `collector/.env.example`, fill in the key, a dashboard secret (`openssl rand -base64 33`), and `ALLOWED_ORIGINS` as in the example. Optional `HEALTHCHECK_URL`: a free [healthchecks.io](https://healthchecks.io) ping, so you get an email when the Mac or collection stops.
5. **Games**: copy `collector/games.json` to `collector/games.local.json` (git ignores it, so the Mac's checkout stays clean and keeps updating) and fill in each game's universe id (Creator Dashboard → the game → the id in the URL), its stats store (`SpotlightAdminStats_v1` unless the game set `stats.store`), live map, and `feedback` if it keeps feedback pages (`Meta` + `Page_N`).
   To change the list for everyone instead, edit `games.json` on GitHub.
6. **Public address** (optional; without it the dashboard is only on this Mac). Its own Cloudflare Tunnel, so another tunnel on the Mac is never touched:
   ```
   cloudflared tunnel create game-stats
   # write ~/.cloudflared/game-stats.yml from deploy/cloudflared.example.yml, then:
   cloudflared --config ~/.cloudflared/game-stats.yml tunnel route dns --overwrite-dns <tunnel id> stats.<your-domain>
   ```
   Pass `--config` (and the tunnel id) to `route dns`: without it, cloudflared takes the tunnel from `~/.cloudflared/config.yml` and points the name at that tunnel instead. Add the address to `ALLOWED_ORIGINS` and set `PUBLIC_URL`.
7. **Install**: `sudo bash deploy/install-mac.sh` (it finds Homebrew's `node@24`; for a Node elsewhere: `sudo NODE_BIN=/path/to/node bash deploy/install-mac.sh`) — never sleep and restart after a power cut, the collector (and the optional tunnel) start at boot, updates every 10 minutes (pull, test, restart; it rolls back if tests fail), logs rotate.
8. **Check**: `curl -s http://127.0.0.1:8090/health` says `"ok": true` once every game with stats is read (it only answers on the Mac itself).

After pulling changes to `deploy/` (the launchd files), run the install again; everything else updates by itself.

**FileVault:** with FileVault on, a Mac that restarts after a power cut waits at the unlock screen and nothing starts until someone logs in. For a stats box, either turn FileVault off (System Settings → Privacy & Security), or accept that a power cut needs you at the Mac. The stats themselves are safe either way (they live in the games' DataStores).

## Open the dashboard

https://stats.pokepon.org (or http://127.0.0.1:8090 on the Mac).

## Sign in with Roblox, invites and permissions

- **Who gets in:** only people with an invite. The owner makes a link on the **People** page (or `node scripts/invite.js` on the Mac); it works once and expires in 7 days. After that they're a member and sign in with Roblox any time. Removing someone on People signs them out at once.
- **What they see:** at every sign-in, Roblox's consent screen asks which experiences to share and only lists ones their Roblox account can access. They see the dashboard's games among those, and nothing else: the all-games totals and feedback are built from their games alone. The owner sees every game. Signing in again updates their games.
- **What's kept:** their Roblox user id, username, display name and which of the games they shared. Roblox's tokens are used once at sign-in and revoked.
- **The owner's secret** (`DASHBOARD_SECRET`) still signs in as the owner, from the Mac or anywhere: it's the fallback if Roblox sign-in breaks.

**Setting it up (once):**
1. Creator Dashboard → **OAuth 2.0 Apps** → Create. Redirect URL: `https://stats.pokepon.org/auth/callback`. Permissions: `openid`, `profile`, and one experience permission, `universe.user-restriction:read` (that's what makes Roblox ask which experiences to share; the dashboard never uses it to read anything). Only some app categories offer experience permissions: switch the App Category until it's listed. Another one works too: put the full list in `ROBLOX_OAUTH_SCOPES`.
2. Put its client id and secret in `collector/.env` (`ROBLOX_OAUTH_CLIENT_ID`, `ROBLOX_OAUTH_CLIENT_SECRET`) with `PUBLIC_URL`, and restart the collector.
3. Make your own owner invite on the Mac: `cd collector && node scripts/invite.js --owner`, open it, sign in with Roblox.

An app Roblox hasn't reviewed works for up to 10 different Roblox accounts; for more, submit it for review.

## Host the site somewhere else (optional)

`site/` also works from GitHub Pages: set `window.STATS_API` in `site/config.js` to an HTTPS address for the collector (step 6) and add the site's origin to `ALLOWED_ORIGINS`. Every push to `main` that touches `site/` publishes it.

## Try it locally

`cd collector && npm run demo`, then open http://127.0.0.1:8091 (secret `demo-secret-demo-secret-1234`): made-up stats for two games through the real collector.

## Tests

`cd collector && npm test`: the port matches the package's Luau (`test/parity-data.lua` makes the fixture in Roblox Studio), and the collector end to end against a fake Open Cloud. CI runs them on every push.

## When a game gets stats

Update its Spotlight Admin copy (the package has the stats built in), pass its `stats` options, publish, then add its universe id to `games.json`. The dashboard shows "No stats yet" until its first stats arrive.
