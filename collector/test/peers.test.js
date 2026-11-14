// The genre benchmark (src/peers.js): other games in our games' Roblox genre, from Roblox's public data, and
// which source each benchmark card takes its 50th and 90th from (benchmarks.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeers, interval, peerSessions } from '../src/peers.js';
import { benchmarksWidget, quantile, rankOf, PUBLISHED } from '../src/benchmarks.js';
import { openDatabase } from '../src/db.js';
import * as S from '../src/stats.js';

test("a sample's interval: player-seconds, new visits and seconds, never across a gap or a counter going back", () => {
  assert.deepEqual(interval({ t: 0, playing: 10, visits: 100 }, { t: 600, playing: 30, visits: 140 }), { ps: 12000, dv: 40, cov: 600 });
  assert.equal(interval(null, { t: 600, playing: 1, visits: 1 }), null);
  assert.equal(interval({ t: 0, playing: 10, visits: 100 }, { t: 3600, playing: 10, visits: 200 }), null, 'gap');
  assert.equal(interval({ t: 0, playing: 10, visits: 100 }, { t: 600, playing: 10, visits: 90 }), null, 'went back');
});

test("a genre's spread: only games measured long enough with 100+ visits a day", () => {
  const hour = 3600;
  const rows = [
    { universe: 1, ps: 600 * 500, dv: 500, cov: 24 * hour }, // 10 min
    { universe: 2, ps: 300 * 200, dv: 200, cov: 24 * hour }, // 5 min
    { universe: 3, ps: 900 * 50, dv: 50, cov: 24 * hour }, // 50 visits a day: too small
    { universe: 4, ps: 600 * 500, dv: 500, cov: 2 * hour }, // 2 hours: too short
  ];
  const result = peerSessions(rows, 7);
  assert.deepEqual(result.values, [300, 600]);
  assert.equal(result.tracked, 4);
  assert.equal(result.hours, 24);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([10, 20], 0.9), 19);
  assert.equal(rankOf([1, 2, 3, 4], 3), 62.5);
  assert.equal(rankOf([1, 2, 3, 4], 0), 0);
});

test("finds games of our genre and measures their average session from Roblox's public numbers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peers-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  const games = [{ id: 'cars', name: 'Cars', universeId: 1 }];
  const world = new Map([
    [1, { id: 1, name: 'Cars', genre_l1: 'Simulation', genre_l2: 'Tycoon', playing: 5, visits: 1000 }],
    [2, { id: 2, name: 'Mansion Tycoon', genre_l1: 'Simulation', genre_l2: 'Tycoon', playing: 600, visits: 50000 }],
    [3, { id: 3, name: 'Raft Tycoon', genre_l1: 'Simulation', genre_l2: 'Tycoon', playing: 300, visits: 9000 }],
    [4, { id: 4, name: 'An Obby', genre_l1: 'Obby & Platformer', genre_l2: 'Tower Obby', playing: 900, visits: 5000 }],
    [5, { id: 5, name: 'Dead Tycoon', genre_l1: 'Simulation', genre_l2: 'Tycoon', playing: 0, visits: 10 }],
  ]);
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (url.includes('get-sorts')) return { sorts: [{ games: [{ universeId: 4 }, { universeId: 2 }] }] };
    if (url.includes('omni-search')) return { searchResults: [{ contents: [{ universeId: 3 }, { universeId: 5 }, { universeId: 1 }] }] };
    const ids = new URL(url).searchParams.get('universeIds').split(',').map(Number);
    assert.ok(ids.length <= 50);
    return { data: ids.map((id) => world.get(id)).filter(Boolean) };
  };
  const peers = createPeers({ games, db, log: () => {}, fetchJson, gapMs: 0, wait: async () => {} });
  await peers._internal.discover();
  assert.deepEqual(db.peer(1), { name: 'Cars', l1: 'Simulation', l2: 'Tycoon', own: true });
  assert.deepEqual(db.activePeers().sort(), [2, 3], 'same genre with players on; not the obby, not the empty one, not ours');
  assert.ok(urls.some((url) => url.includes('searchQuery=tycoon')), 'searched the genre');

  // Two samples 10 minutes apart: Mansion 600 online and 50 new visits -> 600 × 600 s ÷ 50 = 7200 s
  const realNow = Date.now;
  try {
    const start = 1_800_000_000;
    Date.now = () => start * 1000;
    await peers._internal.sample();
    world.get(2).visits += 50;
    world.get(3).visits += 300;
    Date.now = () => (start + 600) * 1000;
    await peers._internal.sample();
    const rows = db.peerHours({ l1: 'Simulation', l2: 'Tycoon' }, S.hourOf(start) - 1);
    const mansion = rows.find((row) => row.universe === 2);
    assert.equal(mansion.ps / mansion.dv, 7200);
    assert.equal(rows.length, 2, 'our own game is sampled but not one of its peers');
    assert.ok(db.peerLast(1), 'ours is sampled too');
  } finally {
    Date.now = realNow;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each card takes the best benchmark there is: Roblox's own, the genre measured live, another game's, the published one", () => {
  const AT = 20500 * 86400 + 12 * 3600;
  const read = (key) => (key === S.dayKey(20500, 0) ? { c: { dau: 10, session_sum: 6000, sessions_ended: 10 }, m: {} } : undefined);
  const game = { id: 'cars', universeId: 1, shards: 1 };
  const values = Array.from({ length: 20 }, (_, index) => 300 + index * 30); // 5 to 14.5 min
  const context = {
    genre: { l1: 'Simulation', l2: 'Tycoon' },
    peers: { 7: { values, count: 20, tracked: 25, hours: 30 }, 30: { values: [], count: 0, tracked: 25, hours: 30 } },
    others: [{ metrics: { d1: { p50: 0.12, p90: 0.16 }, conversion: { p50: 0.004, p90: 0.0122, value: 0.0023, pct: 36 } } }],
  };
  const widget = benchmarksWidget(game, read, AT, { metrics: { d7: { p50: 0.0145, p90: 0.0527 } } }, context);
  assert.equal(widget.Genre, 'Simulation → Tycoon');
  const [playtime, d1, d7, conversion, arppu, ptr] = widget.Windows[7];
  assert.equal(playtime.Source.Kind, 'genre');
  assert.match(playtime.Source.Label, /^20 Tycoon games on Roblox \(Simulation\), measured live over the last 30 h so far$/);
  assert.equal(playtime.Benchmark.P50, quantile(values, 0.5));
  assert.equal(playtime.Percentile, rankOf(values, 600), 'its place among those games');
  assert.equal(d1.Source.Kind, 'other');
  assert.equal(d7.Source.Kind, 'roblox');
  assert.equal(conversion.Source.Kind, 'other');
  assert.equal(conversion.FromRoblox, null, "another game's own value isn't this game's");
  assert.equal(arppu.Source, null, 'nothing anywhere');
  assert.equal(ptr.Benchmark, null, "play-through rate is only ever this game's own");
  // 30 days: no genre games measured that long yet -> the published medians
  assert.equal(widget.Windows[30][0].Source.Kind, 'published');
  assert.deepEqual(widget.Windows[30][0].Benchmark, { P50: PUBLISHED.playtime.p50, P90: PUBLISHED.playtime.p90 });
});
