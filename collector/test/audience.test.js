// Highly engaged players, live from Creator Hub (audience.js)

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../src/db.js';
import { parseAudienceReach, createAudienceClient, createAudience } from '../src/audience.js';
import { engagedEntry, trackMilestones } from '../src/milestones.js';

const GAME = { id: 'g1', name: 'Game One', universeId: 42, slot: 1, shards: 1 };
const ANSWER = {
  universeAudienceReach: 'Gated',
  highlyEngagedPlayers: { status: 'InProgress', engagedPlayersCount: 37, updatedAt: '2026-11-14T13:00:00Z', thresholdTrigger: 100, thresholdReset: 25, graceDeadline: null, thresholdBarColor: 'x' },
  notices: [],
};

test('audience: reads the count, the goal and the stay-in number', () => {
  assert.deepEqual(parseAudienceReach(ANSWER), { count: 37, goal: 100, keep: 25, status: 'InProgress', updatedAt: Date.parse('2026-11-14T13:00:00Z') / 1000, graceDeadline: null, reach: 'Gated' });
  assert.equal(parseAudienceReach({ notices: [] }), null, 'no count: nothing');
  const noZone = parseAudienceReach({ highlyEngagedPlayers: { ...ANSWER.highlyEngagedPlayers, updatedAt: '2026-11-14T13:00:00' } });
  assert.equal(noZone.updatedAt, Date.parse('2026-11-14T13:00:00Z') / 1000, 'a time with no zone is UTC');
});

test('audience: the cookie only goes to Roblox, as .ROBLOSECURITY', async () => {
  let seen;
  const client = createAudienceClient('abc|def', { base: 'https://apis.roblox.test', fetchImpl: async (url, options) => {
    seen = { url, cookie: options.headers.Cookie };
    return new Response(JSON.stringify(ANSWER));
  } });
  assert.equal((await client.audienceReach(42)).count, 37);
  assert.deepEqual(seen, { url: 'https://apis.roblox.test/core-content/v2/universe/42/audience-reach', cookie: '.ROBLOSECURITY=abc|def' });
  const refused = createAudienceClient('old', { fetchImpl: async () => new Response('{"errors":[{"message":"Authentication token is missing"}]}', { status: 401 }) });
  await assert.rejects(refused.audienceReach(42), (error) => error.status === 401);
});

test('audience: saved into the counter, which then uses Roblox\'s goal and celebrates', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audience-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  trackMilestones([GAME], db); // the first, quiet check
  let count = 37, status = 200;
  const logs = [];
  const client = { async audienceReach() {
    if (status !== 200) throw Object.assign(new Error('401 Authentication token is missing'), { status });
    return { ...parseAudienceReach(ANSWER), count };
  } };
  const audience = createAudience({ games: [GAME, { ...GAME, id: 'g2', universeId: null }], db, log: (line) => logs.push(line), client });
  await audience.refresh();
  await audience.refresh(); // unchanged: not saved twice
  count = 104;
  await audience.refresh();
  const entry = engagedEntry(GAME, db);
  assert.equal(entry.Count, 104);
  assert.equal(entry.Goal, 100, "Roblox's goal");
  assert.ok(entry.Live);
  assert.deepEqual(entry.History.map((row) => row.Count), [37, 104]);
  const party = trackMilestones([GAME], db).filter((item) => !item.quiet);
  assert.deepEqual(party.map((item) => [item.kind, item.value]), [['engaged', 100]]);
  status = 401;
  await audience.refresh();
  await audience.refresh();
  assert.equal(logs.filter((line) => line.includes('ROBLOX_CREATOR_COOKIE')).length, 1, 'said once');
  assert.ok(!logs.some((line) => line.includes('abc')), 'never logs the cookie');
});

import { parseBenchmarks, parseScorecard } from '../src/audience.js';
import { benchmarksWidget } from '../src/benchmarks.js';

const point = (time, value, type = 'BENCHMARK_TYPE_GENRE') => ({ time, value, metadata: { benchmarkType: type, genre: 'simulation' } });
const BENCH = { result: { values: [
  { breakdownValue: [{ dimension: 'Percentile', value: '50' }], dataPoints: [point('2026-11-13T00:00:00Z', 9), point('2026-11-12T00:00:00Z', 8)] },
  { breakdownValue: [{ dimension: 'Percentile', value: '90' }], dataPoints: [point('2026-11-13T00:00:00Z', 19), point('2026-11-12T00:00:00Z', 17)] },
] } };
const SCORECARD = {
  metricTime: '2026-11-12T00:00:00Z', currentValue: 13.5, currentPercentile: 77, recommendedType: 'BENCHMARK_TYPE_GENRE',
  availableBenchmarks: [{ benchmarkType: 'BENCHMARK_TYPE_GENRE', genre: 'simulation' }],
};

test('audience: Roblox benchmarks and scorecards are read per day', () => {
  assert.deepEqual(parseBenchmarks(BENCH), { type: 'genre', genre: 'simulation', days: [{ day: 20769, p50: 8, p90: 17 }, { day: 20770, p50: 9, p90: 19 }] });
  assert.deepEqual(parseBenchmarks({ result: { values: [] } }).days, []);
  assert.deepEqual(parseScorecard(SCORECARD), { percentile: 77, value: 13.5, day: 20769, type: 'genre', genre: 'simulation' });
  assert.equal(parseScorecard({ currentPercentile: 0, percentileMap: {} }), null, 'no metric: nothing');
});

test('audience: POSTs get Roblox\'s CSRF token first', async () => {
  const seen = [];
  const client = createAudienceClient('c', { base: 'https://apis.roblox.test', fetchImpl: async (url, options) => {
    seen.push(options.headers['X-CSRF-TOKEN'] || null);
    if (!options.headers['X-CSRF-TOKEN']) return new Response('{}', { status: 403, headers: { 'x-csrf-token': 'tok' } });
    return new Response(JSON.stringify(BENCH));
  } });
  assert.equal((await client.benchmarks(42, 'AverageSessionLengthMinutes', 20740, 20771)).days.length, 2);
  await client.benchmarks(42, 'AverageSessionLengthMinutes', 20740, 20771);
  assert.deepEqual(seen, [null, 'tok', 'tok'], 'the token is kept');
});

test('audience: live benchmarks become the cards\' 50th/90th, with Roblox\'s own percentile', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubbench-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const at = 20771 * 86400 + 600;
  const client = {
    async audienceReach() { return parseAudienceReach(ANSWER); },
    async benchmarks() { return parseBenchmarks(BENCH); },
    async scorecard() { return parseScorecard(SCORECARD); },
  };
  const realNow = Date.now;
  Date.now = () => at * 1000;
  try {
    await createAudience({ games: [GAME], db, log: () => {}, client }).refresh();
  } finally {
    Date.now = realNow;
  }
  const hub = db.hubBenchmarks('g1');
  assert.deepEqual(hub.windows[7].playtime, { p50: 8.5 * 60, p90: 18 * 60 }, 'minutes kept as seconds, averaged over the days');
  assert.equal(hub.scorecards.playtime.value, 13.5 * 60);
  const widget = benchmarksWidget(GAME, () => undefined, at, null, { hub });
  const card = widget.Windows[7].find((item) => item.Id === 'playtime');
  assert.deepEqual(card.Benchmark, { P50: 510, P90: 1080 });
  assert.equal(card.Source.Kind, 'roblox');
  assert.deepEqual(card.Scorecard, { Percentile: 77, Value: 810, Day: 20769 });
  assert.equal(widget.Basis, 'genre');
  assert.equal(widget.HubAt, at);
});
