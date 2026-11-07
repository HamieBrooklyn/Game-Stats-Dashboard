// Regression tests for what the council's round-2 review found: the documented MemoryStore response shape and
// its pagination, per-source health, partial online totals, stale live counts, deleted feedback, signed
// sessions across restarts, bad request bodies, private /health, and ETags that really repeat.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const tempDb = async () => {
  const { openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-reg-'));
  return { db: openDatabase(path.join(dir, 'stats.db')), dir };
};

test('MemoryStore: reads the documented { items, nextPageToken } shape across pages', async () => {
  // Shape from Roblox's API reference: ListMemoryStoreSortedMapItemsResponse
  const pages = {
    '': { items: [{ path: 'cloud/v2/universes/1/memory-store/sorted-maps/m/items/s:a', id: 's:a', value: { Players: 3 }, etag: 'x', expireTime: '2030-01-01T00:00:00Z' }], nextPageToken: 'p2' },
    p2: { items: [{ id: 's:b', value: { Players: 4 } }, { id: 'l:leader', value: 'a' }] },
  };
  const tokens = [];
  const fake = http.createServer((request, response) => {
    const token = new URL(request.url, 'http://x').searchParams.get('pageToken') || '';
    tokens.push(token);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pages[token]));
  });
  process.env.OPEN_CLOUD_BASE = await listen(fake);
  const { createClient } = await import('../src/opencloud.js?shape');
  const items = await createClient('k').sortedMapItems(1, 'm');
  fake.close();
  assert.deepEqual(tokens, ['', 'p2'], 'followed nextPageToken');
  assert.deepEqual(items.map((item) => item.id), ['s:a', 's:b', 'l:leader']);
  assert.equal(items[1].value.Players, 4);
});

test('status: failing DataStore reads are not hidden by working live reads', async () => {
  const { gameStatus } = await import('../src/views.js');
  const game = { id: 'g', universeId: 1 };
  const at = 100000;
  const read = (key) => (key === 'FunnelDefs' ? {} : undefined);
  const rows = (store, live) => [{ game: 'g', source: 'datastore', ...store }, { game: 'g', source: 'live', ...live }];
  // DataStore last good an hour ago, failing since; live fine
  let status = gameStatus(game, rows({ ok_at: at - 3600, error_at: at - 10, error: '403 forbidden' }, { ok_at: at - 5 }), read, at);
  assert.equal(status.state, 'error');
  assert.match(status.detail, /403/);
  // One failed read right after a good one is a blip, not an outage
  status = gameStatus(game, rows({ ok_at: at - 50, error_at: at - 5, error: '500' }, { ok_at: at - 5 }), read, at);
  assert.equal(status.state, 'ok');
  // Live servers unread for minutes: stale
  status = gameStatus(game, rows({ ok_at: at - 30 }, { ok_at: at - 600, error_at: at - 5, error: 'timeout' }), read, at);
  assert.equal(status.state, 'stale');
  // A DataStore that never worked
  status = gameStatus(game, rows({ error_at: at - 5, error: '403' }, { ok_at: at - 5 }), read, at);
  assert.equal(status.state, 'error');
});

test('online total: a bin missing a game is a gap, not a drop', async () => {
  const { onlineSeries } = await import('../src/views.js');
  const at = 1_000_000_200;
  const games = [{ id: 'a', name: 'A', slot: 1 }, { id: 'b', name: 'B', slot: 2 }];
  const start = Math.floor((at - 86400) / 300) * 300;
  const samples = [
    { game: 'a', t: start + 10, players: 10 }, { game: 'b', t: start + 20, players: 20 }, // bin 0: both
    { game: 'a', t: start + 310, players: 10 }, // bin 1: B missing (its collection failed)
    { game: 'a', t: start + 610, players: 10 }, { game: 'b', t: start + 620, players: 20 }, // bin 2: both
  ];
  const online = onlineSeries(games, samples, at);
  assert.equal(online.total[0], 30);
  assert.equal(online.total[1], null, 'partial bin left out, not a drop to 10');
  assert.equal(online.total[2], 30);
  // A game added later doesn't blank the bins from before its first sample
  const later = onlineSeries(games, [{ game: 'a', t: start + 10, players: 10 }, { game: 'a', t: start + 310, players: 10 }, { game: 'b', t: start + 320, players: 5 }], at);
  assert.equal(later.total[0], 10, 'before B existed, A alone is the total');
  assert.equal(later.total[1], 15);
});

test('playing now: unknown while any reporting game is unknown', async () => {
  const { playingNow } = await import('../src/views.js');
  const ok = { state: 'ok' };
  assert.equal(playingNow([{ status: ok, online: 5 }, { status: ok, online: 7 }, { status: { state: 'unconfigured' }, online: null }]), 12);
  assert.equal(playingNow([{ status: ok, online: 5 }, { status: { state: 'stale' }, online: null }]), null);
  assert.equal(playingNow([{ status: { state: 'unconfigured' }, online: null }]), null);
});

test('views: stale live counts are not shown; ETags repeat when nothing changed', async () => {
  const { buildViews } = await import('../src/views.js');
  const { db, dir } = await tempDb();
  const game = { id: 'g', name: 'G', universeId: 1, shards: 1, slot: 1 };
  // Mid 5-minute bin, so the 7 s later rebuild stays in the same bins (crossing one rightly changes the view)
  const at = Math.floor(Date.now() / 1000 / 300) * 300 + 100;
  db.putEntry('g', '$live', [{ Id: 'x', Players: 9, Version: 1, Uptime: 1, Fps: 60, Private: false }], at - 600, false);
  db.sourceOk('g', 'datastore', at);
  db.sourceOk('g', 'live', at);
  const first = buildViews([game], db, at);
  const overview = JSON.parse(first.get('/v1/overview?range=24h').json);
  assert.equal(overview.kpis.online, null, 'a 10-minute-old count is not "playing now" (and no partial total)');
  assert.equal(overview.games[0].online, null);
  const again = buildViews([game], db, at + 7);
  assert.equal(again.get('/v1/overview?range=7d').etag, first.get('/v1/overview?range=7d').etag, 'same content, same ETag');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('feedback: entries deleted in the game go away', async () => {
  const { db, dir } = await tempDb();
  db.replaceFeedbackPage('g', 1, 50, [{ Id: 1, At: 1, Text: 'a' }, { Id: 2, At: 2, Text: 'b' }]);
  db.replaceFeedbackPage('g', 51, 100, [{ Id: 51, At: 3, Text: 'c' }]);
  db.replaceFeedbackPage('g', 1, 50, [{ Id: 2, At: 2, Text: 'b (edited)' }]);
  const ids = db.feedback().map((row) => row.entry.Id).sort((a, b) => a - b);
  assert.deepEqual(ids, [2, 51], 'entry 1 deleted, other pages untouched');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server: sessions survive a restart, bad bodies are 400, /health is private', async () => {
  const { createServer } = await import('../src/server.js');
  const options = { secret: 'a-long-enough-secret-for-tests-123', allowedOrigins: ['https://d.example'], getView: () => ({ json: '{}', etag: '"e"' }), health: () => ({ ok: true }), log: () => {} };
  const origin = { Origin: 'https://d.example', 'Content-Type': 'application/json' };
  let server = createServer(options);
  let base = await listen(server);
  assert.equal((await fetch(`${base}/v1/session`, { method: 'POST', headers: origin, body: 'null' })).status, 401, 'null body: just a wrong secret');
  assert.equal((await fetch(`${base}/v1/session`, { method: 'POST', headers: origin, body: '{nope' })).status, 400);
  const { token } = await (await fetch(`${base}/v1/session`, { method: 'POST', headers: origin, body: JSON.stringify({ secret: options.secret }) })).json();
  assert.equal((await fetch(`${base}/health`, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 404, 'not through the tunnel');
  assert.equal((await fetch(`${base}/health`)).status, 200, 'on the Mac itself');
  server.close();
  server = createServer(options); // a restart
  base = await listen(server);
  assert.equal((await fetch(`${base}/v1/overview`, { headers: { ...origin, Authorization: `Bearer ${token}` } })).status, 200, 'still signed in');
  assert.equal((await fetch(`${base}/v1/overview`, { headers: { ...origin, Authorization: `Bearer ${token}x` } })).status, 401, 'tampered token');
  const expired = `${Date.now() - 1000}.${token.split('.')[1]}`;
  assert.equal((await fetch(`${base}/v1/overview`, { headers: { ...origin, Authorization: `Bearer ${expired}` } })).status, 401, 'expired or re-dated token');
  server.close();
  const other = createServer({ ...options, secret: 'a-different-secret-for-tests-4567' });
  base = await listen(other);
  assert.equal((await fetch(`${base}/v1/overview`, { headers: { ...origin, Authorization: `Bearer ${token}` } })).status, 401, 'a new secret signs everyone out');
  other.close();
});

test('.env: the collector and deploy/update-mac.sh read PORT the same way', async () => {
  const { parseEnvValue } = await import('../src/main.js');
  assert.equal(parseEnvValue('9000'), '9000');
  assert.equal(parseEnvValue('"9001"'), '9001');
  assert.equal(parseEnvValue("'9002'"), '9002');
  assert.equal(parseEnvValue('9003 # the port'), '9003');
  assert.equal(parseEnvValue('abc#def'), 'abc#def', 'a # inside a secret stays');
  assert.equal(parseEnvValue('"a # b"'), 'a # b', 'quoted values are kept whole');
});

test('server: a preflight from the site may reach a private (Tailscale) address', async () => {
  const { createServer } = await import('../src/server.js');
  const server = createServer({ secret: 'a-long-enough-secret-for-tests-123', allowedOrigins: ['https://d.example'], getView: () => null, health: () => ({ ok: true }), log: () => {} });
  const base = await listen(server);
  const response = await fetch(`${base}/v1/overview`, { method: 'OPTIONS', headers: { Origin: 'https://d.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  const other = await fetch(`${base}/v1/overview`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(other.status, 403, 'only for the site itself');
  server.close();
});
