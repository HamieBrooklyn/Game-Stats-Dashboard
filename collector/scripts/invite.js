// Makes an invite link from the Mac: the first one for yourself (--owner), or for someone else.
//   node scripts/invite.js --owner              your own: you see every game and get the People page
//   node scripts/invite.js [--note "Alex"]      someone else: they see the games their Roblox account shares
// Each link works once and expires in 7 days. Needs PUBLIC_URL in collector/.env (the dashboard's address).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvValue, loadGames } from '../src/main.js';
import { openDatabase } from '../src/db.js';
import { createAuth } from '../src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = parseEnvValue(match[2]);
  }
}
if (!process.env.PUBLIC_URL) {
  console.error('Set PUBLIC_URL in collector/.env first (e.g. https://stats.pokepon.org).');
  process.exit(1);
}
const args = process.argv.slice(2);
const noteAt = args.indexOf('--note');
const local = path.join(ROOT, 'games.local.json');
const games = loadGames(fs.existsSync(local) ? local : path.join(ROOT, 'games.json'));
const db = openDatabase(path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'stats.db'));
const auth = createAuth({ db, games, secret: process.env.DASHBOARD_SECRET || 'x'.repeat(24), oauth: { publicUrl: process.env.PUBLIC_URL } });
const invite = auth.createInvite({ role: args.includes('--owner') ? 'owner' : 'member', note: noteAt >= 0 ? args[noteAt + 1] : args.includes('--owner') ? 'Owner' : '' });
db.close();
console.log(invite.link);
console.log(`Works once, until ${new Date(invite.expiresAt * 1000).toUTCString()}.`);
