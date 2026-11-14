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
