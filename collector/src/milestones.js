// Milestones: moments worth a celebration on the dashboard (a game's first sale, 100 playing at once, 250 highly
// engaged players...). After each build the collector checks every game's all-time numbers against the steps
// below, and a step reached is saved once with when it was reached (db: milestones), so it's celebrated once,
// on every computer that opens the dashboard (each browser remembers which ones it has shown).
//
// - The first check of a game saves what it had already reached as "quiet": history, never a celebration.
// - Several steps of one kind reached at once (the owner copying in 140 engaged players): only the highest is
//   celebrated, the others are saved quiet.
//
// Highly engaged players are Roblox's own count (Creator Hub → the experience → Publish settings → Manage
// audience): Roblox doesn't say exactly who counts (account age, playtime in the game, spending anywhere on
// Roblox), and the games' stats have no per-player data. The collector reads it live from Creator Hub when it
// has an account cookie (audience.js); otherwise the owner copies it in. Either way it lands in db: engaged,
// every reading kept. Roblox Kids and Select need 250 (Roblox's goal, read live when it can be) unique plays by
// them in 60 days; 25 keeps a game listed.

import * as S from './stats.js';

export const ENGAGED_GOAL = 250;
export const ENGAGED_KEEP = 25;
const LIVE_FOR = 2 * 3600; // a Creator Hub read older than this isn't "live" any more (the cookie stopped working)

const short = (value) => {
  for (const [size, suffix] of [[1e6, 'M'], [1e3, 'K']]) if (value >= size) return `${+(value / size).toFixed(1)}${suffix}`;
  return String(value);
};

// kind -> steps, title, detail and how big the party is (small: a burst, big: cannons, epic: fireworks)
export const KINDS = {
  sales: {
    label: 'Sales',
    steps: [1, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000],
    title: (value) => (value === 1 ? 'First sale!' : `${short(value)} sales`),
    detail: (value) => (value === 1 ? 'Someone bought something for the first time.' : `${short(value)} purchases, all time.`),
    level: (value) => (value === 1 || value >= 1000 ? 'epic' : value >= 100 ? 'big' : 'small'),
  },
  ccu: {
    label: 'Playing at once',
    steps: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
    title: (value) => `${short(value)} playing at once`,
    detail: (value) => `${short(value)} players in the game at the same time.`,
    level: (value) => (value >= 100 ? (value === 100 || value >= 1000 ? 'epic' : 'big') : 'small'),
  },
  engaged: {
    label: 'Highly engaged players',
    // Steps up to the game's goal, which is Roblox's own when Creator Hub is read (goalOf): only the goal gets
    // fireworks, wherever Roblox puts it
    steps: [25, 50, 100, 150, 200, ENGAGED_GOAL],
    title: (value, goal = ENGAGED_GOAL) => (value === goal ? `${value} highly engaged players!` : `${value} highly engaged players`),
    detail: (value, goal = ENGAGED_GOAL) => (value === goal
      ? `Roblox's Kids and Select evaluation goal: ${goal} unique plays by highly engaged players in 60 days.`
      : value < goal ? `${goal - value} more to Roblox's goal of ${goal}.` : `Past Roblox's goal of ${goal}.`),
    level: (value, goal = ENGAGED_GOAL) => (value === goal ? 'epic' : value >= goal / 2 ? 'big' : 'small'),
  },
  players: {
    label: 'Players',
    steps: [100, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
    title: (value) => `${short(value)} players`,
    detail: (value) => `${short(value)} different people have played, all time.`,
    level: (value) => (value >= 10000 ? 'epic' : value >= 1000 ? 'big' : 'small'),
  },
  robux: {
    label: 'Robux spent',
    steps: [100, 1000, 10000, 100000, 1000000, 10000000],
    title: (value) => `R$ ${short(value)} spent`,
    detail: (value) => `Players have spent R$ ${short(value)} in the game, all time (you keep about 70%).`,
    level: (value) => (value >= 100000 ? 'epic' : value >= 10000 ? 'big' : 'small'),
  },
};
const ORDER = Object.keys(KINDS);

// A game's highly engaged goal: Roblox's own (read live from Creator Hub, audience.js), else 250
export function goalOf(game, db) {
  const goal = db.audienceReach ? db.audienceReach(game.id)?.goal : null;
  return goal > 0 ? goal : ENGAGED_GOAL;
}

// A kind's steps for a game: the engaged ones stop at the game's goal (which is always a step)
function stepsOf(kind, goal) {
  if (kind !== 'engaged') return KINDS[kind].steps;
  return [...new Set([...KINDS.engaged.steps.filter((value) => value < goal), goal])].sort((a, b) => a - b);
}
export const START = '$start'; // saved at a game's first check

// A game's all-time numbers: sums over every day bucket the collector has (new players are each counted on
// their first day only, so their sum is everyone who ever played), the highest peak of players online the game
// recorded (day buckets' "ccu") or the collector sampled, and Roblox's last highly engaged count.
export function gameValues(game, db) {
  let sales = 0, robux = 0, players = 0, peak = 0;
  for (const key of db.dayKeys ? db.dayKeys(game.id) : []) {
    const bucket = db.entry(game.id, key)?.value;
    if (!bucket || typeof bucket !== 'object') continue;
    sales += bucket.c?.purchases || 0;
    robux += bucket.c?.robux || 0;
    players += bucket.c?.new_users || 0;
    if ((bucket.m?.ccu || 0) > peak) peak = bucket.m.ccu;
  }
  const sampled = db.ccuPeak ? db.ccuPeak(game.id) : 0;
  const engaged = db.engaged ? db.engaged(game.id) : null;
  return { sales, robux, players, ccu: Math.max(peak, sampled || 0), engaged: engaged ? engaged.count : 0 };
}

export const milestoneId = (kind, value) => `${kind}:${value}`;

// Checks every game that's reading normally and saves the steps it has newly reached. Returns what's new.
export function trackMilestones(games, db, at = S.now(), isReady = () => true) {
  const added = [];
  for (const game of games) {
    if (!game.universeId || !isReady(game)) continue;
    const reached = new Set(db.milestones(game.id).map((row) => row.id));
    const first = !reached.has(START);
    const values = gameValues(game, db);
    const goal = goalOf(game, db);
    const fresh = [];
    for (const kind of ORDER) {
      for (const value of stepsOf(kind, goal)) {
        if (values[kind] >= value && !reached.has(milestoneId(kind, value))) fresh.push({ kind, value });
      }
    }
    const top = {};
    for (const item of fresh) top[item.kind] = Math.max(top[item.kind] || 0, item.value);
    db.transaction(() => {
      for (const { kind, value } of fresh) {
        // The time it was reached: the first sample at that many players online if there is one, else now
        const when = kind === 'ccu' && db.ccuFirstAtLeast ? db.ccuFirstAtLeast(game.id, value) || at : at;
        const quiet = first || value < top[kind];
        db.addMilestone(game.id, milestoneId(kind, value), kind, value, Math.min(when, at), quiet);
        added.push({ game: game.id, kind, value, quiet });
      }
      if (first) db.addMilestone(game.id, START, START, 0, at, true);
    });
  }
  return added;
}

// One reached milestone, as the site shows it
export function presentMilestone(row, game, goal = ENGAGED_GOAL) {
  const kind = KINDS[row.kind];
  return {
    Key: `${row.game}:${row.id}:${row.at}`,
    Game: row.game, GameName: game?.name || row.game, Slot: game?.slot || 1,
    Kind: row.kind, Value: row.value, At: row.at, Quiet: row.quiet,
    Title: kind.title(row.value, goal), Detail: kind.detail(row.value, goal), Level: kind.level(row.value, goal),
  };
}

// The games' reached milestones, newest first (no first-check markers)
export function reachedOf(games, db) {
  const byId = Object.fromEntries(games.map((game) => [game.id, game]));
  return games
    .flatMap((game) => db.milestones(game.id))
    .filter((row) => row.id !== START && KINDS[row.kind] && byId[row.game])
    .map((row) => presentMilestone(row, byId[row.game], goalOf(byId[row.game], db)))
    .sort((a, b) => b.At - a.At || b.Value - a.Value);
}

// A game's card: what it reached, and the next step of every kind with how far along it is
export function milestonesWidget(game, db) {
  const values = gameValues(game, db);
  const goal = goalOf(game, db);
  const next = ORDER.map((kind) => {
    const step = stepsOf(kind, goal).find((value) => values[kind] < value);
    if (step === undefined) return null;
    return { Kind: kind, Label: KINDS[kind].label, Value: step, Title: KINDS[kind].title(step, goal), Current: values[kind], Level: KINDS[kind].level(step, goal) };
  }).filter(Boolean);
  return { Type: 'Milestones', Game: game.id, Reached: reachedOf([game], db), Next: next };
}

// The big counter of Roblox's highly engaged players for one game
export function engagedEntry(game, db) {
  const history = db.engagedHistory ? db.engagedHistory(game.id) : [];
  const last = history[history.length - 1] || null;
  const roblox = db.robloxMetrics ? db.robloxMetrics(game.id) : null;
  // Read live from Creator Hub (audience.js) when the collector has an account cookie: Roblox's own goal too
  const reach = db.audienceReach ? db.audienceReach(game.id) : null;
  const live = reach && S.now() - reach.at < LIVE_FOR ? reach : null;
  return {
    Game: game.id, GameName: game.name, Slot: game.slot || 1,
    Goal: live?.goal > 0 ? live.goal : ENGAGED_GOAL, Keep: live?.keep > 0 ? live.keep : ENGAGED_KEEP,
    Live: live ? { At: live.at, UpdatedAt: live.updatedAt, Status: live.status, GraceDeadline: live.graceDeadline } : null,
    Count: last ? last.count : null, At: last ? last.t : null,
    History: history.slice(-60).map((row) => ({ T: row.t, Count: row.count })),
    // Roblox's Analytics API: players at its "High" engagement level, 60 days (analytics.js)
    Api: Number.isFinite(roblox?.engagedHigh) ? { High: roblox.engagedHigh, At: roblox.at } : null,
  };
}

export const engagedWidget = (game, db) => ({ Type: 'Engaged', Items: [engagedEntry(game, db)] });

// What the owner sends: { game, count }
export function cleanEngaged(body, games) {
  const game = games.find((item) => item.id === body?.game && item.universeId);
  if (!game) throw new Error('Unknown game.');
  const count = Number(String(body.count ?? '').replace(/[\s,]/g, ''));
  if (!Number.isInteger(count) || count < 0 || count > 10_000_000) throw new Error('Type the number Roblox shows (a whole number).');
  return { game: game.id, count };
}
