// The Monetization page: the Money tab's port, price runs and changes, the suggestions, and the sales feed
// (deltas between reads of an hour bucket, never counted twice).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as S from '../src/stats.js';
import { moneyTab, bars, columns } from '../src/query.js';
import { wilson, nextPrice, priceRuns, adviseItems, itemCounters, runStats, compareChange } from '../src/money.js';
import { saleDeltas, createPoller } from '../src/poller.js';

const tempDb = async () => {
  const { openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-money-'));
  return { db: openDatabase(path.join(dir, 'stats.db')), dir };
};
const day = (d, p, n, price, dau = 100) => ({ day: d, p, n, r: n * price, dau });
// An item as itemHistory makes it, from its days
const itemOf = (name, days) => {
  const runs = priceRuns(days);
  const current = runs[runs.length - 1];
  const recent = runStats(current ? current.days : days);
  return { name, days, runs, price: current ? current.price : null, recent, total: runStats(days), week: runStats([]), weekBefore: runStats([]) };
};

test('money tab: the panel\'s numbers, rows by Robux, "Other" past the top', () => {
  const at = 100 * 86400 + 3600;
  const bucket = { c: {
    dau: 100, robux: 300, purchases: 6, payers: 4, first_purchase: 2, 'first_purchase_min#<5m': 2,
    'prompt#VIP': 20, 'purchases#VIP': 2, 'robux#VIP': 200, 'prompt#Cash': 40, 'purchases#Cash': 4, 'robux#Cash': 100,
    'prompt#Never': 5, 'robux#VIP|p=PC': 999, 'prompt_src#Shop': 60, 'purchase_src#Shop': 6,
  }, m: {} };
  const read = (key) => (key === S.dayKey(100, 0) ? bucket : undefined);
  const { widgets } = moneyTab({ shards: 1 }, read, '7d', at);
  const [tilesWidget, , robuxBars, table, , , firstPurchase] = widgets;
  const value = (label) => tilesWidget.Items.find((item) => item.Label === label).Value;
  assert.equal(value('Robux spent'), 300);
  assert.equal(value('You earn (~70%)'), 210);
  assert.equal(value('Conversion'), 0.04);
  assert.equal(value('Robux / payer-day'), 75);
  assert.deepEqual(table.Rows, [['VIP', 20, 2, 0.1, 200], ['Cash', 40, 4, 0.1, 100], ['Never', 5, 0, 0, 0]]);
  assert.deepEqual(robuxBars.Items.map((item) => item.Label), ['VIP', 'Cash'], 'per-dimension copies (|p=PC) are not items');
  assert.deepEqual(firstPurchase.Items.map((item) => item.Label), ['<5m', '5-15m', '15-30m', '30-60m', '60-180m', '180-600m', '600+m']);
  // bars keeps top - 1 and folds the rest into Other (the panel's loop)
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`i${index}`, 10 - index]));
  assert.deepEqual(bars('t', 'int', many, undefined, 3).Items.map((item) => [item.Label, item.Value]), [['i0', 10], ['i1', 9], ['Other', 8 + 7 + 6]]);
  assert.deepEqual(columns('t', 'int', ['a', 'b'], { b: 2 }).Items, [{ Label: 'a', Value: 0 }, { Label: 'b', Value: 2 }]);
});

test('money: wilson, price steps and item counters', () => {
  const [low, high] = wilson(5, 40);
  assert.ok(low > 0.05 && low < 0.07 && high > 0.2 && high < 0.25, `${low} ${high}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  assert.equal(nextPrice(49, 1.25), 59);
  assert.equal(nextPrice(79, 0.75), 59);
  assert.equal(nextPrice(5, 0.75), null, 'nothing lower to suggest');
  assert.deepEqual(itemCounters({ c: { 'prompt#A': 3, 'purchases#A': 1, 'robux#A': 49, 'robux#A|p=PC': 49, 'prompt_src#Shop': 3 } }), { A: { p: 3, n: 1, r: 49 } });
});

test('money: price runs split at a change and leave out days sold at two prices', () => {
  const days = [
    day(1, 10, 0, 0), day(2, 10, 2, 99), day(3, 10, 1, 99), day(4, 10, 0, 0),
    { day: 5, p: 10, n: 2, r: 99 + 149, dau: 100 }, // the change day: averages a whole R$ 124, a one-day run between two prices
    day(6, 10, 1, 149), day(7, 10, 2, 149),
  ];
  const runs = priceRuns(days);
  assert.deepEqual(runs.map((run) => run.price), [99, 149]);
  assert.deepEqual(runs[0].days.map((entry) => entry.day), [1, 2, 3, 4], 'days before the first sale and without sales stay with the price before');
  assert.equal(runs[0].n, 3);
  assert.equal(runs[1].n, 3, 'the change day counts for neither side');
  assert.equal(runs[1].firstSale, 5, 'the change day is when the new price first sold');
  // A day whose average isn't a whole number sold at two prices (99 + 149 + 149 = 132.33 each)
  const uneven = priceRuns([day(1, 10, 2, 99), { day: 2, p: 10, n: 3, r: 99 + 2 * 149, dau: 100 }, day(3, 10, 2, 149)]);
  assert.deepEqual(uneven.map((run) => [run.price, run.n]), [[99, 2], [149, 2]]);
  assert.equal(priceRuns([day(1, 5, 0, 0)]).length, 0);
});

test('money: a price change is judged per prompt, with chance ruled out', () => {
  const before = { price: 99, ...runStats(Array.from({ length: 14 }, (_, d) => day(d, 100, 10, 99))) };
  const better = { price: 149, ...runStats(Array.from({ length: 14 }, (_, d) => day(20 + d, 100, 9, 149))) };
  const worse = { price: 149, ...runStats(Array.from({ length: 14 }, (_, d) => day(20 + d, 100, 3, 149))) };
  assert.equal(compareChange(before, better).verdict, 'better');
  assert.equal(compareChange(before, better).sure, true);
  assert.equal(compareChange(before, worse).verdict, 'worse');
  assert.equal(compareChange(before, { price: 149, ...runStats([day(30, 5, 1, 149)]) }).verdict, 'unknown');
  // The demo's numbers: 41 of 413 at R$ 99, 105 of 1166 at R$ 149 is clear; a third of the prompts each side isn't
  const small = (price, p, n) => ({ price, ...runStats([{ day: 0, p, n, r: n * price, dau: 0 }]) });
  assert.equal(compareChange(small(99, 413, 41), small(149, 1166, 105)).sure, true);
  assert.equal(compareChange(small(99, 138, 14), small(149, 389, 35)).sure, false);
});

test('money: suggestions', () => {
  const steady = (name, p, n, price) => itemOf(name, Array.from({ length: 30 }, (_, d) => day(d, p, n, price)));
  const items = [
    steady('Typical1', 10, 1, 99), // 10%
    steady('Typical2', 10, 1, 25),
    steady('Starter', 10, 4, 49), // 40%: raise
    steady('Popup', 100, 0, 79), // 3000 prompts, none bought: lower / rethink
    itemOf('Rare', [day(0, 30 * 100, 2, 79), ...Array.from({ length: 29 }, (_, d) => day(d + 1, 100, 0, 0))]), // 0.07%: placement
    itemOf('Lucky', [day(0, 40, 5, 19)]), // 5 of 40 against a typical 10%: no raise on that little
    itemOf('Hidden', [day(0, 6, 4, 99)]), // few prompts, most buy: show it more
    itemOf('Raised', [...Array.from({ length: 14 }, (_, d) => day(d, 100, 10, 99)), ...Array.from({ length: 14 }, (_, d) => day(20 + d, 100, 3, 149))]),
  ];
  const { items: advice, typical } = adviseItems(items);
  const of = (name) => advice.find((entry) => entry.Item === name);
  assert.ok(typical > 0.09 && typical < 0.15, String(typical));
  assert.equal(of('Raised').Kind, 'revert');
  assert.equal(of('Raised').Suggested, 99);
  assert.equal(of('Starter').Kind, 'raise');
  assert.equal(of('Starter').Suggested, 59);
  assert.equal(of('Popup').Kind, 'lower');
  assert.equal(of('Rare').Kind, 'placement');
  assert.equal(of('Lucky'), undefined);
  assert.equal(of('Hidden').Kind, 'promote');
  assert.equal(advice[0].Kind, 'revert', 'the most useful first');
});

test('sales feed: deltas between reads, overlapping reads and restarts never count twice', async () => {
  assert.deepEqual(saleDeltas({ c: { 'purchases#A': 1, 'robux#A': 49 } }, { c: { 'purchases#A': 3, 'robux#A': 147, 'purchases#A|p=PC': 9, 'purchases#B': 1, 'robux#B': 25 } }),
    [{ item: 'A', count: 2, robux: 98 }, { item: 'B', count: 1, robux: 25 }]);
  assert.deepEqual(saleDeltas({ c: { 'purchases#A': 3 } }, { c: { 'purchases#A': 2 } }), [], 'an older read arriving late adds nothing');

  const { db, dir } = await tempDb();
  const hour = S.hourOf(S.now());
  const key = S.hourKey(hour, 0);
  let value = { c: { 'purchases#A': 1, 'robux#A': 49 }, m: {} };
  const responses = [];
  const client = {
    async getEntry(universe, store, entryKey) {
      if (entryKey !== key && !entryKey.startsWith('D')) return null;
      const snapshot = structuredClone(entryKey === key ? value : { c: { 'purchases#A': 99 }, m: {} });
      if (responses.length) await responses.shift();
      return snapshot;
    },
    async sortedMapItems() { return []; },
    async listKeys() { return []; },
  };
  const game = { id: 'g', universeId: 1, store: 'S', liveMap: 'L', shards: 1 };
  const poller = createPoller({ games: [game], client, db, log: () => {} });
  const { pollBuckets } = poller._internal;
  await pollBuckets(game);
  assert.deepEqual(db.salesSince(0).map((sale) => [sale.item, sale.count, sale.robux]), [['A', 1, 49]], 'a bucket never read before counts from its hour\'s start');
  assert.equal(db.salesSince(0)[0].from, hour * 3600);
  assert.ok(db.salesSince(0).every((sale) => sale.item === 'A'), 'day buckets never add sales (they repeat the hours)');

  value = { c: { 'purchases#A': 2, 'robux#A': 98, 'purchases#B': 1, 'robux#B': 25 }, m: {} };
  // Two overlapping reads of the same new value
  await Promise.all([pollBuckets(game), pollBuckets(game)]);
  assert.equal(db.salesSince(0).length, 3);
  assert.equal(db.salesSince(0).reduce((total, sale) => total + sale.count, 0), 3);

  // After a restart (a new poller), the cached copy is the baseline: nothing already counted comes back
  const again = createPoller({ games: [game], client, db, log: () => {} });
  await again._internal.pollBuckets(game);
  assert.equal(db.salesSince(0).length, 3);
  value = { c: { 'purchases#A': 4, 'robux#A': 196, 'purchases#B': 1, 'robux#B': 25 }, m: {} };
  await again._internal.pollBuckets(game);
  assert.deepEqual(db.salesSince(0)[0], { ...db.salesSince(0)[0], item: 'A', count: 2, robux: 98 });
  db.pruneSales(S.now() + 10);
  assert.equal(db.salesSince(0).length, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('views: the Monetization pages, and the all-games one only from the person\'s games', async () => {
  const { db, dir } = await tempDb();
  const { buildViews } = await import('../src/views.js');
  const at = S.now();
  const games = [
    { id: 'a', name: 'A', universeId: 1, slot: 1, shards: 1 },
    { id: 'b', name: 'B', universeId: 2, slot: 2, shards: 1 },
  ];
  for (const game of games) {
    db.putEntry(game.id, S.dayKey(S.dayOf(at), 0), { c: { dau: 10, robux: 49, purchases: 1, 'prompt#Pack': 4, 'purchases#Pack': 1, 'robux#Pack': 49 }, m: {} }, at, false);
    db.putEntry(game.id, S.DEFS_KEY, { Funnels: [] }, at, false);
    db.sourceOk(game.id, 'datastore', at);
    db.sourceOk(game.id, 'live', at);
    db.addSale(game.id, at - 120, at - 60, 'Pack', 1, 49);
  }
  const views = buildViews(games, db, at);
  const one = JSON.parse(views.get('/v1/games/a/money?range=7d').json);
  assert.deepEqual(one.widgets.map((widget) => widget.Type).slice(0, 3), ['Tiles', 'Sales', 'Advice']);
  assert.equal(one.widgets.find((widget) => widget.Type === 'Sales').Items.length, 1, "only this game's sales");
  assert.equal(one.widgets.find((widget) => widget.Type === 'Items').Rows[0].Price, 49);
  const all = JSON.parse(views.get('/v1/money?range=7d').json);
  assert.equal(all.widgets[0].Items[0].Value, 98, 'Robux summed over games');
  assert.equal(all.widgets.find((widget) => widget.Type === 'Sales').Items.length, 2);
  const scoped = JSON.parse(buildViews([games[0]], db, at).get('/v1/money?range=7d').json);
  assert.equal(scoped.widgets[0].Items[0].Value, 49);
  assert.ok(scoped.widgets.find((widget) => widget.Type === 'Sales').Items.every((sale) => sale.Game === 'a'), "never another game's sales");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
