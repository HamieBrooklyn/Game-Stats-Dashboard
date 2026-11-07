// The collector's SQLite file (node:sqlite, WAL, one writer: this process). It mirrors the games' DataStore keys
// (which stay the real record) and keeps what can't be read back later: the online-player samples taken every
// 15 s, and when each source last worked. Backed up daily (VACUUM INTO), 7 kept.

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
    CREATE TABLE IF NOT EXISTS sources (
      game TEXT NOT NULL, source TEXT NOT NULL, ok_at INTEGER, error TEXT, error_at INTEGER,
      PRIMARY KEY (game, source)
    );
  `);

  const statements = {
    getEntry: db.prepare('SELECT value, fetched_at, final FROM entries WHERE game = ? AND key = ?'),
    putEntry: db.prepare(`INSERT INTO entries (game, key, value, fetched_at, final) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (game, key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at, final = excluded.final`),
    addCcu: db.prepare('INSERT INTO ccu (game, t, players, servers) VALUES (?, ?, ?, ?)'),
    ccuSince: db.prepare('SELECT game, t, players FROM ccu WHERE t >= ? ORDER BY t'),
    pruneCcu: db.prepare('DELETE FROM ccu WHERE t < ?'),
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
  };

  // In-memory copy of parsed entries, so views don't parse JSON on every build
  const parsed = new Map();

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
