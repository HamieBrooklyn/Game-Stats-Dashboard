// The panel's tab math (Spotlight Admin src/server/Stats/Query.lua @ dd14298), ported so the dashboard shows the
// same numbers. Builds the same widget JSON the panel draws. Reads saved store values through `read(key)`
// (the collector's cache of the game's DataStore). Only the tabs the dashboard has are ported: Overview and Live
// here, Funnels in funnels.js.

import * as S from './stats.js';
import { buildFunnelView } from './funnels.js';

// Splits a bucket's counters for one filter suffix into name -> label -> value (indexBucket)
function indexBucket(bucket, suffix) {
  const result = {};
  for (const [key, value] of Object.entries(bucket.c)) {
    const bar = key.indexOf('|');
    const dims = bar >= 0 ? key.slice(bar) : '';
    if (dims !== suffix) continue;
    const base = bar >= 0 ? key.slice(0, bar) : key;
    const hash = base.indexOf('#');
    const name = hash >= 0 ? base.slice(0, hash) : base;
    const label = hash >= 0 ? base.slice(hash + 1) : '';
    result[name] ??= {};
    result[name][label] = (result[name][label] || 0) + value;
  }
  return result;
}

export const get = (source, name, label = '') => source[name]?.[label] ?? 0;
export function labelsOf(source, name) {
  const labels = { ...(source[name] || {}) };
  delete labels[''];
  return labels;
}
export const ratio = (a, b) => (b > 0 ? a / b : 0);
const slotValue = (bucket, name, suffix) => bucket.c[name + suffix] || 0;
const series = (slots, name, suffix) => slots.map((bucket) => slotValue(bucket, name, suffix));
const peakSeries = (slots, name) => slots.map((bucket) => bucket.m[name] || 0);

function gapNames(range) {
  return range.unit === 'Hour' ? ['hau', 'hau_gap', S.GAP_HOURS] : ['dau', 'dau_gap', S.GAP_DAYS];
}

// Players counted once over the slots: each slot adds those whose last visit was before the window started
export function uniques(range, slots) {
  const [, gapName, window] = gapNames(range);
  let total = 0;
  slots.forEach((bucket, index) => {
    total += slotValue(bucket, `${gapName}#new`, range.suffix) + slotValue(bucket, `${gapName}#old`, range.suffix);
    for (let gap = index + 1; gap <= window; gap++) total += slotValue(bucket, `${gapName}#${gap}`, range.suffix);
  });
  return total;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function slotLabel(unit, slot) {
  if (unit === 'Hour') return `${String((slot % 24 + 24) % 24).padStart(2, '0')}:00`;
  const date = new Date(slot * 86400000);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// The range's buckets (this period and the one before), added up over shards (loadRange)
export function loadRange(game, read, rangeId, suffix = '', at = S.now()) {
  const spec = S.RANGES[rangeId];
  const size = spec.unit === 'Hour' ? 3600 : 86400;
  const current = Math.floor(at / size);
  const first = current - spec.count + 1;
  const key = spec.unit === 'Hour' ? S.hourKey : S.dayKey;
  const slotBucket = (slot) => {
    const bucket = S.emptyBucket();
    for (let shard = 0; shard < game.shards; shard++) S.addInto(bucket, read(key(slot, shard)));
    return bucket;
  };
  const slots = [], prevSlots = [], labels = [];
  const total = S.emptyBucket(), prevTotal = S.emptyBucket();
  for (let index = 0; index < spec.count; index++) {
    const bucket = slotBucket(first + index);
    const prevBucket = slotBucket(first - spec.count + index);
    slots.push(bucket);
    prevSlots.push(prevBucket);
    labels.push(slotLabel(spec.unit, first + index));
    S.addInto(total, bucket);
    S.addInto(prevTotal, prevBucket);
  }
  return {
    id: rangeId, unit: spec.unit, count: spec.count, size, first, suffix, slots, prevSlots, labels,
    index: indexBucket(total, suffix), prevIndex: indexBucket(prevTotal, suffix), peaks: total.m,
  };
}

// The cohorts of the last `days` days, today's included (loadCohorts)
export function loadCohorts(read, days, at = S.now()) {
  const today = S.dayOf(at);
  const cohorts = [];
  for (let day = today - days + 1; day <= today; day++) {
    const counts = read(S.cohortKey(day));
    cohorts.push({ day, counts: counts && typeof counts === 'object' ? counts : {} });
  }
  return cohorts;
}

// Share of the cohorts' players back on day `offset`, of the cohorts old enough to know; null if none are
export function retention(cohorts, offset, suffix = '', at = S.now()) {
  const today = S.dayOf(at);
  let size = 0, back = 0;
  for (const cohort of cohorts) {
    if (cohort.day + offset < today) {
      size += cohort.counts['size' + suffix] || 0;
      back += cohort.counts[`d${offset}${suffix}`] || 0;
    }
  }
  return size > 0 ? back / size : null;
}

function markers(read, range) {
  const saved = read('Markers');
  const list = [];
  if (!saved || typeof saved !== 'object') return list;
  const start = range.first * range.size;
  for (const marker of saved.List || []) {
    const pos = (marker.T - start) / range.size;
    if (pos >= 0 && pos < range.count) list.push({ At: pos, Text: marker.Text, Kind: marker.Kind });
  }
  return list;
}

// Widgets (the panel's shapes)
export const tile = (label, value, prev, format, spark, good = 'up') => ({ Label: label, Value: value, Prev: prev, Format: format, Spark: spark, Good: good });
export const tiles = (items) => ({ Type: 'Tiles', Items: items });
export const note = (text, tone) => ({ Type: 'Text', Text: text, Tone: tone });
export const section = (title) => ({ Type: 'Section', Title: title });
const line = (read, title, format, range, list, withMarkers) => ({
  Type: 'Line', Title: title, Format: format, Labels: range.labels, Series: list, Partial: true,
  Markers: withMarkers ? markers(read, range) : undefined,
});

// The Overview tab (Tabs.Overview). D1 is null (shown "—") when no cohort is old enough yet.
export function overviewTab(game, read, rangeId, at = S.now()) {
  const range = loadRange(game, read, rangeId, '', at);
  const cur = range.index, prev = range.prevIndex;
  const active = gapNames(range)[0];
  const players = uniques(range, range.slots), prevPlayers = uniques(range, range.prevSlots);
  const playerDays = get(cur, 'dau'), prevPlayerDays = get(prev, 'dau');
  const cohorts = loadCohorts(read, Math.max(range.count, 7) + 1, at);
  const d1 = retention(cohorts, 1, range.suffix, at);
  const activeSeries = series(range.slots, active, range.suffix);
  const robuxSeries = series(range.slots, 'robux', range.suffix);
  const ccuSeries = peakSeries(range.slots, 'ccu');
  return {
    widgets: [
      tiles([
        tile('Players', players, prevPlayers, 'int', activeSeries),
        tile('New players', get(cur, 'new_users'), get(prev, 'new_users'), 'int', series(range.slots, 'new_users', range.suffix)),
        tile('Avg session', ratio(get(cur, 'session_sum'), get(cur, 'sessions_ended')), ratio(get(prev, 'session_sum'), get(prev, 'sessions_ended')), 'dur'),
        tile('Playtime / player', ratio(get(cur, 'playtime'), players), ratio(get(prev, 'playtime'), prevPlayers), 'dur'),
        tile('Peak online', range.peaks.ccu || 0, undefined, 'int', ccuSeries),
        tile('Robux spent', get(cur, 'robux'), get(prev, 'robux'), 'robux', robuxSeries),
        tile('Payer conversion', ratio(get(cur, 'payers'), playerDays), ratio(get(prev, 'payers'), prevPlayerDays), 'pct'),
        tile('D1 retention', d1, undefined, 'pct'),
      ]),
      line(read, `Players each ${range.unit.toLowerCase()}`, 'int', range, [
        { Name: 'This period', Values: activeSeries },
        { Name: 'Period before', Values: series(range.prevSlots, active, range.suffix) },
      ], true),
      line(read, 'Robux spent', 'robux', range, [
        { Name: 'This period', Values: robuxSeries },
        { Name: 'Period before', Values: series(range.prevSlots, 'robux', range.suffix) },
      ], true),
      line(read, 'Peak players online (all servers)', 'int', range, [{ Name: 'Peak online', Values: ccuSeries }], true),
    ],
    // Raw numbers for the all-games page (it adds them up the right way)
    totals: {
      players, playerDays, newUsers: get(cur, 'new_users'), sessionSum: get(cur, 'session_sum'), sessionsEnded: get(cur, 'sessions_ended'),
      playtime: get(cur, 'playtime'), robux: get(cur, 'robux'), payers: get(cur, 'payers'),
      d1Size: cohorts.filter((c) => c.day + 1 < S.dayOf(at)).reduce((sum, c) => sum + (c.counts.size || 0), 0),
      d1Back: cohorts.filter((c) => c.day + 1 < S.dayOf(at)).reduce((sum, c) => sum + (c.counts.d1 || 0), 0),
      activeSeries, labels: range.labels,
    },
  };
}

// The Live tab (Tabs.Live): the servers from MemoryStore, and the 24-hour peak line
export function liveTab(game, read, servers, at = S.now()) {
  if (!servers) return { widgets: [note("Couldn't read the live servers (MemoryStore).", 'error')] };
  const list = [...servers].sort((a, b) => b.Players - a.Players);
  let online = 0, newest = 0, privateCount = 0;
  const rows = list.map((server) => {
    online += server.Players;
    newest = Math.max(newest, server.Version);
    if (server.Private) privateCount++;
    return [String(server.Id).slice(0, 8), server.Players, server.Version, server.Uptime, server.Fps, server.Private ? 'Private' : 'Public'];
  });
  const outdated = list.filter((server) => server.Version < newest).length;
  const day = loadRange(game, read, '24h', '', at);
  return {
    widgets: [
      tiles([
        tile('Online now', online, undefined, 'int'),
        tile('Servers', list.length, undefined, 'int'),
        tile('Players / server', ratio(online, list.length), undefined, 'num'),
        tile('Private servers', privateCount, undefined, 'int'),
        tile('On an old version', outdated, undefined, 'int', undefined, 'none'),
      ]),
      line(read, 'Peak online, last 24 hours', 'int', day, [{ Name: 'Peak online', Values: peakSeries(day.slots, 'ccu') }], true),
      {
        Type: 'Table',
        Title: 'Servers',
        Columns: [
          { Name: 'Server', Format: 'text' }, { Name: 'Players', Format: 'int' }, { Name: 'Version', Format: 'int' },
          { Name: 'Up', Format: 'dur' }, { Name: 'FPS', Format: 'int' }, { Name: 'Kind', Format: 'text' },
        ],
        Rows: rows,
      },
    ],
    online,
    servers: list.length,
  };
}

// The Funnels tab (Tabs.Funnels): the package's Funnels.buildView, then the per-event onboarding funnel
export function funnelsTab(game, read, rangeId, at = S.now()) {
  const range = loadRange(game, read, rangeId, '', at);
  const days = range.unit === 'Hour' ? 1 : range.count;
  const journeys = read(S.JOURNEYS_KEY);
  const widgets = buildFunnelView({
    funnels: funnelDefsOf(read(S.DEFS_KEY)),
    cohorts: loadCohorts(read, days, at),
    index: range.index,
    suffix: '',
    journeys: Array.isArray(journeys) ? journeys : [],
    defs: read(S.DEFS_KEY),
    rangeLabel: days === 1 ? 'today' : `last ${days} days`,
    journeyFunnel: game.journeyFunnel,
  });
  const events = labelsOf(range.index, 'onb');
  if (Object.keys(events).length) {
    widgets.push(section("Step events (every time, like Roblox's funnels)"));
    widgets.push(stepEventsFunnel('Onboarding step events', events));
  }
  return { widgets };
}

// A funnel widget from "<nn>:<step>" labels (funnelWidget)
function stepEventsFunnel(title, steps) {
  const list = [];
  for (const [key, value] of Object.entries(steps)) {
    const match = /^(\d+):(.*)$/.exec(key);
    if (match) list.push({ Order: Number(match[1]), Label: match[2], Value: value });
  }
  list.sort((a, b) => a.Order - b.Order);
  return { Type: 'Funnel', Title: title, Steps: list };
}

// The funnels as the game's newest server saved them (FunnelDefs), else the built-in ones only
export function funnelDefsOf(defs) {
  if (defs && Array.isArray(defs.Funnels)) return defs.Funnels;
  return S.BUILT_IN_FUNNELS.map((funnel) => ({ ...funnel, Steps: funnel.Steps.map((id) => ({ Id: id, Label: S.labelOf(id) })) }));
}
