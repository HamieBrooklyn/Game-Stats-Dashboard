// The collector end to end against a fake Open Cloud: polling into SQLite, building views, the API's sign-in,
// ETags, CORS and the 404 / 401 paths, and shard detection.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const AT = Math.floor(Date.now() / 1000);
const hour = Math.floor(AT / 3600), day = Math.floor(AT / 86400);
const store = {
  [`H${hour}_0`]: { c: { hau: 3, 'hau_gap#new': 2, 'hau_gap#1': 1, robux: 40, dau: 3 }, m: { ccu: 4 } },
  [`D${day}_0`]: { c: { dau: 5, 'dau_gap#new': 3, 'dau_gap#2': 2, new_users: 3, session_sum: 1200, sessions_ended: 4, robux: 40, payers: 1, playtime: 2000 }, m: { ccu: 4 } },
  [`D${day}_1`]: { c: { dau: 2, 'dau_gap#new': 2, new_users: 2, robux: 10 }, m: { ccu: 2 } }, // a second shard
  [`C${day}`]: { size: 5, 'f#Onboarding:Joined': 5, 'f#Onboarding:RollCar': 3, 'ffar#Onboarding:Joined': 2, 'ffar#Onboarding:RollCar': 3 },
  FunnelDefs: { Version: 1, At: AT, Since: {}, Funnels: [{ Id: 'Onboarding', Title: 'Onboarding', Kind: 'Once', Steps: [{ Id: 'Joined', Label: 'Joined' }, { Id: 'RollCar', Label: 'Roll car' }] }] },
  Journeys: [{ U: 1, N: 'Alpha', T: AT - 60, L: 300, P: 'PC', C: 'SE', S: 1, F: 'RollCar', D: true, E: ['Onboarding:RollCar'], R: 0 }],
};
const feedback = { Meta: { Count: 2 }, Page_1: [
  { Id: 1, At: AT - 100, Name: 'Alpha', DisplayName: 'A', Text: '<b>love it</b>', Sentiment: 'Positive', Tags: ['Fun'], Status: 'Open', Device: { Platform: 'PC' }, Player: { Cash: 5 } },
  { Id: 2, At: AT - 50, Name: 'Beta', DisplayName: 'B', Text: 'too hard', Sentiment: 'Negative', Tags: [], Status: 'Resolved', ResolvedBy: 'Admin' },
] };
let requests = 0;

const fake = http.createServer((request, response) => {
  requests++;
  const url = new URL(request.url, 'http://x');
  const json = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.headers['x-api-key'] !== 'test-key') return json(401, { message: 'bad key' });
  if (url.pathname.endsWith('/entries/entry')) {
    const name = url.searchParams.get('datastoreName'), key = url.searchParams.get('entryKey');
    const source = name === 'Feedback_v1' ? feedback : store;
    return key in source ? json(200, source[key]) : json(404, { error: 'NOT_FOUND' });
  }
  if (url.pathname.endsWith('/entries')) {
    const prefix = url.searchParams.get('prefix');
    return json(200, { keys: Object.keys(store).filter((key) => key.startsWith(prefix)).map((key) => ({ key })) });
  }
  if (url.pathname.includes('/memory-store/sorted-maps/')) {
    return json(200, { items: [
      { id: 's:abc', value: { Id: 'abc12345', Players: 7, Names: ['x'], Version: 12, Uptime: 600, Fps: 60, Private: false, At: AT } },
      { id: 'l:leader', value: 'abc' },
    ] });
  }
  return json(404, {});
});

test('collector: polls, builds views and serves them privately', async (t) => {
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  process.env.OPEN_CLOUD_BASE = `http://127.0.0.1:${fake.address().port}`;
  const { openDatabase } = await import('../src/db.js');
  const { createClient } = await import('../src/opencloud.js');
  const { createPoller } = await import('../src/poller.js');
  const { buildViews } = await import('../src/views.js');
  const { createServer } = await import('../src/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-test-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  const games = [
    { id: 'g1', name: 'Game One', universeId: 1, store: 'Stats_v1', liveMap: 'Live', shards: 1, journeyFunnel: 'Onboarding', slot: 1, feedback: { store: 'Feedback_v1', pageSize: 50 } },
    { id: 'g2', name: 'Game Two', universeId: null, slot: 2 },
  ];
  const logs = [];
  const poller = createPoller({ games, client: createClient('test-key'), db, log: (line) => logs.push(line) });
  const { pollLive, pollBuckets, pollSlow, pollFeedback, detectShards } = poller._internal;

  await detectShards(games[0]);
  assert.equal(games[0].shards, 2, 'found the second shard');
  await pollLive(games[0]);
  await pollBuckets(games[0]);
  await pollSlow(games[0]);
  await pollFeedback(games[0], true);
  assert.ok(requests > 10);

  const views = buildViews(games, db);
  const overview = JSON.parse(views.get('/v1/overview?range=24h').json);
  assert.equal(overview.kpis.online, 7, 'live servers only (the leader lock is skipped)');
  assert.equal(overview.coverage.total, 2);
  assert.equal(overview.games.find((game) => game.id === 'g2').status.state, 'unconfigured');
  assert.equal(overview.games.find((game) => game.id === 'g1').status.state, 'ok');
  const week = JSON.parse(views.get('/v1/games/g1/overview?range=7d').json);
  const players = week.widgets[0].Items.find((item) => item.Label === 'New players');
  assert.equal(players.Value, 5, 'both shards added up');
  const funnels = JSON.parse(views.get('/v1/games/g1/funnels?range=7d').json);
  assert.ok(funnels.widgets.some((widget) => widget.Type === 'Funnel' && widget.Steps[1].Value === 3));
  const fb = JSON.parse(views.get('/v1/feedback').json);
  assert.equal(fb.items.length, 2);
  assert.equal(fb.items[0].id, 2, 'newest first');
  assert.equal(fb.items[1].text, '<b>love it</b>', 'text kept as text (the page escapes it)');
  assert.ok(!('player' in fb.items[1]) && !('Player' in fb.items[1]), 'no player snapshot');

  const server = createServer({
    secret: 'correct horse battery staple 1234',
    allowedOrigins: ['https://dash.example'],
    getView: (pathname, params) => views.get(params.get('range') ? `${pathname}?range=${params.get('range')}` : pathname) || null,
    health: () => ({ ok: true }),
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = { Origin: 'https://dash.example' };

  assert.equal((await fetch(`${base}/v1/overview?range=24h`, { headers: origin })).status, 401, 'needs a session');
  assert.equal((await fetch(`${base}/v1/overview?range=24h`, { headers: { Origin: 'https://evil.example' } })).status, 403, 'other origins refused');
  const wrong = await fetch(`${base}/v1/session`, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'nope' }) });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${base}/v1/session`, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'correct horse battery staple 1234' }) });
  assert.equal(right.status, 200);
  const { token } = await right.json();
  const auth = { ...origin, Authorization: `Bearer ${token}` };
  const first = await fetch(`${base}/v1/overview?range=24h`, { headers: auth });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('access-control-allow-origin'), 'https://dash.example');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(`${base}/v1/overview?range=24h`, { headers: { ...auth, 'If-None-Match': etag } });
  assert.equal(again.status, 304, 'unchanged view is not sent again');
  assert.equal((await fetch(`${base}/v1/games/nope/overview?range=24h`, { headers: auth })).status, 404);
  for (let i = 0; i < 5; i++) await fetch(`${base}/v1/session`, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: '{"secret":"x"}' });
  assert.equal((await fetch(`${base}/v1/session`, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: '{"secret":"x"}' })).status, 429, 'wrong secrets are rate-limited');

  server.close();
  fake.close();
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});
