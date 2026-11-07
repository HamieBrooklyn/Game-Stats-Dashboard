// Local demo: a fake Open Cloud with made-up stats for two games, the real collector against it, and the site
// served from site/. For trying the dashboard without a key or a Mac.
//   node scripts/demo.js   then open http://127.0.0.1:8091  (secret: demo-secret-demo-secret-1234)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(ROOT, '..', 'site');
const AT = Math.floor(Date.now() / 1000);
let seed = 7;
const int = (a, b) => a + ((seed = (seed * 16807) % 2147483647) % (b - a + 1));

const ONBOARDING = ['Joined', 'LoadingScreenDone', 'IntroFinished', 'RollCar', 'ClaimCar', 'PlaceCar', 'CollectCash', 'TutorialComplete', 'DailyRewardClaimed', 'Roll5', 'AchievementsOpen', 'Roll10'];
const labelOf = (id) => id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/^(.)(.*)$/, (_, a, b) => a + b.toLowerCase());

function gameStore(scale) {
  const data = {};
  const hour = Math.floor(AT / 3600), day = Math.floor(AT / 86400);
  const bucket = (size, hourly) => {
    const players = Math.round(size * scale);
    const c = {
      dau: players, hau: players, new_users: Math.round(players * 0.35), sessions: Math.round(players * 1.4), sessions_ended: Math.round(players * 1.3),
      session_sum: Math.round(players * 1.3 * int(500, 900)), playtime: Math.round(players * int(900, 1600)), robux: Math.round(players * int(2, 9)), payers: Math.round(players * 0.04),
      'fu#Shop:Opened': Math.round(players * 0.5), 'fu#Shop:ItemPrompted': Math.round(players * 0.2), 'fu#Shop:Purchased': Math.round(players * 0.03),
      'funnel#Shop:01:Opened': Math.round(players * 0.9), 'funnel#Shop:02:ItemPrompted': Math.round(players * 0.3), 'funnel#Shop:03:Purchased': Math.round(players * 0.04),
    };
    c[`${hourly ? 'hau' : 'dau'}_gap#new`] = c.new_users;
    c[`${hourly ? 'hau' : 'dau'}_gap#1`] = Math.round(players * 0.4);
    c[`${hourly ? 'hau' : 'dau'}_gap#old`] = players - c.new_users - Math.round(players * 0.4);
    return { c, m: { ccu: Math.round(players / (hourly ? 3 : 12)) } };
  };
  for (let h = hour - 47; h <= hour; h++) {
    const local = ((h % 24) + 24) % 24;
    data[`H${h}_0`] = bucket(40 + 30 * Math.sin(((local - 8) / 24) * Math.PI * 2) + int(0, 12), true);
  }
  for (let d = day - 59; d <= day; d++) data[`D${d}_0`] = bucket(600 + (d - day) * 3 + int(0, 120), false);
  for (let d = day - 30; d <= day; d++) {
    const size = Math.round(int(150, 260) * scale);
    const counts = { size, d1: Math.round(size * 0.22), d7: Math.round(size * 0.07) };
    let reach = size;
    ONBOARDING.forEach((step, index) => {
      reach = Math.round(reach * (index === 2 ? 0.86 : index === 8 ? 0.8 : 0.95));
      counts[`f#Onboarding:${step}`] = reach;
      counts[`fpt#Onboarding:${step}`] = reach * (25 + index * 35);
      counts[`ffar#Onboarding:${step}`] = Math.round(reach * 0.04);
      counts[`fq1#Onboarding:${step}`] = Math.round(reach * (index === 2 ? 0.1 : 0.03));
    });
    data[`C${d}`] = counts;
  }
  const funnels = [
    { Id: 'Onboarding', Title: 'Onboarding', Kind: 'Once', Description: "A new player's first steps: loading, the intro, the tutorial, then the first rolls.", Steps: ONBOARDING },
    { Id: 'Comeback', Title: 'Coming back', Kind: 'Once', Description: 'How far new players come back.', Steps: ['Session2', 'Session3', 'Day2', 'Session5', 'Day3', 'Day7'] },
    { Id: 'Shop', Title: 'Shop', Kind: 'Repeat', Description: 'Every attempt is counted, and each player once a day at each step.', Steps: ['Opened', 'ItemPrompted', 'Purchased'] },
  ];
  data.FunnelDefs = { Version: 12, At: AT, Since: {}, Funnels: funnels.map((funnel) => ({ ...funnel, Steps: funnel.Steps.map((id) => ({ Id: id, Label: labelOf(id) })) })) };
  for (const funnel of funnels) for (const step of funnel.Steps) data.FunnelDefs.Since[`${funnel.Id}:${step}`] = AT - 9 * 86400;
  data.Journeys = Array.from({ length: 24 }, (_, index) => {
    const furthest = ONBOARDING[int(0, ONBOARDING.length - 1)];
    return { U: 1000 + index, N: `Player${1000 + index}`, T: AT - index * 900, L: int(40, 4000), P: ['PC', 'Mobile', 'Tablet', 'Console'][int(0, 3)], C: 'SE', S: int(1, 5), F: furthest, D: furthest === 'Roll10', E: [`Onboarding:${furthest}`], R: int(0, 3) === 0 ? 99 : 0 };
  });
  data.Markers = { Version: 12, List: [{ T: AT - 3 * 86400, Kind: 'Update', Text: 'Version 12' }] };
  return data;
}

const universes = { 101: gameStore(1), 102: gameStore(0.35) };
const feedback = {
  Meta: { Count: 6 },
  Page_1: [
    { Id: 1, At: AT - 86400 * 2, Name: 'carbuilder', DisplayName: 'Car Builder', Text: 'Love the new mutations! Could we get a way to sort the inventory by rarity?', Sentiment: 'Positive', Tags: ['Suggestion'], Status: 'Resolved', ResolvedBy: 'Mrloadd', Device: { Platform: 'PC' } },
    { Id: 2, At: AT - 86400, Name: 'speedy_k', DisplayName: 'Speedy', Text: 'The tutorial arrow sometimes points at the wrong stand on mobile.', Sentiment: 'Negative', Tags: ['Bug', 'Mobile'], Status: 'Open', Device: { Platform: 'Mobile' } },
    { Id: 3, At: AT - 7200, Name: 'nova', DisplayName: 'Nova', Text: 'Car shows are so fun <3', Sentiment: 'Positive', Tags: [], Status: 'Open', Device: { Platform: 'Tablet' } },
    { Id: 4, At: AT - 3600, Name: 'rollmaster', DisplayName: 'Roll Master', Text: 'Rebirth costs feel too high after rebirth 5.', Sentiment: 'Neutral', Tags: ['Balance'], Status: 'Open', Device: { Platform: 'PC' } },
    { Id: 5, At: AT - 1800, Name: 'ghost', DisplayName: 'Ghost', Text: '<script>alert(1)</script> just testing', Sentiment: 'Neutral', Tags: [], Status: 'Open', Device: { Platform: 'PC' } },
    { Id: 6, At: AT - 600, Name: 'luna', DisplayName: 'Luna', Text: 'Please add a trading system!', Sentiment: 'Positive', Tags: ['Suggestion'], Status: 'Open', Device: { Platform: 'Console' } },
  ],
};

const fake = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  const universe = Number(url.pathname.split('/')[4]); // /datastores/v1/universes/<id>/... or /cloud/v2/universes/<id>/...
  const store = universes[universe] || {};
  if (url.pathname.endsWith('/entries/entry')) {
    const source = url.searchParams.get('datastoreName') === 'Feedback_v1' ? feedback : store;
    const key = url.searchParams.get('entryKey');
    return key in source ? json(200, source[key]) : json(404, {});
  }
  if (url.pathname.endsWith('/entries')) return json(200, { keys: Object.keys(store).filter((key) => key.startsWith(url.searchParams.get('prefix'))).map((key) => ({ key })) });
  if (url.pathname.includes('/memory-store/')) {
    const count = universe === 101 ? 3 : 1;
    return json(200, { items: Array.from({ length: count }, (_, index) => ({ id: `s:${universe}${index}`, value: { Id: `${universe}${index}abcdef`, Players: int(4, 20), Names: [], Version: 12 - (index === 2 ? 1 : 0), Uptime: int(300, 40000), Fps: int(55, 60), Private: false, At: Math.floor(Date.now() / 1000) } })) });
  }
  return json(404, {});
});

const site = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  if (url.pathname === '/config.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    return response.end("window.STATS_API = 'http://127.0.0.1:8090';");
  }
  const file = path.join(SITE, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); return response.end(); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  response.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(file).pipe(response);
});

fake.listen(8099, '127.0.0.1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-demo-'));
  const gamesFile = path.join(dir, 'games.json');
  fs.writeFileSync(gamesFile, JSON.stringify([
    { id: 'roll-a-car-show', name: 'Roll a Car Show', universeId: 101, store: 'Stats_v1', liveMap: 'StatsLive_v1', journeyFunnel: 'Onboarding', slot: 1, feedback: { store: 'Feedback_v1', pageSize: 50 } },
    { id: 'cut-the-chocolate', name: 'Cut The Chocolate', universeId: 102, slot: 2 },
    { id: 'find-the-pirate-coin', name: 'Find The Pirate Coin', universeId: null, slot: 3 },
    { id: 'keyboard-farm', name: 'Keyboard Farm', universeId: null, slot: 4 },
  ]));
  Object.assign(process.env, {
    OPEN_CLOUD_BASE: 'http://127.0.0.1:8099', ROBLOX_OPEN_CLOUD_API_KEY: 'demo', DASHBOARD_SECRET: 'demo-secret-demo-secret-1234',
    ALLOWED_ORIGINS: 'http://127.0.0.1:8091', GAMES_FILE: gamesFile, DATA_DIR: dir, PORT: '8090',
  });
  // 24 hours of online samples, as if the collector had been running
  const { openDatabase } = await import('../src/db.js');
  const db = openDatabase(path.join(dir, 'stats.db'));
  for (let t = AT - 86400; t < AT; t += 60) {
    const local = Math.floor(t / 3600) % 24;
    const wave = Math.max(4, 40 + 28 * Math.sin(((local - 8) / 24) * Math.PI * 2));
    if (t > AT - 9 * 3600 && t < AT - 8.5 * 3600) continue; // a gap: the collector was off
    db.addCcu('roll-a-car-show', t, Math.round(wave + int(0, 6)), 3);
    db.addCcu('cut-the-chocolate', t, Math.round(wave * 0.35 + int(0, 3)), 1);
  }
  db.close();
  (await import('../src/main.js')).main();
  site.listen(8091, '127.0.0.1', () => console.log('Demo: open http://127.0.0.1:8091  (secret: demo-secret-demo-secret-1234)'));
});
