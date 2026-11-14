// Milestones (milestones.js): saved once, the first check quiet, only the highest new step of a kind celebrated,
// and Roblox's highly engaged players copied in by the owner.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../src/db.js';
import { trackMilestones, gameValues, milestonesWidget, engagedEntry, cleanEngaged, reachedOf, START } from '../src/milestones.js';
import { buildViews } from '../src/views.js';
import * as S from '../src/stats.js';

const GAME = { id: 'g1', name: 'Game One', universeId: 1, slot: 1, shards: 1, store: 's', liveMap: 'l' };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milestones-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

const day = (db, index, counters, peaks = {}, at = 1000) => db.putEntry(GAME.id, S.dayKey(index, 0), { c: counters, m: peaks }, at, true);

test('milestones: all-time numbers come from every day bucket and the online samples', (t) => {
  const db = setup(t);
  day(db, 20000, { purchases: 2, robux: 150, new_users: 60 }, { ccu: 12 });
  day(db, 20001, { purchases: 1, robux: 50, new_users: 50, 'purchases|payer=Payer': 99 }, { ccu: 30 });
  db.putEntry(GAME.id, S.hourKey(480000, 0), { c: { purchases: 500 }, m: {} }, 1000, true); // hours aren't added again
  db.addCcu(GAME.id, 5000, 41, 3);
  assert.deepEqual(gameValues(GAME, db), { sales: 3, robux: 200, players: 110, ccu: 41, engaged: 0 });
});

test('milestones: the first check is quiet, later steps are celebrated once', (t) => {
  const db = setup(t);
  day(db, 20000, { purchases: 0, new_users: 150 }, { ccu: 30 });
  trackMilestones([GAME], db, 1000);
  const first = db.milestones(GAME.id);
  assert.ok(first.some((row) => row.id === START), 'the first check is remembered');
  assert.ok(first.filter((row) => row.id !== START).every((row) => row.quiet), 'what was already reached is history');
  assert.deepEqual(first.filter((row) => row.kind === 'ccu').map((row) => row.value), [10, 25]);

  // The first sale, and 100 playing at once (25 → 100 skips 50: only 100 is celebrated)
  day(db, 20001, { purchases: 1, robux: 25, new_users: 10 }, { ccu: 120 });
  db.addCcu(GAME.id, 1500, 104, 4);
  const added = trackMilestones([GAME], db, 2000);
  assert.deepEqual(added.map(({ kind, value, quiet }) => [kind, value, quiet]), [['sales', 1, false], ['ccu', 50, true], ['ccu', 100, false]]);
  assert.equal(db.milestones(GAME.id).find((row) => row.id === 'ccu:100').at, 1500, 'when the samples first saw 100');
  assert.deepEqual(trackMilestones([GAME], db, 3000), [], 'never saved twice');

  const reached = reachedOf([GAME], db);
  const sale = reached.find((item) => item.Kind === 'sales');
  assert.equal(sale.Title, 'First sale!');
  assert.equal(sale.Level, 'epic');
  assert.equal(sale.GameName, 'Game One');
  assert.ok(!reached.some((item) => item.Kind === START));
  const next = milestonesWidget(GAME, db).Next;
  assert.deepEqual(next.find((item) => item.Kind === 'ccu'), { Kind: 'ccu', Label: 'Playing at once', Value: 250, Title: '250 playing at once', Current: 120, Level: 'big' });
});

test('milestones: games that are not reading normally are not checked', (t) => {
  const db = setup(t);
  day(db, 20000, { purchases: 5 });
  assert.deepEqual(trackMilestones([GAME, { ...GAME, id: 'g2', universeId: null }], db, 1000, () => false), []);
  assert.deepEqual(db.milestones(GAME.id), []);
});

test('milestones: highly engaged players, copied in, with the big goal at 250', (t) => {
  const db = setup(t);
  trackMilestones([GAME], db, 1000);
  assert.equal(engagedEntry(GAME, db).Count, null, 'not copied in yet');
  db.addEngaged(GAME.id, 140, 2000);
  const added = trackMilestones([GAME], db, 2000);
  assert.deepEqual(added.map(({ kind, value, quiet }) => [kind, value, quiet]), [['engaged', 25, true], ['engaged', 50, true], ['engaged', 100, false]], 'only the highest new step is celebrated');
  db.addEngaged(GAME.id, 251, 3000);
  const goal = trackMilestones([GAME], db, 3000).filter((item) => !item.quiet);
  assert.deepEqual(goal.map((item) => [item.kind, item.value]), [['engaged', 250]]);
  const entry = engagedEntry(GAME, db);
  assert.equal(entry.Count, 251);
  assert.equal(entry.Goal, 250);
  assert.deepEqual(entry.History.map((row) => row.Count), [140, 251]);
  assert.equal(reachedOf([GAME], db)[0].Level, 'epic');
  assert.deepEqual(cleanEngaged({ game: 'g1', count: '1,234' }, [GAME]), { game: 'g1', count: 1234 });
  assert.throws(() => cleanEngaged({ game: 'g1', count: '12.5' }, [GAME]));
  assert.throws(() => cleanEngaged({ game: 'nope', count: 3 }, [GAME]));
});

test('milestones: the views carry the counter and the milestones', (t) => {
  const db = setup(t);
  const at = 20001 * 86400 + 600;
  day(db, 20001, { purchases: 1, robux: 10, new_users: 3 }, { ccu: 3 });
  trackMilestones([GAME], db, at);
  db.addEngaged(GAME.id, 12, at);
  const views = buildViews([GAME], db, at);
  const overview = JSON.parse(views.get('/v1/overview?range=7d').json);
  assert.equal(overview.engaged[0].Count, 12);
  const game = JSON.parse(views.get('/v1/games/g1/overview?range=7d').json);
  assert.equal(game.widgets[0].Type, 'Engaged');
  assert.equal(game.widgets.at(-1).Type, 'Milestones');
  const list = JSON.parse(views.get('/v1/milestones').json);
  assert.ok(list.items.some((item) => item.Kind === 'sales' && item.Value === 1 && item.Quiet), 'already sold at the first check');
});
