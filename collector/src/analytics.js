// Roblox's own analytics numbers, read hourly from the Open Cloud Analytics Query API (the same key as the
// DataStores; it needs universe.analytics:read): the values Roblox puts on its Benchmarks cards, so they don't
// have to be copied in, and the players Roblox ranks at its "High" engagement level.
//
// - Benchmark values: Roblox's daily values of the last complete UTC days, averaged the way Roblox does (the
//   mean of the days, a "7 day" and a "30 day average"). Retention is known a day (D1) or a week (D7) late, so
//   its windows are its last 7 / 30 days that have a value. Days with no value (no payers, say) are left out.
// - Playtime comes in minutes and is kept in seconds, like the rest of the collector; rates are fractions; ARPPU
//   is Robux.
// - "High" engagement: unique daily players over the last 60 days with UserSegmentationEngagementLevel = High.
//   Whether that's the count of "highly engaged players" in Creator Hub → Audience Reach isn't documented.
// The API has no 50th/90th percentiles: those still come from benchmarks.js's sources.

import * as S from './stats.js';

const API = process.env.ANALYTICS_BASE || process.env.OPEN_CLOUD_BASE || 'https://apis.roblox.com';
const EVERY = 3600 * 1000; // Roblox updates these once a day; hourly picks a new day up soon enough
const FIRST_DELAY = 20 * 1000;
const LOOKBACK = 40; // days asked for, so a 30-day window of retention has its days
const ENGAGED_DAYS = 60;
const TIMEOUT_MS = 30000;
const POLLS = 15;

export const ANALYTICS_METRICS = {
  playtime: { metric: 'AverageSessionLengthMinutes', scale: 60 },
  d1: { metric: 'ForwardD1Retention', cohort: true },
  d7: { metric: 'ForwardD7Retention', cohort: true },
  conversion: { metric: 'PayingUsersCVR' },
  arppu: { metric: 'AverageRevenuePerPayingUser' },
  ptr: { metric: 'RFYPlayThroughRate' },
};
export const WINDOWS = [7, 30];

const iso = (day) => new Date(day * 86400 * 1000).toISOString().replace('.000Z', 'Z');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// points: [{ day, value }] (the API's daily values). The window's average and how many days it has, or null.
// Ordinary metrics: the days of the last `days` complete days. Retention: its last `days` days with a value.
export function windowAverage(points, days, today, { cohort = false, scale = 1 } = {}) {
  const valid = points.filter((point) => Number.isFinite(point.value) && point.day < today).sort((a, b) => a.day - b.day);
  const inWindow = cohort ? valid.slice(-days) : valid.filter((point) => point.day >= today - days);
  if (!inWindow.length) return null;
  return { value: (inWindow.reduce((sum, point) => sum + point.value, 0) / inWindow.length) * scale, days: inWindow.length };
}

// The API's answer as [{ day, value }] (first series; no breakdown asked)
export function pointsOf(response) {
  const series = response?.values?.[0];
  return (series?.dataPoints || []).map((point) => ({ day: S.dayOf(Date.parse(point.time) / 1000), value: Number(point.value) }));
}

export function createAnalyticsClient(apiKey, { base = API, fetchImpl = fetch, pollMs = 2000 } = {}) {
  async function call(method, url, body) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method, signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'x-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        if (attempt >= 3) throw new Error(`network: ${error.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt);
        continue;
      }
      if (!response.ok && response.status !== 202) {
        const error = new Error(`${response.status} ${String(json?.error?.message || json?.message || text).slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
      return json;
    }
  }

  // One metric query, waiting for it when Roblox answers "not done yet"
  async function query(universeId, body) {
    let result = await call('POST', `${base}/analytics-query-api/v1/universes/${universeId}/metrics`, body);
    for (let poll = 0; result && !result.done && result.path && poll < POLLS; poll++) {
      await sleep(pollMs);
      result = await call('GET', `${base}/analytics-query-api/${result.path}`);
    }
    if (!result?.done) throw new Error(`${body.metric}: Roblox didn't finish the query`);
    if (result.error) throw new Error(`${body.metric}: ${result.error.message || result.error.code}`);
    return result.response;
  }

  return {
    // { day, value } for each complete day from `fromDay` to before `toDay`
    async daily(universeId, metric, fromDay, toDay) {
      return pointsOf(await query(universeId, { metric, granularity: 'OneDay', startTime: iso(fromDay), endTime: iso(toDay) }));
    },
    // Unique players at Roblox's "High" engagement level from `fromDay` to before `toDay`
    async highlyEngaged(universeId, fromDay, toDay) {
      const response = await query(universeId, {
        metric: 'DailyActiveUsers', granularity: 'None', startTime: iso(fromDay), endTime: iso(toDay),
        filter: [{ dimension: 'UserSegmentationEngagementLevel', values: ['High'], operation: 'In' }],
      });
      const points = pointsOf(response);
      return points.length ? points[0].value : 0;
    },
  };
}

// Reads every game hourly and saves what it got (db: roblox_metrics). A metric that fails keeps its last value.
export function createAnalytics({ games, db, log, onChange, client }) {
  let timer = null, running = false;

  async function readGame(game, at) {
    const today = S.dayOf(at);
    const saved = db.robloxMetrics(game.id) || {};
    const windows = { ...(saved.windows || {}) };
    for (const days of WINDOWS) windows[days] = { ...(windows[days] || {}) };
    const errors = [];
    for (const [id, spec] of Object.entries(ANALYTICS_METRICS)) {
      try {
        const points = await client.daily(game.universeId, spec.metric, today - LOOKBACK, today);
        for (const days of WINDOWS) {
          const average = windowAverage(points, days, today, spec);
          if (average) windows[days][id] = average.value;
          else delete windows[days][id];
        }
      } catch (error) {
        errors.push(error);
      }
    }
    let engagedHigh = saved.engagedHigh ?? null;
    try {
      engagedHigh = await client.highlyEngaged(game.universeId, today - ENGAGED_DAYS, today);
    } catch (error) {
      errors.push(error);
    }
    db.putRobloxMetrics(game.id, { windows, engagedHigh, through: today }, at);
    if (errors.length) {
      db.sourceFailed(game.id, 'analytics', errors[0].message, at);
      if (errors.some((error) => error.status === 401 || error.status === 403)) {
        log(`${game.id}: Roblox analytics refused the key: give it universe.analytics:read for this experience (${errors[0].message})`);
      } else log(`${game.id}: Roblox analytics: ${errors.length} reads failed (${errors[0].message})`);
    } else db.sourceOk(game.id, 'analytics', at);
  }

  async function refresh() {
    if (running) return;
    running = true;
    try {
      for (const game of games) {
        if (!game.universeId) continue;
        try {
          await readGame(game, S.now());
        } catch (error) {
          log(`${game.id}: Roblox analytics failed: ${error.message}`);
        }
      }
      onChange?.();
    } finally {
      running = false;
    }
  }

  return {
    refresh,
    start() {
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
