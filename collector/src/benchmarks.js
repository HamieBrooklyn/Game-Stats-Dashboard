// Roblox's "Benchmarks" cards (Creator Hub → Analytics → Overview), counted live from the game's own stats.
//
// What Roblox shows, and how each card is rebuilt here (Roblox's definitions, create.roblox.com/docs/production/analytics):
// - Average playtime: Roblox's "average session time", total time in the game ÷ sessions. Here: the length of
//   the sessions that ended ÷ how many ended (session_sum / sessions_ended).
// - Day 1 / Day 7 retention: of the new players who first played on a day, the share who played again exactly
//   1 / 7 days later (the 2nd / 8th day). Here: the game's cohorts (C<day>: size, d1, d7), only cohorts whose
//   day 1 / day 7 is over, so it's never a half-counted day.
// - Payer conversion rate: the share of daily active users who bought something that day: payers / dau.
// - ARPPU: Robux earned per paying user, per day: robux × 70% (what the game keeps) / payers.
// - Play-through rate: plays ÷ times the game was shown in home recommendations. Only Roblox knows the
//   impressions, so this card shows Roblox's own number (copied in), never a live one.
//
// Days are UTC, like the rest of the dashboard. "Live": the window ends now, so today so far is in it. Each
// window is pooled (sum of the tops ÷ sum of the bottoms), so a quiet few hours today move it as little as their
// size deserves. Roblox averages the daily values of complete days instead; that number is sent too ("Roblox"),
// to check one against the other.
//
// The 50th and 90th percentiles come from Roblox (its peer group: experiences your players also play, else the
// genre, else all experiences; refreshed daily). Nobody outside Roblox can count those, so the owner copies them
// in (benchmarks table). Where the live number falls between them: a curve through the two marks (and through
// Roblox's own number at its own percentile, when copied in), straight in log value against the normal
// quantile, so a log-normal spread of experiences. On Roblox's own example that lands within a few points.

import * as S from './stats.js';

export const METRICS = [
  { id: 'playtime', title: 'Average playtime', format: 'min',
    info: "Roblox's average session time: how long a session lasts. Here: the length of the sessions that ended in the window ÷ how many ended." },
  { id: 'd1', title: 'Day 1 retention', format: 'pct', offset: 1,
    info: 'Of the new players who first played on a day, the share who played again the next day. Only days whose next day is over count.' },
  { id: 'd7', title: 'Day 7 retention', format: 'pct', offset: 7,
    info: 'Of the new players who first played on a day, the share who played again exactly 7 days later (the 8th day). Only days a week old count.' },
  { id: 'conversion', title: 'Payer conversion rate', format: 'pct',
    info: 'The share of daily players who bought something that day (each player once a day).' },
  { id: 'arppu', title: 'Average revenue per paying user', format: 'robux',
    info: 'Robux earned per paying player each day: what players spent × 70% (what you keep) ÷ paying players.' },
  { id: 'ptr', title: 'Play through rate', format: 'pct', robloxOnly: true,
    info: "How often being shown in home recommendations turns into a play. It needs Roblox's impressions, so this is Roblox's own number, copied in, not a live one." },
];
const IDS = new Set(METRICS.map((metric) => metric.id));
export const WINDOWS = [7, 30];
export const BASES = { similar: 'experiences with similar players', genre: 'experiences in your genre', all: 'all experiences' };

// Below these, a card says its sample is small (a handful of players can swing it)
const SMALL = { playtime: 50, d1: 100, d7: 100, conversion: 200, arppu: 5 };

// --- Normal distribution (for percentiles) ---
const Z90 = 1.2815515655446004;

// Φ(z), |error| < 1.5e-7 (Abramowitz & Stegun 7.1.26)
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Φ⁻¹(p) (Acklam), relative error < 1.2e-9
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Where `value` falls among similar experiences (0-100), from Roblox's 50th and 90th (and Roblox's own value at
// its own percentile, when it keeps the curve rising). null when there's no benchmark or no value.
export function percentileOf(value, bench) {
  const p50 = bench?.p50, p90 = bench?.p90;
  if (!(p50 > 0 && p90 > p50) || value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  let points = [[Math.log(p50), 0], [Math.log(p90), Z90]];
  if (bench.value > 0 && bench.pct > 0 && bench.pct < 100) {
    const merged = [...points, [Math.log(bench.value), normInv(bench.pct / 100)]].sort((x, y) => x[0] - y[0]);
    if (merged.every((point, index) => index === 0 || (point[0] > merged[index - 1][0] && point[1] > merged[index - 1][1]))) points = merged;
  }
  const slope = Z90 / (Math.log(p90) - Math.log(p50)); // the 50th-90th spread, for beyond the outer marks
  const x = Math.log(value);
  const first = points[0], last = points[points.length - 1];
  let z;
  if (x <= first[0]) z = first[1] + (x - first[0]) * slope;
  else if (x >= last[0]) z = last[1] + (x - last[0]) * slope;
  else {
    const index = points.findIndex((point) => point[0] >= x);
    const [x0, z0] = points[index - 1], [x1, z1] = points[index];
    z = z0 + ((x - x0) / (x1 - x0)) * (z1 - z0);
  }
  return 100 * normCdf(z);
}

// --- Counting ---
// A day's counters, added up over shards
function dayCounters(game, read, day) {
  const bucket = S.emptyBucket();
  for (let shard = 0; shard < (game.shards || 1); shard++) S.addInto(bucket, read(S.dayKey(day, shard)));
  return bucket.c;
}

const DAY_PARTS = {
  playtime: (c) => [c.session_sum || 0, c.sessions_ended || 0],
  conversion: (c) => [c.payers || 0, c.dau || 0],
  arppu: (c) => [(c.robux || 0) * S.DEVELOPER_SHARE, c.payers || 0],
};

const pooled = (rows) => {
  const top = rows.reduce((sum, [a]) => sum + a, 0), bottom = rows.reduce((sum, [, b]) => sum + b, 0);
  return { value: bottom > 0 ? top / bottom : null, size: bottom };
};
// Roblox's way: the mean of the daily values (days with nothing to divide by are left out)
const meanOfDays = (rows) => {
  const values = rows.filter(([, b]) => b > 0).map(([a, b]) => a / b);
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
};

// One metric over a window of `days` ending now, the window before it, and Roblox's way
export function measure(metric, game, read, days, at = S.now()) {
  const today = S.dayOf(at);
  const range = (from, to, rowOf) => Array.from({ length: to - from + 1 }, (_, index) => rowOf(from + index));
  if (metric.offset) {
    // Cohorts whose day `offset` is over: the newest is today - offset - 1
    const rowOf = (day) => {
      const counts = read(S.cohortKey(day));
      return counts && typeof counts === 'object' ? [counts[`d${metric.offset}`] || 0, counts.size || 0] : [0, 0];
    };
    const newest = today - metric.offset - 1;
    const cur = range(newest - days + 1, newest, rowOf), prev = range(newest - 2 * days + 1, newest - days, rowOf);
    const now = pooled(cur), before = pooled(prev);
    return { value: now.value, prev: before.value, size: now.size, roblox: meanOfDays(cur), through: newest };
  }
  const part = DAY_PARTS[metric.id];
  const rowOf = (day) => part(dayCounters(game, read, day));
  const cur = range(today - days + 1, today, rowOf), prev = range(today - 2 * days + 1, today - days, rowOf);
  const now = pooled(cur), before = pooled(prev);
  return { value: now.value, prev: before.value, size: now.size, roblox: meanOfDays(range(today - days, today - 1, rowOf)), through: today };
}

// The widget for one game's Overview. `saved`: the owner's copy of Roblox's numbers ({ basis, at, metrics }).
export function benchmarksWidget(game, read, at = S.now(), saved = null) {
  const stored = saved && typeof saved === 'object' ? saved : {};
  const marks = stored.metrics || {};
  const windows = {};
  for (const days of WINDOWS) {
    windows[days] = METRICS.map((metric) => {
      const bench = marks[metric.id] || {};
      const benchmark = bench.p50 > 0 && bench.p90 > bench.p50 ? { P50: bench.p50, P90: bench.p90 } : null;
      const fromRoblox = bench.value >= 0 && Number.isFinite(bench.value) ? { Value: bench.value, Percentile: Number.isFinite(bench.pct) ? bench.pct : null } : null;
      if (metric.robloxOnly) {
        return { Id: metric.id, Title: metric.title, Format: metric.format, Info: metric.info, Live: false, Value: fromRoblox?.Value ?? null, Prev: null, Percentile: fromRoblox?.Percentile ?? null, Benchmark: benchmark, FromRoblox: fromRoblox };
      }
      const result = measure(metric, game, read, days, at);
      return {
        Id: metric.id, Title: metric.title, Format: metric.format, Info: metric.info, Live: true,
        Value: result.value, Prev: result.prev, Roblox: result.roblox, Size: result.size, Small: result.size < (SMALL[metric.id] || 0),
        Percentile: benchmark ? percentileOf(result.value, bench) : null,
        Benchmark: benchmark, FromRoblox: fromRoblox,
      };
    });
  }
  return { Type: 'Benchmarks', Game: game.id, Basis: BASES[stored.basis] ? stored.basis : null, BasisLabel: BASES[stored.basis] || null, SavedAt: stored.at || null, Windows: windows };
}

// Checks what the owner sends (POST /v1/admin/benchmarks) and keeps only known, sane numbers. Units are the
// collector's: seconds for playtime, fractions for rates, Robux. Throws on what can't be saved.
export function cleanBenchmarks(body, games) {
  const game = games.find((entry) => entry.id === body?.game && entry.universeId);
  if (!game) throw new Error('Unknown game.');
  const metrics = {};
  const number = (value, max) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined);
  for (const [id, raw] of Object.entries(body.metrics && typeof body.metrics === 'object' ? body.metrics : {})) {
    if (!IDS.has(id) || !raw || typeof raw !== 'object') continue;
    const max = METRICS.find((metric) => metric.id === id).format === 'pct' ? 1 : 1e7;
    const entry = { p50: number(raw.p50, max), p90: number(raw.p90, max), value: number(raw.value, max), pct: number(raw.pct, 100) };
    if (entry.p50 !== undefined && entry.p90 !== undefined && !(entry.p90 > entry.p50)) throw new Error(`${METRICS.find((m) => m.id === id).title}: the 90th must be above the 50th.`);
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
    if (Object.keys(entry).length) metrics[id] = entry;
  }
  return { game: game.id, value: { basis: BASES[body.basis] ? body.basis : null, metrics } };
}
