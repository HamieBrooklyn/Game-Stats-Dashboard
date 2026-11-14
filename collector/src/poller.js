// What the collector reads from each game, and when. Everything is read-only.
// - Live servers (MemoryStore): every 15 s; each read is also saved as an online-player sample.
// - Hour and day buckets: the current ones every minute; any the views need that aren't final yet, a few a
//   minute (BACKFILL_PER_MINUTE). A bucket is final once it was read FINAL_DELAY after its slot ended (the
//   game still merges late flushes for a while); the last two days are re-read every hour anyway.
// - Cohorts (31 days), the journey log, funnel definitions and chart notes: every 10 minutes (cohorts keep
//   changing for good, as funnel steps reach old cohorts).
// - Feedback (when the game has an adapter): the count and newest page every 2 minutes, every page hourly
//   (statuses change on old pages).
// - Shards: once a day, from the keys of today's day bucket (a wrong count would under-count everything).
// - Sales feed: whenever an hour bucket is read, what its items' purchases and Robux went up by since the read
//   before is saved as a sale (db.addSale), with the time window it happened in. Servers merge every 60 s and the
//   current hour is read every minute, so a sale shows up about 1-2 minutes after it happened.

import * as S from './stats.js';

const FINAL_DELAY = 15 * 60;
const BACKFILL_PER_MINUTE = 20;
const HOURS_NEEDED = 48; // the 24h range and the 24 hours before it
const DAYS_NEEDED = 60; // the 30d range and the 30 days before it
const COHORT_DAYS = 31;

// What each item's purchases and Robux went up by from `before` to `after` (two reads of one bucket). Counters
// only grow; a counter that seems to shrink (an older read arriving late) adds nothing.
export function saleDeltas(before, after) {
  const was = before?.c || {}, now = after?.c || {};
  const sales = [];
  for (const [key, value] of Object.entries(now)) {
    if (!key.startsWith('purchases#') || key.includes('|')) continue;
    const item = key.slice('purchases#'.length);
    const count = value - (was[key] || 0);
    if (!(count > 0)) continue;
    sales.push({ item, count, robux: Math.max(0, (now[`robux#${item}`] || 0) - (was[`robux#${item}`] || 0)) });
  }
  return sales;
}

// The item counters a sale is measured from (the highest seen of each)
function saleCounters(bucket, into = {}) {
  for (const [key, value] of Object.entries(bucket?.c || {})) {
    if ((key.startsWith('purchases#') || key.startsWith('robux#')) && !key.includes('|') && !(into[key] >= value)) into[key] = value;
  }
  return into;
}

const FLUSH_INTERVAL = 60; // a game server merges its counts this often, so a sale can be up to this much older than its merge

export function slotEnd(key) {
  const match = /^([HD])(\d+)_/.exec(key);
  if (!match) return Infinity;
  const slot = Number(match[2]);
  return match[1] === 'H' ? (slot + 1) * 3600 : (slot + 1) * 86400;
}

export function isFinal(key, fetchedAt) {
  return fetchedAt >= slotEnd(key) + FINAL_DELAY;
}

// The bucket keys the views read, newest first
export function neededKeys(game, at) {
  const keys = [];
  const hour = S.hourOf(at), day = S.dayOf(at);
  for (let offset = 0; offset < Math.max(HOURS_NEEDED, DAYS_NEEDED); offset++) {
    for (let shard = 0; shard < game.shards; shard++) {
      if (offset < HOURS_NEEDED) keys.push(S.hourKey(hour - offset, shard));
      if (offset < DAYS_NEEDED) keys.push(S.dayKey(day - offset, shard));
    }
  }
  return keys;
}

export function createPoller({ games, client, db, log, onChange }) {
  const timers = [];
  const state = new Map(); // per game: last runs
  const saleBaselines = new Map(); // "<game>\0<hour key>" -> { c: item counters already counted as sales, at }

  // Saves what this read of an hour bucket added as sales. The baseline is the highest count seen so far (two
  // reads can overlap, and the older one may answer last), first taken from the cached copy. A bucket never
  // read before counts from its hour's start: a fresh install fills the feed with whole-hour windows.
  function noteSales(game, key, value, at) {
    const match = /^H(\d+)_/.exec(key);
    if (!match) return;
    const id = `${game.id}\u0000${key}`;
    const start = Number(match[1]) * 3600, end = start + 3600;
    let baseline = saleBaselines.get(id);
    if (!baseline) {
      const cached = db.entry(game.id, key);
      baseline = cached ? { c: saleCounters(cached.value), at: cached.fetchedAt } : { c: {}, at: start };
      saleBaselines.set(id, baseline);
    }
    const to = Math.min(at, end);
    const from = Math.min(Math.max(start, baseline.at - FLUSH_INTERVAL), to - FLUSH_INTERVAL);
    for (const sale of saleDeltas(baseline, value)) db.addSale(game.id, Math.max(start, from), to, sale.item, sale.count, sale.robux);
    saleCounters(value, baseline.c);
    baseline.at = Math.max(baseline.at, at);
  }

  function pruneSaleBaselines(at) {
    for (const [id] of saleBaselines) if (slotEnd(id.split('\u0000')[1]) < at - 3 * 86400) saleBaselines.delete(id);
  }

  async function read(game, key, at = S.now()) {
    try {
      const value = await client.getEntry(game.universeId, game.store, key);
      noteSales(game, key, value, at);
      db.putEntry(game.id, key, value, at, isFinal(key, at));
      db.sourceOk(game.id, 'datastore', at);
      return true;
    } catch (error) {
      db.sourceFailed(game.id, 'datastore', error.message, at);
      log(`${game.id}: reading ${key} failed: ${error.message}`);
      return false;
    }
  }

  async function pollLive(game) {
    const at = S.now();
    try {
      const items = await client.sortedMapItems(game.universeId, game.liveMap);
      const servers = items.filter((item) => typeof item.id === 'string' && item.id.startsWith('s:') && item.value && typeof item.value === 'object').map((item) => item.value);
      // A heartbeat older than the game's expiry is a server that just closed
      const fresh = servers.filter((server) => !server.At || at - server.At <= 120);
      db.putEntry(game.id, '$live', fresh, at, false);
      db.addCcu(game.id, at, fresh.reduce((sum, server) => sum + (server.Players || 0), 0), fresh.length);
      db.sourceOk(game.id, 'live', at);
    } catch (error) {
      db.sourceFailed(game.id, 'live', error.message, at);
      log(`${game.id}: reading live servers failed: ${error.message}`);
    }
  }

  async function pollBuckets(game) {
    const at = S.now();
    const keys = neededKeys(game, at);
    const current = new Set();
    for (let shard = 0; shard < game.shards; shard++) {
      current.add(S.hourKey(S.hourOf(at), shard));
      current.add(S.dayKey(S.dayOf(at), shard));
    }
    let budget = BACKFILL_PER_MINUTE;
    for (const key of keys) {
      const cached = db.entry(game.id, key);
      if (current.has(key)) {
        await read(game, key, at);
      } else if ((!cached || !cached.final) && budget > 0) {
        budget--;
        await read(game, key, at);
      }
    }
  }

  async function reconcile(game) {
    const at = S.now();
    for (const key of neededKeys(game, at)) {
      if (slotEnd(key) > at - 2 * 86400) await read(game, key, at);
    }
  }

  async function pollSlow(game) {
    const at = S.now();
    const today = S.dayOf(at);
    for (let day = today - COHORT_DAYS + 1; day <= today; day++) await read(game, S.cohortKey(day), at);
    for (const key of [S.JOURNEYS_KEY, S.DEFS_KEY, 'Markers']) await read(game, key, at);
    pruneSaleBaselines(at);
  }

  async function detectShards(game) {
    const at = S.now();
    try {
      const keys = await client.listKeys(game.universeId, game.store, `D${S.dayOf(at)}_`);
      const shards = keys.map((key) => Number(key.split('_')[1])).filter(Number.isFinite);
      const seen = shards.length ? Math.max(...shards) + 1 : 0;
      if (seen > game.shards) {
        log(`${game.id}: the store has ${seen} shards but games.json says ${game.shards}; using ${seen}`);
        game.shards = seen;
      }
    } catch (error) {
      log(`${game.id}: listing shards failed: ${error.message}`);
    }
  }

  async function pollFeedback(game, all) {
    const adapter = game.feedback;
    if (!adapter) return;
    const at = S.now();
    try {
      const meta = await client.getEntry(game.universeId, adapter.store, 'Meta');
      const count = meta?.Count || 0;
      const pages = Math.ceil(count / (adapter.pageSize || 50));
      const from = all ? 1 : Math.max(pages - 1, 1);
      const size = adapter.pageSize || 50;
      for (let page = pages; page >= from; page--) {
        const raw = await client.getEntry(game.universeId, adapter.store, `Page_${page}`);
        const entries = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter((entry) => entry && typeof entry === 'object' && typeof entry.Id === 'number');
        db.replaceFeedbackPage(game.id, (page - 1) * size + 1, page * size, entries);
      }
      db.sourceOk(game.id, 'feedback', at);
    } catch (error) {
      db.sourceFailed(game.id, 'feedback', error.message, at);
      log(`${game.id}: reading feedback failed: ${error.message}`);
    }
  }

  // Runs `task` now and then every `seconds`, never overlapping itself
  function every(seconds, task, jitter = 0) {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await task();
        onChange?.();
      } catch (error) {
        log(`task failed: ${error.stack || error}`);
      } finally {
        running = false;
      }
    };
    setTimeout(run, jitter);
    timers.push(setInterval(run, seconds * 1000));
  }

  return {
    start() {
      games.forEach((game, index) => {
        if (!game.universeId) return;
        state.set(game.id, {});
        const offset = index * 2000; // spread games out
        every(15, () => pollLive(game), offset);
        every(60, () => pollBuckets(game), offset + 500);
        every(600, () => pollSlow(game), offset + 1000);
        every(3600, () => reconcile(game), offset + 30 * 60 * 1000);
        every(86400, () => detectShards(game), offset);
        if (game.feedback) {
          every(120, () => pollFeedback(game, false), offset + 1500);
          every(3600, () => pollFeedback(game, true), offset + 5 * 60 * 1000);
        }
      });
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
    // For tests
    _internal: { pollLive, pollBuckets, pollSlow, pollFeedback, detectShards, reconcile },
  };
}
