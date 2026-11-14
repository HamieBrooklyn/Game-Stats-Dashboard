// Roblox's benchmark cards, live (src/benchmarks.js), the paste reader (site/assets/benchparse.js) and the owner's
// save endpoint. The numbers are a real Roblox Benchmarks section (Analytics → Overview, 7 day average).

import test from 'node:test';
import assert from 'node:assert/strict';
import { percentileOf, measure, METRICS, benchmarksWidget, cleanBenchmarks, normCdf, normInv } from '../src/benchmarks.js';
import { parseRobloxBenchmarks, toStored } from '../../site/assets/benchparse.js';
import { createServer } from '../src/server.js';
import * as S from '../src/stats.js';

// What copying Roblox's section gives (each piece of text on its own line)
const COPIED = `Benchmarks based on
experiences with similar players
For home recommendation signals, visit Acquisition.
7 day average
Average playtime (7 day average)
10.3 min
↓ 9.2%
22nd
50th
12.9 min
90th
18.9 min
Day 1 retention (7 day average)
14.40%
↑ 7.8%
64th
50th
12.30%
90th
16.14%
Day 7 retention (7 day average)
1.03%
↑ 12.0%
30th
50th
1.45%
90th
5.27%
Payer conversion rate (7 day average)
0.23%
↑ 63.4%
36th
50th
0.40%
90th
1.22%
Average revenue per paying user (7 day…
31.9
↑ 0.1%
18th
50th
53.3
90th
130.6
Play through rate (7 day moving average)
3.19%
↓ 10.1%
55th
50th
2.87%
90th
5.97%`;

const EXPECTED = {
  playtime: { value: 10.3, pct: 22, p50: 12.9, p90: 18.9 },
  d1: { value: 14.4, pct: 64, p50: 12.3, p90: 16.14 },
  d7: { value: 1.03, pct: 30, p50: 1.45, p90: 5.27 },
  conversion: { value: 0.23, pct: 36, p50: 0.4, p90: 1.22 },
  arppu: { value: 31.9, pct: 18, p50: 53.3, p90: 130.6 },
  ptr: { value: 3.19, pct: 55, p50: 2.87, p90: 5.97 },
};

test("reads Roblox's Benchmarks section as copied", () => {
  const parsed = parseRobloxBenchmarks(COPIED);
  assert.equal(parsed.basis, 'similar');
  assert.equal(parsed.found, 6);
  assert.deepEqual(parsed.metrics, EXPECTED);
});

test('reads it with everything on one line, and in seconds', () => {
  const parsed = parseRobloxBenchmarks(`Benchmarks based on experiences in your genre Average playtime (7 day average) 45 sec ↓ 2% 50th 50th 45 sec 90th 1.5 min Day 1 retention (7 day average) 10% 5th 50th 12% 90th 16%`);
  assert.equal(parsed.basis, 'genre');
  assert.deepEqual(parsed.metrics.playtime, { value: 0.75, pct: 50, p50: 0.75, p90: 1.5 }, "its own 50th (before the 50th mark) is its percentile");
  assert.deepEqual(parsed.metrics.d1, { value: 10, pct: 5, p50: 12, p90: 16 });
  assert.equal(parseRobloxBenchmarks('nothing here').found, 0);
});

test('the normal helpers', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.2815515655446004) - 0.9) < 1e-6);
  for (const p of [0.01, 0.22, 0.5, 0.64, 0.97]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
});

test("percentiles land near Roblox's from the 50th and 90th alone, and exactly on Roblox's own point", () => {
  const stored = (id) => ({ p50: toStored(id, EXPECTED[id].p50), p90: toStored(id, EXPECTED[id].p90) });
  const live = (id) => toStored(id, EXPECTED[id].value);
  // Log-normal through the two marks: within 10 points of what Roblox drew on 5 of the 6 cards (playtime 22.5 vs 22, play-through 57 vs 55, D7 37 vs 30,
  // ARPPU 23 vs 18, conversion 26 vs 36). D1 comes out 77th
  // where Roblox drew 64th: no smooth curve through its marks gives 64th at 14.40%, so Roblox's percentile there
  // isn't of the 7-day average it shows. Copying Roblox's own point in (below) puts the curve through it.
  for (const id of Object.keys(EXPECTED)) {
    const pct = percentileOf(live(id), stored(id));
    assert.ok(Math.abs(pct - EXPECTED[id].pct) <= (id === 'd1' ? 14 : 10), `${id}: ${pct.toFixed(1)} vs Roblox's ${EXPECTED[id].pct}`);
  }
  assert.equal(Math.floor(percentileOf(live('playtime'), stored('playtime'))), 22, 'average playtime: spot on (Roblox rounds down: the bar says 22nd)');
  // With Roblox's own value and percentile, the curve goes through it, and stays rising
  for (const id of Object.keys(EXPECTED)) {
    const bench = { ...stored(id), value: live(id), pct: EXPECTED[id].pct };
    assert.ok(Math.abs(percentileOf(live(id), bench) - EXPECTED[id].pct) < 1e-3, id);
    const values = [0.2, 0.5, 0.9, 1, 1.1, 2, 5].map((k) => percentileOf(live(id) * k, bench));
    for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1], `${id} rises`);
  }
  // The marks themselves
  assert.ok(Math.abs(percentileOf(12.9 * 60, stored('playtime')) - 50) < 1e-3);
  assert.ok(Math.abs(percentileOf(18.9 * 60, stored('playtime')) - 90) < 1e-3);
  // No benchmark, or nothing to place
  assert.equal(percentileOf(600, null), null);
  assert.equal(percentileOf(null, stored('playtime')), null);
  assert.equal(percentileOf(600, { p50: 10, p90: 5 }), null, '90th must be above the 50th');
  assert.equal(percentileOf(0, stored('playtime')), 0);
  // An anchor that would bend the curve backwards is left out
  assert.equal(percentileOf(700, { p50: 600, p90: 900, value: 500, pct: 70 }), percentileOf(700, { p50: 600, p90: 900 }));
});

// A game's store: day buckets and cohorts
function storeOf({ days, cohorts }) {
  const data = {};
  for (const [day, c] of Object.entries(days)) data[S.dayKey(Number(day), 0)] = { c, m: {} };
  for (const [day, counts] of Object.entries(cohorts)) data[S.cohortKey(Number(day))] = counts;
  return (key) => data[key];
}

const DAY = 20500;
const AT = DAY * 86400 + 12 * 3600; // noon on DAY
const GAME = { id: 'cars', universeId: 1, shards: 1 };
const metric = (id) => METRICS.find((entry) => entry.id === id);

test("counts each card the way Roblox defines it, pooled over the window, today so far included", () => {
  const days = {}, cohorts = {};
  for (let day = DAY - 13; day <= DAY; day++) {
    const recent = day > DAY - 7;
    days[day] = {
      dau: recent ? 100 : 50, payers: recent ? 2 : 1, robux: recent ? 200 : 50,
      session_sum: (recent ? 600 : 300) * 80, sessions_ended: 80,
    };
    cohorts[day] = { size: 100, d1: day > DAY - 9 ? 20 : 10, d7: day > DAY - 15 ? 3 : 1 };
  }
  // A small, odd day in the window: pooled, it barely moves the average; Roblox's mean of days moves more
  days[DAY - 1] = { dau: 4, payers: 1, robux: 400, session_sum: 3600 * 4, sessions_ended: 4 };
  const read = storeOf({ days, cohorts });

  const playtime = measure(metric('playtime'), GAME, read, 7, AT);
  assert.equal(playtime.value, (600 * 80 * 6 + 3600 * 4) / (80 * 6 + 4));
  assert.equal(playtime.prev, 300);
  assert.equal(playtime.roblox, (300 + 600 * 5 + 3600) / 7, "Roblox's: the mean of the 7 complete days");

  const conversion = measure(metric('conversion'), GAME, read, 7, AT);
  assert.equal(conversion.value, 13 / 604);
  assert.equal(conversion.prev, 0.02);

  const arppu = measure(metric('arppu'), GAME, read, 7, AT);
  assert.equal(arppu.value, ((200 * 6 + 400) * 0.7) / 13, 'Robux earned (70%) per paying player-day');
  assert.equal(arppu.size, 13);

  // D1: the newest cohort with a finished day 1 is the day before yesterday; the 7 before it are the window
  const d1 = measure(metric('d1'), GAME, read, 7, AT);
  assert.equal(d1.through, DAY - 2);
  assert.equal(d1.value, 0.2, 'cohorts DAY-8..DAY-2');
  assert.equal(d1.prev, (20 * 0 + 10 * 6) / 600 + 0, 'the 7 before');
  const d7 = measure(metric('d7'), GAME, read, 7, AT);
  assert.equal(d7.through, DAY - 8);
  assert.equal(d7.value, 0.03);
});

test('the widget: live cards with Roblox marks, and play-through rate only from Roblox', () => {
  const read = storeOf({ days: { [DAY]: { dau: 10, payers: 0, robux: 0, session_sum: 6000, sessions_ended: 10 } }, cohorts: {} });
  const saved = { basis: 'similar', at: AT, metrics: { playtime: { p50: 774, p90: 1134, value: 618, pct: 22 }, ptr: { value: 0.0319, pct: 55, p50: 0.0287, p90: 0.0597 } } };
  const widget = benchmarksWidget(GAME, read, AT, saved);
  assert.equal(widget.Type, 'Benchmarks');
  assert.equal(widget.BasisLabel, 'experiences with similar players');
  assert.deepEqual(Object.keys(widget.Windows), ['7', '30']);
  const [playtime, d1, , conversion, arppu, ptr] = widget.Windows[7];
  assert.equal(playtime.Value, 600);
  assert.ok(playtime.Percentile > 15 && playtime.Percentile < 22);
  assert.deepEqual(playtime.Benchmark, { P50: 774, P90: 1134 });
  assert.equal(d1.Value, null, 'no cohorts: unknown, never 0');
  assert.equal(d1.Percentile, null);
  assert.equal(conversion.Value, 0);
  assert.equal(arppu.Value, null, 'nobody paid: no ARPPU');
  assert.equal(ptr.Live, false);
  assert.equal(ptr.Value, 0.0319);
  assert.equal(ptr.Percentile, 55);
  const bare = benchmarksWidget(GAME, read, AT, null);
  assert.equal(bare.BasisLabel, null);
  assert.equal(bare.Windows[7][0].Benchmark, null);
  assert.equal(bare.Windows[7][5].Value, null);
});

test('only sane numbers are saved', () => {
  const games = [GAME, { id: 'soon', universeId: null }];
  assert.throws(() => cleanBenchmarks({ game: 'nope' }, games), /Unknown game/);
  assert.throws(() => cleanBenchmarks({ game: 'soon' }, games), /Unknown game/);
  assert.throws(() => cleanBenchmarks({ game: 'cars', metrics: { d1: { p50: 0.2, p90: 0.1 } } }, games), /90th must be above/);
  const { game, value } = cleanBenchmarks({
    game: 'cars', basis: 'genre',
    metrics: { d1: { p50: 0.12, p90: 0.16, value: 'x', pct: 500 }, d7: { p50: 7 }, bogus: { p50: 1 }, arppu: { p50: 53.3, p90: 130.6, value: 31.9, pct: 18 } },
  }, games);
  assert.equal(game, 'cars');
  assert.deepEqual(value, { basis: 'genre', metrics: { d1: { p50: 0.12, p90: 0.16 }, arppu: { p50: 53.3, p90: 130.6, value: 31.9, pct: 18 } } }, 'rates over 100% and unknown cards are dropped');
  assert.equal(cleanBenchmarks({ game: 'cars', basis: 'x' }, games).value.basis, null);
});

test('POST /v1/admin/benchmarks: the owner saves, everyone else is turned away', async () => {
  const saved = [];
  const server = createServer({
    secret: 'test-secret-test-secret-1234', allowedOrigins: [], getView: () => null, health: () => ({ ok: true }), log: () => {},
    games: [GAME], saveBenchmarks: (game, value) => saved.push({ game, value }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body, token) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/v1/admin/benchmarks', { game: 'cars' })).status, 401, 'signed out');
    const { token } = await (await post('/v1/session', { secret: 'test-secret-test-secret-1234' })).json();
    const ok = await post('/v1/admin/benchmarks', { game: 'cars', basis: 'similar', metrics: { playtime: { p50: 774, p90: 1134 } } }, token);
    assert.equal(ok.status, 200);
    assert.deepEqual(saved, [{ game: 'cars', value: { basis: 'similar', metrics: { playtime: { p50: 774, p90: 1134 } } } }]);
    const bad = await post('/v1/admin/benchmarks', { game: 'cars', metrics: { d1: { p50: 0.2, p90: 0.1 } } }, token);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /90th/);
  } finally {
    server.close();
  }
});
