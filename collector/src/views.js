// Builds every view the dashboard asks for from the cache, after each poll, so requests only serve ready JSON
// (with an ETag). Per game: Overview, Funnels and Live (the panel's math, query.js / funnels.js). All games:
// totals added up the right way (sums of counts, never averages of percentages), each game's status, and
// players online over 24 hours from the collector's own 15 s samples.

import crypto from 'node:crypto';
import * as S from './stats.js';
import { overviewTab, liveTab, funnelsTab, funnelDefsOf, ratio } from './query.js';
import { presentFunnels } from './present.js';

const RANGE_IDS = Object.keys(S.RANGES);
const SAMPLE_BIN = 300; // the online line's bins: 5 minutes

// How long a source may go without a good read before the game counts as stale (live is read every 15 s,
// buckets every 60 s; one failed read is a blip, not an outage)
export const LIVE_STALE = 120;
export const STORE_STALE = 300;

const minutes = (seconds) => `${Math.max(1, Math.round(seconds / 60))} min`;

// What a game's data sources look like right now. Each source is judged on its own, so working live reads
// can't hide failing DataStore reads (or the other way round).
export function gameStatus(game, sources, read, at) {
  if (!game.universeId) return { state: 'unconfigured', label: 'Not set up', detail: 'No universe id in games.json yet.' };
  const of = (source) => sources.find((row) => row.game === game.id && row.source === source) || {};
  const live = of('live'), store = of('datastore'), feedback = of('feedback');
  const failing = (source) => (source.error_at || 0) > (source.ok_at || 0);
  if (!store.ok_at) {
    return store.error_at
      ? { state: 'error', label: "Can't read stats", detail: store.error }
      : { state: 'pending', label: 'Starting', detail: 'First reads are on their way.' };
  }
  const storeAge = at - store.ok_at;
  if (failing(store) && storeAge > STORE_STALE) return { state: 'error', label: "Can't read stats", detail: `No good read for ${minutes(storeAge)}: ${store.error}` };
  const hasStats = Boolean(read(S.DEFS_KEY)) || Boolean(read(S.dayKey(S.dayOf(at), 0)));
  if (!hasStats) return { state: 'empty', label: 'No stats yet', detail: "This game's admin panel doesn't record stats yet (update its Spotlight Admin copy)." };
  if (storeAge > STORE_STALE) return { state: 'stale', label: 'Stale', detail: `Stats last read ${minutes(storeAge)} ago` };
  const liveAge = live.ok_at ? at - live.ok_at : Infinity;
  if (liveAge > LIVE_STALE) {
    return { state: 'stale', label: 'Stale', detail: live.ok_at ? `Live servers last read ${minutes(liveAge)} ago${live.error ? `: ${live.error}` : ''}` : `Can't read live servers${live.error ? `: ${live.error}` : ''}` };
  }
  if (game.feedback && failing(feedback)) return { state: 'ok', label: 'Live', detail: `Reading normally, but feedback fails: ${feedback.error}` };
  return { state: 'ok', label: 'Live', detail: 'Reading normally' };
}

// Players online summed over games, in 5-minute bins (each game's average in a bin). A bin where any game that
// reported in the last 24 hours (from its first sample on) has no sample is a gap, never a smaller total that
// would look like a drop.
export function onlineSeries(games, samples, at) {
  const start = Math.floor((at - 86400) / SAMPLE_BIN) * SAMPLE_BIN;
  const bins = Math.ceil((at - start) / SAMPLE_BIN);
  const perGame = new Map();
  for (const row of samples) {
    const index = Math.floor((row.t - start) / SAMPLE_BIN);
    if (index < 0 || index >= bins) continue;
    let list = perGame.get(row.game);
    if (!list) perGame.set(row.game, (list = Array.from({ length: bins }, () => ({ sum: 0, n: 0 }))));
    list[index].sum += row.players;
    list[index].n++;
  }
  const series = games.filter((game) => perGame.has(game.id)).map((game) => ({
    Name: game.name,
    Slot: game.slot,
    Values: perGame.get(game.id).map((bin) => (bin.n ? bin.sum / bin.n : null)),
  }));
  const firstBin = series.map((entry) => entry.Values.findIndex((value) => value !== null));
  const total = Array.from({ length: bins }, (_, index) => {
    const values = series.filter((_, i) => index >= firstBin[i]).map((entry) => entry.Values[index]);
    return values.length && values.every((value) => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
  });
  const labels = Array.from({ length: bins }, (_, index) => {
    const date = new Date((start + index * SAMPLE_BIN) * 1000);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  });
  return { labels, total, series };
}

// Players online now across games, or null when a game that should report has no fresh count
export function playingNow(rows) {
  const expected = rows.filter((row) => row.status.state !== 'unconfigured' && row.status.state !== 'empty' && row.status.state !== 'pending');
  if (!expected.length || expected.some((row) => row.online === null || row.online === undefined)) return null;
  return expected.reduce((total, row) => total + row.online, 0);
}

// The ETag leaves out "at" (when the view was built), so an unchanged view really answers 304
function withEtag(body) {
  const json = JSON.stringify(body);
  const { at, ...content } = body;
  return { json, etag: `"${crypto.createHash('sha1').update(JSON.stringify(content)).digest('base64url').slice(0, 20)}"` };
}

export function buildViews(games, db, at = S.now()) {
  const views = new Map();
  const sources = db.sources();
  const gameRows = [];
  const allTotals = Object.fromEntries(RANGE_IDS.map((id) => [id, []]));
  for (const game of games) {
    const read = (key) => db.entry(game.id, key)?.value ?? undefined;
    const status = gameStatus(game, sources, read, at);
    // Live servers only while fresh: an old count is never shown as "playing now"
    const liveEntry = db.entry(game.id, '$live');
    const servers = liveEntry && liveEntry.fetchedAt >= at - LIVE_STALE / 2 ? liveEntry.value : null;
    const base = { game: { id: game.id, name: game.name, slot: game.slot }, status, at, utc: true };
    let live = null;
    if (game.universeId) {
      for (const rangeId of RANGE_IDS) {
        const overview = overviewTab(game, read, rangeId, at);
        allTotals[rangeId].push({ game, totals: overview.totals, status });
        views.set(`/v1/games/${game.id}/overview?range=${rangeId}`, withEtag({ ...base, range: rangeId, widgets: overview.widgets }));
        const funnels = presentFunnels(funnelsTab(game, read, rangeId, at).widgets, {
          funnels: funnelDefsOf(read(S.DEFS_KEY)),
          notes: game.funnelNotes || {},
          rangeLabel: rangeId === '24h' ? 'last day' : `last ${S.RANGES[rangeId].count} days`,
        });
        views.set(`/v1/games/${game.id}/funnels?range=${rangeId}`, withEtag({ ...base, range: rangeId, widgets: funnels }));
      }
      live = liveTab(game, read, servers, at);
      views.set(`/v1/games/${game.id}/live`, withEtag({ ...base, widgets: live.widgets }));
    }
    gameRows.push({ game, status, online: live ? live.online : null, servers: live ? live.servers : null });
  }

  const online = onlineSeries(games, db.ccuSince(at - 86400 - SAMPLE_BIN), at);
  for (const rangeId of RANGE_IDS) {
    const list = allTotals[rangeId];
    const sum = (field) => list.reduce((total, entry) => total + (entry.totals[field] || 0), 0);
    const reporting = gameRows.filter((row) => row.status.state === 'ok' || row.status.state === 'stale');
    const d1Size = sum('d1Size'), d1Back = sum('d1Back');
    views.set(`/v1/overview?range=${rangeId}`, withEtag({
      at,
      range: rangeId,
      coverage: { reporting: reporting.length, total: games.length },
      kpis: {
        // Unknown while any game that should report has no fresh count: never a partial total
        online: playingNow(gameRows),
        playersSummed: sum('players'),
        newPlayers: sum('newUsers'),
        avgSession: ratio(sum('sessionSum'), sum('sessionsEnded')),
        robux: sum('robux'),
        conversion: ratio(sum('payers'), sum('playerDays')),
        d1: d1Size > 0 ? d1Back / d1Size : null,
      },
      online,
      games: gameRows.map((row) => {
        const entry = list.find((item) => item.game.id === row.game.id);
        const t = entry?.totals;
        return {
          id: row.game.id, name: row.game.name, slot: row.game.slot, status: row.status,
          online: row.online, servers: row.servers,
          players: t ? t.players : null, newPlayers: t ? t.newUsers : null,
          avgSession: t ? ratio(t.sessionSum, t.sessionsEnded) : null, robux: t ? t.robux : null,
          d1: t && t.d1Size > 0 ? t.d1Back / t.d1Size : null,
          spark: t ? t.activeSeries : [], labels: t ? t.labels : [],
        };
      }),
    }));
  }
  views.set('/v1/feedback', withEtag(feedbackView(games, db)));
  return views;
}

// Feedback from every game, newest first: only what the page shows (no player snapshot)
export function feedbackView(games, db) {
  const names = Object.fromEntries(games.map((game) => [game.id, game.name]));
  const items = db.feedback().filter(({ game }) => game in names).map(({ game, entry }) => ({
    game, gameName: names[game] || game, id: entry.Id, at: entry.At, name: entry.Name, displayName: entry.DisplayName,
    text: String(entry.Text ?? ''), sentiment: entry.Sentiment, tags: Array.isArray(entry.Tags) ? entry.Tags : [],
    status: entry.Status, resolvedBy: entry.ResolvedBy || null, platform: entry.Device?.Platform || null,
  }));
  return { items, games: games.filter((game) => game.feedback).map((game) => ({ id: game.id, name: game.name })) };
}

// What one person may see: a game's own pages only when it's one of theirs, and the all-games pages (totals,
// feedback) built from their games alone (scopedViews), so a total never includes a game they can't see.
// who.games null = every game.
export function viewGate(allViews, scopedViews) {
  return (pathname, params, who) => {
    const range = params.get('range');
    const key = range ? `${pathname}?range=${range}` : pathname;
    const game = /^\/v1\/games\/([^/]+)\//.exec(pathname);
    if (game && who.games && !who.games.includes(game[1])) return null;
    const views = game || !who.games ? allViews() : scopedViews(who.games);
    return views.get(key) || null;
  };
}
