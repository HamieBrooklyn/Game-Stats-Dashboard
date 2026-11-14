// Roblox's highly engaged players, live: the same call Creator Hub's "Manage audience" page makes
// (GET apis.roblox.com/core-content/v2/universe/{id}/audience-reach), every 15 minutes. Roblox updates the count
// hourly. Its answer has highlyEngagedPlayers: { status, engagedPlayersCount, updatedAt, thresholdTrigger (the
// goal), thresholdReset (what keeps a game in), graceDeadline }.
//
// It's not a public API: it only takes a signed-in Roblox account's cookie (ROBLOX_CREATOR_COOKIE in
// collector/.env), not an Open Cloud key, and Roblox can change it without notice. The cookie only ever goes to
// apis.roblox.com and is never logged. Best: a second Roblox account that can only see the games, not the
// owner's own. Without the cookie, or when it stops working, the counter falls back to the number copied in.

import * as S from './stats.js';

const API = process.env.CREATOR_HUB_BASE || 'https://apis.roblox.com';
const EVERY = 15 * 60 * 1000;
const FIRST_DELAY = 10 * 1000;
const TIMEOUT_MS = 20000;
const KEEP_EVERY = 6 * 3600; // an unchanged count is saved again this often, so the history shows it held

// The parts of the answer the dashboard uses, or null when it has none
export function parseAudienceReach(body) {
  const hep = body?.highlyEngagedPlayers;
  if (!hep || !Number.isFinite(Number(hep.engagedPlayersCount))) return null;
  const number = (value) => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);
  const time = (value) => (value ? Math.floor(Date.parse(value) / 1000) || null : null);
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

export function createAudienceClient(cookie, { base = API, fetchImpl = fetch } = {}) {
  return {
    async audienceReach(universeId) {
      const response = await fetchImpl(`${base}/core-content/v2/universe/${encodeURIComponent(universeId)}/audience-reach`, {
        headers: { Cookie: `.ROBLOSECURITY=${cookie}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try { message = JSON.parse(text).errors?.[0]?.message || text; } catch {}
        const error = new Error(`${response.status} ${String(message).slice(0, 160)}`);
        error.status = response.status;
        throw error;
      }
      return parseAudienceReach(JSON.parse(text));
    },
  };
}

// Reads every game and saves what Roblox says (db: audience_reach), and the count into the engaged history
// when it changed (or every KEEP_EVERY), so the counter, its trend and the milestones use it like a copy.
// A game Roblox answers without a count (not in evaluation, say) is left as it was.
export function createAudience({ games, db, log, onChange, client }) {
  let timer = null, running = false, refused = false;

  async function refresh() {
    if (running || !client) return;
    running = true;
    let changed = false;
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
