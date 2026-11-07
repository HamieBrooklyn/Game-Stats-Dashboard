# Game Stats

A private dashboard for every game that has the [Spotlight Admin](https://github.com/HamieBrooklyn/Spotlight-Admin) panel: players, funnels, money, live servers and player feedback across all games, live, with light and dark themes.

```
Roblox game servers ── every 60 s ──> each game's DataStore + MemoryStore   (Spotlight Admin's built-in stats)
                                              │ Open Cloud, read-only key
                                              ▼
Mac: collector (Node 24, SQLite)  ── launchd, starts at boot, restarts if it stops
      reads every game, keeps a copy, builds the same numbers as the in-game panel, serves a private API
                                              │ Cloudflare Tunnel: https://stats-api.<your-domain>
                                              ▼
GitHub Pages: site/ (plain HTML/CSS/JS) ── polls the API: live every 15 s, the rest every 60 s
```

**Why it's accurate:** the games already write their stats to their own DataStores; the collector only reads them, so nothing is counted twice and nothing is lost when the Mac is off (it catches up). The numbers come from a port of the panel's own math, checked against the package's real Luau (`collector/test/parity.test.js`). Days and hours are UTC, like the panel. Buckets are re-read until they're final (15 minutes after their hour/day ended) and the last two days are re-read every hour. What the collector adds on top, the 15-second "players online" samples, is backed up daily.

**Intended differences from the in-game panel:** D1 shows "—" instead of 0% before a day is old enough; the hour or day still in progress is drawn dashed; the Live server list leaves out player names; there's no Lookup tab.

**Honest labels:** "Players" across games is a sum (someone who plays two games counts twice); per-game peaks aren't added up (the online line uses samples); D1 shows "—" until a day is old enough; Robux is what players spent (you keep about 70%).

## Pages

- **Overview**: all games (playing now, players, new, sessions, Robux, conversion, D1, players online over 24 h, every game's status) or one game (the panel's Overview tab).
- **Funnels**: one game's funnels (each player once per step), where players stop and quit, recent sessions.
- **Live**: players online and servers, every 15 seconds.
- **Feedback**: every game's feedback, newest first, filter by game, sentiment, status or text.

## Set up on the Mac (once)

1. **Node 24 and cloudflared**: `brew install node@24 cloudflared`
2. **Clone** this repo somewhere permanent, e.g. `~/Developer/Game-Stats-Dashboard`.
3. **Open Cloud key** (Creator Dashboard → Open Cloud → API Keys → Create): add every game's universe with
   - DataStores: **Read Entry** and **List Entry Keys**
   - Memory Stores: **Read sorted map** (`memory-store.sorted-map:read`)

   Nothing else: it never writes. Restrict it to your home IP if that's stable.
4. **`collector/.env`**: copy `collector/.env.example`, fill in the key, a dashboard secret (`openssl rand -base64 33`), and the site's origin (`https://hamiebrooklyn.github.io`, or your custom domain). Optional `HEALTHCHECK_URL`: a free [healthchecks.io](https://healthchecks.io) ping, so you get an email when the Mac or collection stops.
5. **Games**: copy `collector/games.json` to `collector/games.local.json` (git ignores it, so the Mac's checkout stays clean and keeps updating) and fill in each game's universe id (Creator Dashboard → the game → the id in the URL), its stats store (`SpotlightAdminStats_v1` unless the game set `stats.store`), live map, and `feedback` if it keeps feedback pages (`Meta` + `Page_N`).
   To change the list for everyone instead, edit `games.json` on GitHub.
6. **Tunnel**: `cloudflared tunnel login`, `cloudflared tunnel create game-stats`, `cloudflared tunnel route dns game-stats stats-api.<your-domain>`, then write `~/.cloudflared/config.yml` from `deploy/cloudflared.example.yml`.
7. **Install**: `sudo bash deploy/install-mac.sh` (it finds Homebrew's `node@24`; for a Node elsewhere: `sudo NODE_BIN=/path/to/node bash deploy/install-mac.sh`) — never sleep and restart after a power cut, the collector and tunnel start at boot, updates every 10 minutes (pull, test, restart; it rolls back if tests fail), logs rotate.
8. **Check**: `curl -s http://127.0.0.1:8090/health` says `"ok": true` once every game with stats is read (it only answers on the Mac itself).

After pulling changes to `deploy/` (the launchd files), run the install again; everything else updates by itself.

**FileVault:** with FileVault on, a Mac that restarts after a power cut waits at the unlock screen and nothing starts until someone logs in. For a stats box, either turn FileVault off (System Settings → Privacy & Security), or accept that a power cut needs you at the Mac. The stats themselves are safe either way (they live in the games' DataStores).

## Publish the site

1. Repo Settings → Pages → Source: **GitHub Actions**. Every push to `main` that touches `site/` publishes it.
2. Set your API address in `site/config.js` (`window.STATS_API = 'https://stats-api.<your-domain>'`).
3. Open the site and enter the dashboard secret. It's swapped for a 12-hour session kept in that tab only.

## Try it locally

`cd collector && npm run demo`, then open http://127.0.0.1:8091 (secret `demo-secret-demo-secret-1234`): made-up stats for two games through the real collector.

## Tests

`cd collector && npm test`: the port matches the package's Luau (`test/parity-data.lua` makes the fixture in Roblox Studio), and the collector end to end against a fake Open Cloud. CI runs them on every push.

## When a game gets stats

Update its Spotlight Admin copy (the package has the stats built in), pass its `stats` options, publish, then add its universe id to `games.json`. The dashboard shows "No stats yet" until its first stats arrive.
