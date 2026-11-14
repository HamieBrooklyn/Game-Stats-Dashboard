// The collector's SQLite file (node:sqlite, WAL, one writer: this process). It mirrors the games' DataStore keys
// (which stay the real record) and keeps what can't be read back later: the online-player samples taken every
// 15 s, the sales feed (what each read of an hour bucket added, poller.js), and when each source last worked. Backed up daily (VACUUM INTO), 7 kept.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS entries (
      game TEXT NOT NULL, key TEXT NOT NULL, value TEXT, fetched_at INTEGER NOT NULL, final INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game, key)
    );
    CREATE TABLE IF NOT EXISTS ccu (game TEXT NOT NULL, t INTEGER NOT NULL, players INTEGER NOT NULL, servers INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ccu_game_t ON ccu (game, t);
    CREATE INDEX IF NOT EXISTS ccu_t ON ccu (t);
    CREATE TABLE IF NOT EXISTS feedback (game TEXT NOT NULL, id INTEGER NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (game, id));
    CREATE INDEX IF NOT EXISTS feedback_at ON feedback (at);
    -- Sales seen between two reads of an hour bucket: count of item, for robux in all, bought between t_from and t_to
    CREATE TABLE IF NOT EXISTS sales (
      game TEXT NOT NULL, t_from INTEGER NOT NULL, t_to INTEGER NOT NULL, item TEXT NOT NULL, count INTEGER NOT NULL, robux INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sales_t ON sales (t_to);
    CREATE TABLE IF NOT EXISTS sources (
      game TEXT NOT NULL, source TEXT NOT NULL, ok_at INTEGER, error TEXT, error_at INTEGER,
      PRIMARY KEY (game, source)
    );
    -- People who can sign in with Roblox (auth.js). games: the game ids their Roblox account shared at their last
    -- sign-in (JSON). Invites are stored as hashes; a link works once.
    CREATE TABLE IF NOT EXISTS members (
      user_id TEXT PRIMARY KEY, username TEXT, display_name TEXT, role TEXT NOT NULL, games TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, note TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
    );
    -- Roblox's benchmarks (50th/90th percentiles and Roblox's own numbers) the owner copied in, per game (JSON;
    -- benchmarks.js). Only Roblox can count them, so they can't be read back from anywhere: backed up with the rest.
    CREATE TABLE IF NOT EXISTS benchmarks (game TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    -- Other games in our games' Roblox genres (peers.js), and ours (own = 1): their genre and their last sample
    CREATE TABLE IF NOT EXISTS peers (
      universe INTEGER PRIMARY KEY, name TEXT, genre1 TEXT, genre2 TEXT, own INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, playing INTEGER, found_at INTEGER, last_t INTEGER, last_playing INTEGER, last_visits INTEGER
    );
    -- Per game and hour: player-seconds, new visits and seconds covered by samples (average session = ps / dv)
    CREATE TABLE IF NOT EXISTS peer_hours (
      universe INTEGER NOT NULL, hour INTEGER NOT NULL, ps REAL NOT NULL, dv INTEGER NOT NULL, cov INTEGER NOT NULL,
      PRIMARY KEY (universe, hour)
    );
  `);

  const statements = {
    getEntry: db.prepare('SELECT value, fetched_at, final FROM entries WHERE game = ? AND key = ?'),
    putEntry: db.prepare(`INSERT INTO entries (game, key, value, fetched_at, final) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (game, key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at, final = excluded.final`),
    addCcu: db.prepare('INSERT INTO ccu (game, t, players, servers) VALUES (?, ?, ?, ?)'),
    ccuSince: db.prepare('SELECT game, t, players FROM ccu WHERE t >= ? ORDER BY t'),
    pruneCcu: db.prepare('DELETE FROM ccu WHERE t < ?'),
    addSale: db.prepare('INSERT INTO sales (game, t_from, t_to, item, count, robux) VALUES (?, ?, ?, ?, ?, ?)'),
    salesSince: db.prepare('SELECT game, t_from, t_to, item, count, robux FROM sales WHERE t_to >= ? ORDER BY t_to DESC, rowid DESC LIMIT ?'),
    pruneSales: db.prepare('DELETE FROM sales WHERE t_to < ?'),
    putFeedback: db.prepare(`INSERT INTO feedback (game, id, value, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (game, id) DO UPDATE SET value = excluded.value, at = excluded.at`),
    feedback: db.prepare('SELECT game, value FROM feedback ORDER BY at DESC LIMIT 2000'),
    feedbackIds: db.prepare('SELECT id FROM feedback WHERE game = ? AND id BETWEEN ? AND ?'),
    deleteFeedback: db.prepare('DELETE FROM feedback WHERE game = ? AND id = ?'),
    ok: db.prepare(`INSERT INTO sources (game, source, ok_at) VALUES (?, ?, ?)
      ON CONFLICT (game, source) DO UPDATE SET ok_at = excluded.ok_at`),
    fail: db.prepare(`INSERT INTO sources (game, source, error, error_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (game, source) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`),
    sources: db.prepare('SELECT game, source, ok_at, error, error_at FROM sources'),
    member: db.prepare('SELECT * FROM members WHERE user_id = ?'),
    members: db.prepare('SELECT * FROM members ORDER BY created_at'),
    putMember: db.prepare(`INSERT INTO members (user_id, username, display_name, role, games, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, games = excluded.games, last_login = excluded.last_login`),
    removeMember: db.prepare('DELETE FROM members WHERE user_id = ?'),
    owners: db.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'owner'"),
    addInvite: db.prepare('INSERT INTO invites (code_hash, role, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    inviteByHash: db.prepare('SELECT * FROM invites WHERE code_hash = ?'),
    useInvite: db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL AND revoked = 0'),
    revokeInvite: db.prepare('UPDATE invites SET revoked = 1 WHERE id = ? AND used_by IS NULL'),
    invites: db.prepare('SELECT id, role, note, created_at, expires_at, used_by, used_at, revoked FROM invites ORDER BY id DESC LIMIT 200'),
    benchmarks: db.prepare('SELECT value, updated_at FROM benchmarks WHERE game = ?'),
    putBenchmarks: db.prepare(`INSERT INTO benchmarks (game, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (game) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
    putPeer: db.prepare(`INSERT INTO peers (universe, name, genre1, genre2, own, active, playing, found_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (universe) DO UPDATE SET name = excluded.name, genre1 = excluded.genre1, genre2 = excluded.genre2,
        own = max(own, excluded.own), active = 1, playing = excluded.playing, found_at = excluded.found_at`),
    peer: db.prepare('SELECT name, genre1, genre2, own, last_t, last_playing, last_visits FROM peers WHERE universe = ?'),
    activePeers: db.prepare('SELECT universe FROM peers WHERE own = 0 AND active = 1'),
    trimPeers: db.prepare(`UPDATE peers SET active = 0 WHERE own = 0 AND genre1 = ? AND genre2 = ? AND universe NOT IN
      (SELECT universe FROM peers WHERE own = 0 AND genre1 = ? AND genre2 = ? AND active = 1 ORDER BY playing DESC LIMIT ?)`),
    peerLast: db.prepare('UPDATE peers SET last_t = ?, last_playing = ?, last_visits = ?, playing = ?, name = coalesce(?, name), genre1 = coalesce(?, genre1), genre2 = coalesce(?, genre2) WHERE universe = ?'),
    addPeerHour: db.prepare(`INSERT INTO peer_hours (universe, hour, ps, dv, cov) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (universe, hour) DO UPDATE SET ps = ps + excluded.ps, dv = dv + excluded.dv, cov = cov + excluded.cov`),
    peerHours: db.prepare(`SELECT h.universe, SUM(h.ps) AS ps, SUM(h.dv) AS dv, SUM(h.cov) AS cov FROM peer_hours h JOIN peers p ON p.universe = h.universe
      WHERE p.own = 0 AND p.genre1 = ? AND p.genre2 = ? AND h.hour >= ? GROUP BY h.universe`),
    prunePeerHours: db.prepare('DELETE FROM peer_hours WHERE hour < ?'),
    lastDiscovery: db.prepare('SELECT max(found_at) AS at FROM peers WHERE own = 0'),
  };
  const memberOf = (row) => row && { id: row.user_id, username: row.username, displayName: row.display_name, role: row.role, games: JSON.parse(row.games), createdAt: row.created_at, lastLogin: row.last_login };

  // In-memory copy of parsed entries, so views don't parse JSON on every build
  const parsed = new Map();
  let peerVersion = 0;
  const peerCache = new Map();

  return {
    db,
    entry(game, key) {
      const cacheKey = `${game}\u0000${key}`;
      if (parsed.has(cacheKey)) return parsed.get(cacheKey);
      const row = statements.getEntry.get(game, key);
      const result = row ? { value: row.value === null ? null : JSON.parse(row.value), fetchedAt: row.fetched_at, final: row.final === 1 } : undefined;
      parsed.set(cacheKey, result);
      return result;
    },
    putEntry(game, key, value, fetchedAt, final) {
      statements.putEntry.run(game, key, value === null ? null : JSON.stringify(value), fetchedAt, final ? 1 : 0);
      parsed.set(`${game}\u0000${key}`, { value, fetchedAt, final });
    },
    addCcu(game, t, players, servers) {
      statements.addCcu.run(game, t, players, servers);
    },
    ccuSince(t) {
      return statements.ccuSince.all(t);
    },
    pruneCcu(before) {
      statements.pruneCcu.run(before);
    },
    addSale(game, from, to, item, count, robux) {
      statements.addSale.run(game, from, to, item, count, robux);
    },
    // Newest first
    salesSince(t, limit = 2000) {
      return statements.salesSince.all(t, limit).map((row) => ({ game: row.game, from: row.t_from, to: row.t_to, item: row.item, count: row.count, robux: row.robux }));
    },
    pruneSales(before) {
      statements.pruneSales.run(before);
    },
    putFeedback(game, entry) {
      statements.putFeedback.run(game, entry.Id, JSON.stringify(entry), entry.At || 0);
    },
    // Keeps exactly the entries a page holds now (deleted ones go): ids from..to are that page's
    replaceFeedbackPage(game, from, to, entries) {
      const keep = new Set(entries.map((entry) => entry.Id));
      for (const row of statements.feedbackIds.all(game, from, to)) if (!keep.has(row.id)) statements.deleteFeedback.run(game, row.id);
      for (const entry of entries) statements.putFeedback.run(game, entry.Id, JSON.stringify(entry), entry.At || 0);
    },
    feedback() {
      return statements.feedback.all().map((row) => ({ game: row.game, entry: JSON.parse(row.value) }));
    },
    sourceOk(game, source, t) {
      statements.ok.run(game, source, t);
    },
    sourceFailed(game, source, error, t) {
      statements.fail.run(game, source, String(error).slice(0, 300), t);
    },
    sources() {
      return statements.sources.all();
    },
    member(userId) {
      return memberOf(statements.member.get(String(userId)));
    },
    members() {
      return statements.members.all().map(memberOf);
    },
    putMember(member, at) {
      statements.putMember.run(String(member.id), member.username || null, member.displayName || null, member.role, JSON.stringify(member.games || []), at, at);
    },
    removeMember(userId) {
      return statements.removeMember.run(String(userId)).changes > 0;
    },
    ownerCount() {
      return statements.owners.get().n;
    },
    addInvite(codeHash, role, note, at, expiresAt) {
      return Number(statements.addInvite.run(codeHash, role, note || null, at, expiresAt).lastInsertRowid);
    },
    inviteByHash(codeHash) {
      return statements.inviteByHash.get(codeHash);
    },
    // Marks it used by this person; false when someone used or revoked it first
    useInvite(id, userId, at) {
      return statements.useInvite.run(String(userId), at, id).changes > 0;
    },
    revokeInvite(id) {
      return statements.revokeInvite.run(id).changes > 0;
    },
    invites() {
      return statements.invites.all();
    },
    // { basis, metrics, at } or null
    benchmarks(game) {
      const row = statements.benchmarks.get(game);
      return row ? { ...JSON.parse(row.value), at: row.updated_at } : null;
    },
    putBenchmarks(game, value, at) {
      statements.putBenchmarks.run(game, JSON.stringify(value), at);
    },
    // Genre peers (peers.js)
    putPeer({ universe, name, l1, l2, own, playing }, at) {
      statements.putPeer.run(universe, name || null, l1 || null, l2 || null, own ? 1 : 0, playing || 0, at);
    },
    // { name, l1, l2, own } or null
    peer(universe) {
      const row = statements.peer.get(universe);
      return row ? { name: row.name, l1: row.genre1, l2: row.genre2, own: row.own === 1 } : null;
    },
    activePeers() {
      return statements.activePeers.all().map((row) => row.universe);
    },
    trimPeers(genre, max) {
      statements.trimPeers.run(genre.l1, genre.l2, genre.l1, genre.l2, max);
    },
    // The last sample of a game: { t, playing, visits } or null
    peerLast(universe) {
      const row = statements.peer.get(universe);
      return row && row.last_t ? { t: row.last_t, playing: row.last_playing, visits: row.last_visits } : null;
    },
    // A sample: it becomes the game's last one, and what it adds goes to its hour
    putPeerSample(universe, last, add, hour, genre = {}) {
      statements.peerLast.run(last.t, last.playing, last.visits, last.playing, null, genre.l1 || null, genre.l2 || null, universe);
      if (add) {
        statements.addPeerHour.run(universe, hour, add.ps, add.dv, add.cov);
        peerVersion++;
      }
    },
    // Per game of the genre since `fromHour`: { universe, ps, dv, cov } (cached until a sample lands)
    peerHours(genre, fromHour) {
      const key = `${genre.l1}\u0000${genre.l2}\u0000${fromHour}\u0000${peerVersion}`;
      if (!peerCache.has(key)) {
        if (peerCache.size > 50) peerCache.clear();
        peerCache.set(key, statements.peerHours.all(genre.l1, genre.l2, fromHour));
      }
      return peerCache.get(key);
    },
    // When genre games were last found (0 if never)
    lastDiscovery() {
      return statements.lastDiscovery.get().at || 0;
    },
    prunePeerHours(beforeHour) {
      statements.prunePeerHours.run(beforeHour);
      peerVersion++;
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    backup(dir, keep = 7) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `stats-${new Date().toISOString().slice(0, 10)}.db`);
      if (fs.existsSync(file)) return;
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const old = fs.readdirSync(dir).filter((name) => /^stats-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort();
      for (const name of old.slice(0, Math.max(old.length - keep, 0))) fs.rmSync(path.join(dir, name));
    },
    close() {
      db.close();
    },
  };
}
