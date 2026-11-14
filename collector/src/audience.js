// Roblox's highly engaged players, live: the same call Creator Hub's "Manage audience" page makes
// (GET apis.roblox.com/core-content/v2/universe/{id}/audience-reach), every 15 minutes. Roblox updates the count
// hourly. Its answer has highlyEngagedPlayers: { status, engagedPlayersCount, updatedAt, thresholdTrigger (the
// goal), thresholdReset (what keeps a game in), graceDeadline }.
//
// With the same sign-in, hourly, the Benchmarks cards' 50th and 90th percentiles (POST
// analytics-benchmark/v1/benchmarks/resource/RESOURCE_TYPE_UNIVERSE/id/{id}: Roblox's peer group per day,
// "similar experiences" when Roblox has one, else the genre) and Roblox's own percentile for the game (GET
// universe-analytics-insights/v2/universes/{id}/insights/benchmark-scorecard?metric=...: its latest day). The
// percentiles are averaged over the 7 / 30 days like the values (analytics.js's windows).
//
// It's not a public API: it only takes a signed-in Roblox account's cookie (ROBLOX_CREATOR_COOKIE in
// collector/.env), not an Open Cloud key, and Roblox can change it without notice. The cookie only ever goes to
// apis.roblox.com and is never logged. Best: a second Roblox account that can only see the games, not the
// owner's own. Without the cookie, or when it stops working, the counter falls back to the number copied in.

import * as S from './stats.js';
import { ANALYTICS_METRICS, WINDOWS, windowAverage } from './analytics.js';

const API = process.env.CREATOR_HUB_BASE || 'https://apis.roblox.com';
const EVERY = 15 * 60 * 1000;
const FIRST_DELAY = 10 * 1000;
const TIMEOUT_MS = 20000;
const KEEP_EVERY = 6 * 3600; // an unchanged count is saved again this often, so the history shows it held
const BENCH_EVERY = 3600; // Roblox's benchmarks are daily: hourly is plenty
const BENCH_LOOKBACK = 40; // days, so a 30-day window of retention (known a week late) has its days

// The parts of the answer the dashboard uses, or null when it has none
export function parseAudienceReach(body) {
  const hep = body?.highlyEngagedPlayers;
  if (!hep || !Number.isFinite(Number(hep.engagedPlayersCount))) return null;
  const number = (value) => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);
  // Roblox sends "2026-11-14T13:00:00" with no zone: it's UTC (read as local time it would be hours off)
  const time = (value) => (value ? Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`) / 1000) || null : null);
  return {
    count: Number(hep.engagedPlayersCount),
    goal: number(hep.thresholdTrigger),
    keep: number(hep.thresholdReset),
    status: hep.status ?? null,
    updatedAt: time(hep.updatedAt),
    graceDeadline: time(hep.graceDeadline),
    reach: body.universeAudienceReach ?? null,
  };
}

// Creator Hub's calls with the account cookie. POSTs need Roblox's CSRF token: the first answer (403) hands it
// over in x-csrf-token, and it's kept for the next ones.
export function createAudienceClient(cookie, { base = API, fetchImpl = fetch } = {}) {
  let csrf = '';
  async function request(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Cookie: `.ROBLOSECURITY=${cookie}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-TOKEN': csrf } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const token = response.headers?.get?.('x-csrf-token');
      if (response.status === 403 && token && token !== csrf && attempt === 0) {
        csrf = token;
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try { const json = JSON.parse(text); message = json.errors?.[0]?.message || json.message || json.error?.code || text; } catch {}
        const error = new Error(`${response.status} ${String(message).slice(0, 160)}`);
        error.status = response.status;
        throw error;
      }
      return JSON.parse(text);
    }
  }
  return {
    async audienceReach(universeId) {
      return parseAudienceReach(await request('GET', `/core-content/v2/universe/${encodeURIComponent(universeId)}/audience-reach`));
    },
    // Roblox's benchmark percentiles for a metric, per day: { type, genre, days: [{ day, p50, p90 }] }
    async benchmarks(universeId, metric, fromDay, toDay) {
      return parseBenchmarks(await request('POST', `/analytics-benchmark/v1/benchmarks/resource/RESOURCE_TYPE_UNIVERSE/id/${encodeURIComponent(universeId)}`, {
        metric, startTime: isoDay(fromDay), endTime: isoDay(toDay),
      }));
    },
    // Roblox's own place for the game on a metric, its latest day: { percentile, value, day, type, genre }
    async scorecard(universeId, metric) {
      const params = new URLSearchParams({ metric });
      return parseScorecard(await request('GET', `/universe-analytics-insights/v2/universes/${encodeURIComponent(universeId)}/insights/benchmark-scorecard?${params}`));
    },
  };
}

const isoDay = (day) => new Date(day * 86400 * 1000).toISOString().replace('.000Z', 'Z');
const dayOfTime = (time) => S.dayOf(Date.parse(time) / 1000);
export const BENCHMARK_TYPES = { BENCHMARK_TYPE_SIMILARITY: 'similar', BENCHMARK_TYPE_GENRE: 'genre', BENCHMARK_TYPE_TOP_EXPERIENCES: 'all' };

// { values: [{ breakdownValue: [{ dimension: 'Percentile', value: '50' }], dataPoints: [{ time, value, metadata: { benchmarkType, genre } }] }] }
export function parseBenchmarks(body) {
  const byDay = new Map();
  let type = null, genre = null;
  for (const series of body?.result?.values || []) {
    const percentile = series.breakdownValue?.find((entry) => entry.dimension === 'Percentile')?.value;
    if (percentile !== '50' && percentile !== '90') continue;
    for (const point of series.dataPoints || []) {
      if (!Number.isFinite(point.value)) continue;
      const day = dayOfTime(point.time);
      const entry = byDay.get(day) || { day };
      entry[`p${percentile}`] = point.value;
      byDay.set(day, entry);
      type ??= BENCHMARK_TYPES[point.metadata?.benchmarkType] || null;
      genre ??= point.metadata?.genre || null;
    }
  }
  const days = [...byDay.values()].filter((entry) => entry.p50 > 0 && entry.p90 > entry.p50).sort((a, b) => a.day - b.day);
  return { type, genre, days };
}

export function parseScorecard(body) {
  if (!body?.metricTime || !Number.isFinite(body.currentPercentile)) return null;
  const chosen = (body.availableBenchmarks || []).find((entry) => entry.benchmarkType === body.recommendedType) || {};
  return {
    percentile: body.currentPercentile, value: Number.isFinite(body.currentValue) ? body.currentValue : null, day: dayOfTime(body.metricTime),
    type: BENCHMARK_TYPES[body.recommendedType] || null, genre: chosen.genre || null,
  };
}

// Reads every game and saves what Roblox says (db: audience_reach), and the count into the engaged history
// when it changed (or every KEEP_EVERY), so the counter, its trend and the milestones use it like a copy.
// A game Roblox answers without a count (not in evaluation, say) is left as it was.
export function createAudience({ games, db, log, onChange, client }) {
  let timer = null, running = false, refused = false, benchAt = 0;

  // Roblox's benchmark percentiles and its own percentile for the game, every metric (db: hub_benchmarks)
  async function readBenchmarks(game, at) {
    const today = S.dayOf(at);
    const saved = db.hubBenchmarks(game.id) || {};
    const windows = Object.fromEntries(WINDOWS.map((days) => [days, { ...(saved.windows?.[days] || {}) }]));
    const scorecards = { ...(saved.scorecards || {}) };
    let type = saved.type || null, genre = saved.genre || null;
    const failed = [];
    for (const [id, spec] of Object.entries(ANALYTICS_METRICS)) {
      try {
        const scale = spec.scale || 1;
        const bench = await client.benchmarks(game.universeId, spec.metric, today - BENCH_LOOKBACK, today);
        if (bench.days.length) {
          type = bench.type || type;
          genre = bench.genre || genre;
          for (const days of WINDOWS) {
            const p50 = windowAverage(bench.days.map((entry) => ({ day: entry.day, value: entry.p50 })), days, today, { ...spec, scale });
            const p90 = windowAverage(bench.days.map((entry) => ({ day: entry.day, value: entry.p90 })), days, today, { ...spec, scale });
            if (p50 && p90 && p90.value > p50.value) windows[days][id] = { p50: p50.value, p90: p90.value };
          }
        }
        const card = await client.scorecard(game.universeId, spec.metric);
        if (card) scorecards[id] = { ...card, value: card.value === null ? null : card.value * scale };
      } catch (error) {
        failed.push(`${id}: ${error.message}`); // that metric keeps its last numbers
      }
    }
    db.putHubBenchmarks(game.id, { type, genre, windows, scorecards }, at);
    if (failed.length) log(`${game.id}: reading Roblox's benchmarks: ${failed.length} failed (${failed[0]})`);
  }

  async function refresh() {
    if (running || !client) return;
    running = true;
    let changed = false;
    const benchNow = S.now() - benchAt >= BENCH_EVERY && Boolean(db.putHubBenchmarks);
    try {
      for (const game of games) {
        if (!game.universeId) continue;
        const at = S.now();
        try {
          const reach = await client.audienceReach(game.universeId);
          if (!reach) continue;
          refused = false;
          db.putAudienceReach(game.id, reach, at);
          const last = db.engaged(game.id);
          if (!last || last.count !== reach.count || at - last.t >= KEEP_EVERY) {
            db.addEngaged(game.id, reach.count, at);
          }
          db.sourceOk(game.id, 'creatorhub', at);
          changed = true; // "updated ... ago" moves even when the count doesn't
          if (benchNow) await readBenchmarks(game, at);
        } catch (error) {
          db.sourceFailed(game.id, 'creatorhub', error.message, at);
          if (error.status === 401 || error.status === 403) {
            if (!refused) log(`Creator Hub refused the account cookie (${error.message}): sign in again and put the new cookie in ROBLOX_CREATOR_COOKIE`);
            refused = true;
            break; // the same for every game
          }
          log(`${game.id}: reading Creator Hub's audience reach failed: ${error.message}`);
        }
      }
      if (benchNow && !refused) benchAt = S.now();
      if (changed) onChange?.();
    } finally {
      running = false;
    }
  }

  return {
    refresh,
    start() {
      if (!client) return;
      const loop = async () => {
        await refresh();
        timer = setTimeout(loop, EVERY);
      };
      timer = setTimeout(loop, FIRST_DELAY);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
