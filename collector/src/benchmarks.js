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
//   impressions, so this card shows Roblox's own number, never a live one.
//
// Roblox's own number for each card and window comes from its Analytics API (analytics.js, hourly), else from
// what the owner copied in. The live cards show it beside theirs, to compare.
//
// Days are UTC, like the rest of the dashboard. "Live": the window ends now, so today so far is in it. Each
// window is pooled (sum of the tops ÷ sum of the bottoms), so a quiet few hours today move it as little as their
// size deserves. Roblox averages the daily values of complete days instead; that number is sent too ("Roblox"),
// to check one against the other.
//
// The 50th and 90th percentiles: each card takes the best source there is (Source on the card says which):
// 1. Roblox's own, copied in by the owner (Roblox's peer group: experiences your players also play, else the
//    genre, else all experiences; Roblox only shows them once a game has 100+ daily users).
// 2. Average playtime only: measured live on the other games in the game's Roblox genre (peers.js), from
//    Roblox's public data. The percentile is then the share of those games below.
// 3. Roblox's, copied in for another of our games in the same Roblox genre.
// 4. Published Roblox-wide medians (GameAnalytics' 2026 Roblox report), for playtime, D1 and D7.
// Where the live number falls between two marks: a curve through them (and through Roblox's own number at its
// own percentile, when copied in), straight in log value against the normal quantile, so a log-normal spread
// of experiences. On Roblox's own example that lands within 10 points on 5 of 6 cards.

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

// GameAnalytics, 2026 Roblox Benchmark Report (games with 1M+ monthly users): medians and the top 5% / 1%.
// The 90th is read off a log-normal through them. Not genre-specific: the last resort.
const Z95 = 1.6448536269514722, Z99 = 2.3263478740408408;
const ninetieth = (median, top, z) => Math.exp(Math.log(median) + (Z90 / z) * (Math.log(top) - Math.log(median)));
export const PUBLISHED = {
  playtime: { p50: 9.8 * 60, p90: ninetieth(9.8 * 60, 16.6 * 60, Z95) },
  d1: { p50: 0.103, p90: ninetieth(0.103, 0.222, Z99) },
  d7: { p50: 0.016, p90: ninetieth(0.016, 0.091, Z99) },
};
const PUBLISHED_LABEL = 'Roblox-wide medians (GameAnalytics 2026 Roblox report), not your genre';
const MIN_PEERS = 10; // genre games needed before their spread is used

// The value at fraction `p` of sorted `values` (linear between neighbours)
export function quantile(values, p) {
  if (!values.length) return null;
  const at = p * (values.length - 1);
  const low = Math.floor(at), high = Math.ceil(at);
  return values[low] + (values[high] - values[low]) * (at - low);
}

// The share of sorted `values` below `value` (0-100), ties counting half
export function rankOf(values, value) {
  if (!values.length || value === null || value === undefined || !Number.isFinite(value)) return null;
  let below = 0, equal = 0;
  for (const entry of values) {
    if (entry < value) below++;
    else if (entry === value) equal++;
  }
  return (100 * (below + equal / 2)) / values.length;
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

// Where a card's 50th and 90th come from (the best there is): { bench, source } or null.
// context: { genre, peers: { [days]: peerSessions(...) }, others: [Roblox benchmarks saved for our other games
// in the same Roblox genre] }
function marksFor(metric, days, marks, context) {
  const own = marks[metric.id];
  if (own && own.p50 > 0 && own.p90 > own.p50) return { bench: own, source: { kind: 'roblox', label: "Roblox's benchmark for this game" } };
  if (metric.robloxOnly) return null;
  const peers = context.peers?.[days];
  if (metric.id === 'playtime' && peers && peers.count >= MIN_PEERS) {
    return {
      bench: { p50: quantile(peers.values, 0.5), p90: quantile(peers.values, 0.9), values: peers.values },
      source: { kind: 'genre', label: `${peers.count} ${context.genre?.l2 || ''} games on Roblox (${context.genre?.l1 || ''}), measured live${peers.hours < days * 24 ? ` over the last ${peers.hours} h so far` : ''}` },
    };
  }
  for (const other of context.others || []) {
    const theirs = other?.metrics?.[metric.id];
    if (theirs && theirs.p50 > 0 && theirs.p90 > theirs.p50) {
      return { bench: { p50: theirs.p50, p90: theirs.p90 }, source: { kind: 'other', label: `Roblox's benchmark for another of your ${context.genre?.l1 || ''} games` } };
    }
  }
  if (PUBLISHED[metric.id]) return { bench: PUBLISHED[metric.id], source: { kind: 'published', label: PUBLISHED_LABEL } };
  return null;
}

// The widget for one game's Overview. `saved`: the owner's copy of Roblox's numbers ({ basis, at, metrics });
// `context`: see marksFor.
// context.roblox: Roblox's analytics numbers (db.robloxMetrics)
export function benchmarksWidget(game, read, at = S.now(), saved = null, context = {}) {
  const stored = saved && typeof saved === 'object' ? saved : {};
  const marks = stored.metrics || {};
  const windows = {};
  for (const days of WINDOWS) {
    windows[days] = METRICS.map((metric) => {
      const bench = marks[metric.id] || {};
      const copied = bench.value >= 0 && Number.isFinite(bench.value) ? { Value: bench.value, Percentile: Number.isFinite(bench.pct) ? bench.pct : null } : null;
      const found = marksFor(metric, days, marks, context);
      const benchmark = found ? { P50: found.bench.p50, P90: found.bench.p90 } : null;
      const source = found ? { Kind: found.source.kind, Label: found.source.label } : null;
      const place = (value) => {
        if (!found) return null;
        if (found.bench.values) return rankOf(found.bench.values, value);
        return percentileOf(value, found.source.kind === 'roblox' ? found.bench : { p50: found.bench.p50, p90: found.bench.p90 });
      };
      // Roblox's own number for this window, from its Analytics API (analytics.js); else the one copied in
      const api = context.roblox?.windows?.[days]?.[metric.id];
      const fromRoblox = Number.isFinite(api) ? { Value: api, Percentile: place(api), Api: true, At: context.roblox.at } : copied;
      if (metric.robloxOnly) {
        return { Id: metric.id, Title: metric.title, Format: metric.format, Info: metric.info, Live: false, Value: fromRoblox?.Value ?? null, Prev: null, Percentile: fromRoblox?.Percentile ?? null, Benchmark: benchmark, Source: source, FromRoblox: fromRoblox, Copied: copied };
      }
      const result = measure(metric, game, read, days, at);
      return {
        Id: metric.id, Title: metric.title, Format: metric.format, Info: metric.info, Live: true,
        Value: result.value, Prev: result.prev, Roblox: result.roblox, Size: result.size, Small: result.size < (SMALL[metric.id] || 0),
        Percentile: place(result.value), Benchmark: benchmark, Source: source, FromRoblox: fromRoblox, Copied: copied,
      };
    });
  }
  const genre = context.genre?.l1 && context.genre?.l2 ? `${context.genre.l1} → ${context.genre.l2}` : null;
  return {
    Type: 'Benchmarks', Game: game.id, Basis: BASES[stored.basis] ? stored.basis : null,
    BasisLabel: BASES[stored.basis] || (genre ? `your genre, ${genre}` : null), Genre: genre, SavedAt: stored.at || null, Windows: windows,
    RobloxAt: context.roblox?.at || null,
  };
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
