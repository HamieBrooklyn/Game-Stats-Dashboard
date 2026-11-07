// The stats collector: reads every game's Spotlight Admin stats from Roblox Open Cloud, keeps them in SQLite and
// serves the dashboard's API. Run: node src/main.js (launchd keeps it running on the Mac; see deploy/).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createClient } from './opencloud.js';
import { createPoller } from './poller.js';
import { buildViews, gameStatus } from './views.js';
import { createServer } from './server.js';
import * as S from './stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// KEY=VALUE lines from collector/.env (never committed); real environment variables win
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function loadGames(file) {
  const games = JSON.parse(fs.readFileSync(file, 'utf8'));
  return games.map((game) => ({
    store: 'SpotlightAdminStats_v1',
    liveMap: 'SpotlightAdminStatsLive_v1',
    shards: 1,
    ...game,
  }));
}

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

export function main() {
  loadEnv(path.join(ROOT, '.env'));
  const required = ['ROBLOX_OPEN_CLOUD_API_KEY', 'DASHBOARD_SECRET', 'ALLOWED_ORIGINS'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing in collector/.env: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (process.env.DASHBOARD_SECRET.length < 24) {
    console.error('DASHBOARD_SECRET must be at least 24 characters.');
    process.exit(1);
  }
  const games = loadGames(process.env.GAMES_FILE || path.join(ROOT, 'games.json'));
  const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
  const db = openDatabase(path.join(dataDir, 'stats.db'));
  // For deploy/update-mac.sh: it stops this process after an update, and launchd starts the new code
  const pidFile = path.join(dataDir, 'collector.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  const client = createClient(process.env.ROBLOX_OPEN_CLOUD_API_KEY);

  let views = new Map();
  let lastBuild = 0;
  let buildQueued = false;
  const rebuild = () => {
    if (buildQueued) return;
    buildQueued = true;
    setTimeout(() => {
      buildQueued = false;
      try {
        views = buildViews(games, db);
        lastBuild = S.now();
      } catch (error) {
        log(`building views failed: ${error.stack || error}`);
      }
    }, Math.max(0, 5000 - (Date.now() - lastBuild * 1000)));
  };

  const poller = createPoller({ games, client, db, log, onChange: rebuild });

  function health() {
    const at = S.now();
    const sources = db.sources();
    const list = games.map((game) => ({ id: game.id, state: gameStatus(game, sources, (key) => db.entry(game.id, key)?.value, at).state }));
    const watched = list.filter((game) => game.state !== 'unconfigured' && game.state !== 'empty');
    return { ok: watched.length > 0 && watched.every((game) => game.state === 'ok'), games: list, viewsBuiltAt: lastBuild };
  }

  const server = createServer({
    secret: process.env.DASHBOARD_SECRET,
    allowedOrigins: process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    getView: (pathname, params) => {
      const range = params.get('range');
      return views.get(range ? `${pathname}?range=${range}` : pathname) || null;
    },
    health,
    log,
  });
  const port = Number(process.env.PORT || 8090);
  server.listen(port, '127.0.0.1', () => log(`collector listening on 127.0.0.1:${port}, ${games.length} games`));

  poller.start();
  views = buildViews(games, db);

  // Housekeeping: the dead-man ping, online samples kept 35 days, the daily backup
  const timers = [];
  timers.push(setInterval(() => {
    const url = process.env.HEALTHCHECK_URL;
    if (url) fetch(health().ok ? url : `${url}/fail`, { signal: AbortSignal.timeout(10000) }).catch(() => {});
  }, 60 * 1000));
  timers.push(setInterval(() => {
    db.pruneCcu(S.now() - 35 * 86400);
    try {
      db.backup(path.join(dataDir, 'backups'));
    } catch (error) {
      log(`backup failed: ${error.message}`);
    }
  }, 3600 * 1000));

  const shutdown = (signal) => {
    log(`${signal}: stopping`);
    poller.stop();
    for (const timer of timers) clearInterval(timer);
    server.close(() => {
      db.close();
      try {
        if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.rmSync(pidFile);
      } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
