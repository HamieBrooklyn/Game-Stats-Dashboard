// Roblox's analytics numbers (analytics.js): averaged like Roblox, saved per game, shown on the benchmark cards.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../src/db.js';
import { windowAverage, pointsOf, createAnalytics, createAnalyticsClient, ANALYTICS_METRICS } from '../src/analytics.js';
import { benchmarksWidget } from '../src/benchmarks.js';
import { engagedEntry } from '../src/milestones.js';

const GAME = { id: 'g1', name: 'Game One', universeId: 42, slot: 1, shards: 1 };
const TODAY = 20771;

test('analytics: windows average the complete days, retention its last days with a value', () => {
  const points = [
    { day: TODAY - 9, value: 100 }, // outside the 7-day window
    { day: TODAY - 3, value: 2 },
    { day: TODAY - 1, value: 4 },
    { day: TODAY, value: 999 }, // today isn't complete
  ];
  assert.deepEqual(windowAverage(points, 7, TODAY, { scale: 60 }), { value: 180, days: 2 });
  assert.equal(windowAverage(points, 30, TODAY).value, (100 + 2 + 4) / 3);
  // D7 is known a week late: its 7-day window is its last 7 days with a value, however old
  const late = Array.from({ length: 10 }, (_, index) => ({ day: TODAY - 20 + index, value: index }));
  assert.equal(windowAverage(late, 7, TODAY, { cohort: true }).value, (3 + 4 + 5 + 6 + 7 + 8 + 9) / 7);
  assert.equal(windowAverage([], 7, TODAY), null);
  assert.deepEqual(pointsOf({ values: [{ breakdowns: [], dataPoints: [{ time: '2026-11-13T00:00:00+00:00', value: 0.5 }] }] }), [{ day: 20770, value: 0.5 }]);
});

test('analytics: the client waits for queries Roblox finishes later', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([options.method, url, options.body && JSON.parse(options.body)]);
    const body = options.method === 'POST'
      ? { path: 'v1/universes/42/operations/metrics/abc', done: false }
      : { done: true, response: { values: [{ breakdowns: [], dataPoints: [{ time: '2026-11-13T00:00:00Z', value: 7 }] }] } };
    return new Response(JSON.stringify(body), { status: options.method === 'POST' ? 202 : 200 });
  };
  const client = createAnalyticsClient('key', { base: 'http://roblox.test', fetchImpl, pollMs: 1 });
  assert.equal(await client.highlyEngaged(42, TODAY - 60, TODAY), 7);
  assert.equal(calls[0][1], 'http://roblox.test/analytics-query-api/v1/universes/42/metrics');
  assert.deepEqual(calls[0][2].filter, [{ dimension: 'UserSegmentationEngagementLevel', values: ['High'], operation: 'In' }]);
  assert.deepEqual(calls[1].slice(0, 2), ['GET', 'http://roblox.test/analytics-query-api/v1/universes/42/operations/metrics/abc']);
});

test('analytics: saved per game, a failing metric keeps its last value, and the cards show it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const at = TODAY * 86400 + 3600;
  const values = { AverageSessionLengthMinutes: 5, ForwardD1Retention: 0.1, ForwardD7Retention: 0.02, PayingUsersCVR: 0.01, AverageRevenuePerPayingUser: 30, RFYPlayThroughRate: 0.04 };
  let failing = null;
  const client = {
    async daily(universe, metric, from, to) {
      if (metric === failing) throw Object.assign(new Error('403 forbidden'), { status: 403 });
      return Array.from({ length: to - from }, (_, index) => ({ day: from + index, value: values[metric] }));
    },
    async highlyEngaged() { return 7; },
  };
  const logs = [];
  const analytics = createAnalytics({ games: [GAME, { ...GAME, id: 'g2', universeId: null }], db, log: (line) => logs.push(line), client });
  const realNow = Date.now;
  Date.now = () => at * 1000;
  try {
    await analytics.refresh();
    values.AverageSessionLengthMinutes = 6;
    failing = 'RFYPlayThroughRate';
    await analytics.refresh();
  } finally {
    Date.now = realNow;
  }
  const saved = db.robloxMetrics('g1');
  assert.equal(saved.windows[7].playtime, 360, 'minutes kept as seconds');
  assert.ok(Math.abs(saved.windows[30].ptr - 0.04) < 1e-9, 'the failed read kept the last value');
  assert.equal(saved.engagedHigh, 7);
  assert.equal(db.robloxMetrics('g2'), null, 'games without a universe are skipped');
  assert.ok(logs.some((line) => line.includes('universe.analytics:read')), 'says what the key needs');
  assert.equal(Object.keys(ANALYTICS_METRICS).length, 6);

  const widget = benchmarksWidget(GAME, () => undefined, at, { metrics: { ptr: { p50: 0.02, p90: 0.08, value: 0.03, pct: 40 } } }, { roblox: saved });
  const ptr = widget.Windows[7].find((card) => card.Id === 'ptr');
  assert.ok(Math.abs(ptr.Value - 0.04) < 1e-9, "Roblox's number from its API beats the copied one");
  assert.ok(ptr.Percentile > 50 && ptr.Percentile < 90);
  assert.deepEqual(ptr.Copied, { Value: 0.03, Percentile: 40 });
  const d1 = widget.Windows[30].find((card) => card.Id === 'd1');
  assert.ok(Math.abs(d1.FromRoblox.Value - 0.1) < 1e-9);
  assert.equal(d1.FromRoblox.Api, true);
  assert.equal(widget.RobloxAt, at);
  assert.deepEqual(engagedEntry(GAME, db).Api, { High: 7, At: at });
});
