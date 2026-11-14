// Roblox's genre, measured: other games in the same Roblox genre as ours (genre_l1 → genre_l2, e.g. Simulation →
// Tycoon), from Roblox's public game data, so the Benchmarks cards have a 50th and 90th before Roblox shows any.
//
// What public data allows: a game's players online and its visit counter. Average session length follows from
// those (Little's law: players online × time = sessions × average session), so for each game:
// average session = player-time ÷ new visits. Checked on our own games: Roblox's visits are about 92% of the
// sessions the panel counts, so these run a little high. Retention, conversion and revenue aren't public for
// other games, so those cards fall back on Roblox's numbers (benchmarks.js).
//
// - Our games' genres: from Roblox, at start and every 12 hours.
// - Discovery (12-hourly): Roblox has no genre filter, so candidates come from its charts and from searching
//   words of the genre; the ones Roblox files under our genre with players on are kept (MAX_PEERS per genre).
// - Sampling (every 10 min): players online and visits of every peer and of our own games, 50 per request,
//   paced (Roblox answers bursts with 429). Each interval adds its player-seconds and new visits to the hour it
//   ended in (peer_hours), so the hours with gaps simply count less, on both sides.

import crypto from 'node:crypto';
import * as S from './stats.js';

const GAMES_URL = 'https://games.roblox.com/v1/games?universeIds=';
const SEARCH_URL = 'https://apis.roblox.com/search-api/omni-search';
const SORTS_URL = 'https://apis.roblox.com/explore-api/v1/get-sorts';
const BATCH = 50; // the most the games endpoint takes
const SAMPLE_EVERY = 600;
const DISCOVER_EVERY = 12 * 3600;
const MAX_PEERS = 300; // per genre
const MIN_PLAYING = 3; // at discovery
const MAX_GAP = 1800; // a longer gap between two samples isn't counted
const SEARCH_PAGES = 8;
// Words that find a genre's games (Roblox's search has no genre filter); the genre's own name otherwise
const SEARCH_WORDS = {
  Tycoon: ['tycoon'],
  'Physics Sim': ['physics', 'ragdoll', 'destruction', 'car crash'],
  Incremental: ['incremental', 'clicker', 'idle'],
  'Idle Sim': ['idle', 'afk'],
};

export const genreKey = (genre) => (genre && genre.l1 && genre.l2 ? `${genre.l1} → ${genre.l2}` : null);

// A game's average session (s) from its player-seconds and new visits
export const sessionOf = (playerSeconds, visits) => (visits > 0 ? playerSeconds / visits : null);

// What one sample adds since the one before: player-seconds (trapezoid), new visits, seconds covered; null when
// it can't be counted (no sample before, a long gap, or a counter that went back)
export function interval(before, after) {
  if (!before || !after) return null;
  const seconds = after.t - before.t;
  if (seconds <= 0 || seconds > MAX_GAP || after.visits < before.visits) return null;
  return { ps: ((before.playing + after.playing) / 2) * seconds, dv: after.visits - before.visits, cov: seconds };
}

// fetchJson(url) -> parsed JSON (throws on errors); wait(ms) between requests
export function createPeers({ games, db, log, onChange, fetchJson = defaultFetch, gapMs = 5000, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const own = () => games.filter((game) => game.universeId).map((game) => Number(game.universeId));
  const timers = [];
  let lastDiscovery = db.lastDiscovery(); // a restart doesn't search again
  let busy = false;

  async function details(ids) {
    const list = [];
    for (let index = 0; index < ids.length; index += BATCH) {
      if (index) await wait(gapMs);
      const answer = await fetchJson(GAMES_URL + ids.slice(index, index + BATCH).join(','));
      list.push(...(answer?.data || []));
    }
    return list;
  }

  const genreOf = (game) => ({ l1: game.genre_l1 || null, l2: game.genre_l2 || null });

  // Our games' genres
  async function refreshOwn() {
    const at = S.now();
    for (const game of await details(own())) db.putPeer({ universe: game.id, name: game.name, ...genreOf(game), own: true, playing: game.playing }, at);
  }

  async function discover() {
    await refreshOwn();
    const wanted = new Map(); // genre key -> genre
    for (const universe of own()) {
      const genre = db.peer(universe);
      if (genreKey(genre)) wanted.set(genreKey(genre), genre);
    }
    if (!wanted.size) return;
    const candidates = new Set();
    const session = crypto.randomUUID();
    try {
      const sorts = await fetchJson(`${SORTS_URL}?sessionId=${session}`);
      for (const sort of sorts?.sorts || []) for (const game of sort.games || []) if (game.universeId) candidates.add(Number(game.universeId));
    } catch (error) {
      log(`peers: charts failed: ${error.message}`);
    }
    const words = new Set();
    for (const genre of wanted.values()) for (const word of SEARCH_WORDS[genre.l2] || [genre.l2.toLowerCase()]) words.add(word);
    for (const word of words) {
      let token = '';
      for (let page = 0; page < SEARCH_PAGES; page++) {
        await wait(gapMs);
        let answer;
        try {
          answer = await fetchJson(`${SEARCH_URL}?searchQuery=${encodeURIComponent(word)}&sessionId=${session}&pageType=all${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
        } catch (error) {
          log(`peers: search "${word}" failed: ${error.message}`);
          break;
        }
        for (const group of answer?.searchResults || []) for (const item of group.contents || []) if (item.universeId) candidates.add(Number(item.universeId));
        token = answer?.nextPageToken;
        if (!token) break;
      }
    }
    for (const universe of own()) candidates.delete(universe);
    const at = S.now();
    const found = new Map([...wanted.keys()].map((key) => [key, []]));
    for (const game of await details([...candidates])) {
      const key = genreKey(genreOf(game));
      if (found.has(key) && game.playing >= MIN_PLAYING) found.get(key).push(game);
    }
    for (const [key, list] of found) {
      list.sort((a, b) => b.playing - a.playing);
      for (const game of list.slice(0, MAX_PEERS)) db.putPeer({ universe: game.id, name: game.name, ...genreOf(game), own: false, playing: game.playing }, at);
      db.trimPeers(wanted.get(key), MAX_PEERS);
      log(`peers: ${Math.min(list.length, MAX_PEERS)} ${key} games tracked (${list.length} found)`);
    }
    lastDiscovery = at;
  }

  async function sample() {
    const ids = [...new Set([...own(), ...db.activePeers()])];
    if (!ids.length) return;
    const at = S.now();
    const rows = [];
    for (const game of await details(ids)) {
      const now = { t: at, playing: game.playing || 0, visits: game.visits || 0 };
      const last = db.peerLast(game.id);
      rows.push({ universe: game.id, genre: genreOf(game), name: game.name, last: now, add: interval(last, now) });
    }
    db.transaction(() => {
      for (const row of rows) db.putPeerSample(row.universe, row.last, row.add, S.hourOf(at), row.genre);
    });
    onChange?.();
  }

  // Runs one job at a time (discovery can take minutes), logging failures
  async function run(job, name) {
    if (busy) return;
    busy = true;
    try {
      await job();
      db.sourceOk('$peers', name, S.now());
    } catch (error) {
      db.sourceFailed('$peers', name, error.message, S.now());
      log(`peers: ${name} failed: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (!own().length) return;
      const tick = async () => {
        if (S.now() - lastDiscovery >= DISCOVER_EVERY || !db.activePeers().length) await run(discover, 'discover');
        await run(sample, 'sample');
      };
      setTimeout(tick, 20 * 1000);
      timers.push(setInterval(tick, SAMPLE_EVERY * 1000));
      timers.push(setInterval(() => db.prunePeerHours(S.hourOf(S.now()) - 35 * 24), 3600 * 1000));
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
    _internal: { discover, sample, refreshOwn },
  };
}

// Roblox's public APIs: no key; one retry after a 429 or 5xx
async function defaultFetch(url) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 60000));
      continue;
    }
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
    return response.json();
  }
}

// The genre's games over the last `days` days: each one's average session (s), the ones measured long enough and
// big enough to count (Roblox's own benchmarks only compare games with 100+ daily users: here 100+ visits a day)
export function peerSessions(rows, days) {
  const window = days * 86400;
  const minCover = Math.min(6 * 3600, window / 2);
  const values = [];
  let longest = 0;
  for (const row of rows) {
    longest = Math.max(longest, row.cov);
    if (row.cov < minCover || row.dv < 20 || (row.dv / row.cov) * 86400 < 100) continue;
    values.push(row.ps / row.dv);
  }
  values.sort((a, b) => a - b);
  return { values, count: values.length, tracked: rows.length, hours: Math.round(longest / 3600) };
}
