// Checks the Open Cloud key against every game in games.local.json (or games.json): can it list and read the
// stats DataStore, and read the live servers (MemoryStore)? Says which permission is missing. Never prints
// the key.   node scripts/check.js
// Exits 0 when every configured game can be read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvValue, loadGames } from '../src/main.js';
import { createClient } from '../src/opencloud.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = parseEnvValue(match[2]);
  }
}
const key = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
if (!key) {
  console.error('No ROBLOX_OPEN_CLOUD_API_KEY in collector/.env.');
  process.exit(1);
}
const local = path.join(ROOT, 'games.local.json');
const games = loadGames(process.env.GAMES_FILE || (fs.existsSync(local) ? local : path.join(ROOT, 'games.json')));
const client = createClient(key);

const HINTS = {
  401: 'the key is wrong or expired',
  403: 'the key lacks this permission for this game (Creator Dashboard -> Open Cloud -> API Keys -> the key -> add the game with the permission below), or its IP list leaves out this network',
};
const why = (error) => `${error.message}${HINTS[error.status] ? ` (${HINTS[error.status]})` : ''}`;

let failed = 0;
for (const game of games) {
  if (!game.universeId) {
    console.log(`- ${game.name}: not set up (no universeId), skipped`);
    continue;
  }
  const lines = [];
  const step = async (label, permission, run) => {
    try {
      const result = await run();
      lines.push(`    ok    ${label}${result ? `: ${result}` : ''}`);
    } catch (error) {
      failed++;
      lines.push(`    FAIL  ${label}: ${why(error)}\n          needs: ${permission}`);
    }
  };
  await step(`list keys in ${game.store}`, 'DataStores: List Entry Keys (universe-datastores.objects:list)', async () => {
    const keys = await client.listKeys(game.universeId, game.store, 'D');
    return keys.length ? `${keys.length} day buckets` : 'no day buckets yet (does the game record stats? is the store name right?)';
  });
  await step(`read ${game.store}`, 'DataStores: Read Entry (universe-datastores.objects:read)', async () => {
    const defs = await client.getEntry(game.universeId, game.store, 'FunnelDefs');
    return defs ? `funnel list of version ${defs.Version}` : 'no funnel list yet (written when a game server starts with the stats)';
  });
  await step(`read live servers (${game.liveMap})`, 'Memory Stores: Read sorted map (memory-store.sorted-map:read)', async () => {
    const items = await client.sortedMapItems(game.universeId, game.liveMap);
    return `${items.filter((item) => String(item.id).startsWith('s:')).length} servers running`;
  });
  if (game.feedback) {
    await step(`read feedback (${game.feedback.store})`, 'DataStores: Read Entry (universe-datastores.objects:read)', async () => {
      const meta = await client.getEntry(game.universeId, game.feedback.store, 'Meta');
      return `${meta?.Count ?? meta?.count ?? 0} entries`;
    });
  }
  console.log(`- ${game.name} (universe ${game.universeId}):\n${lines.join('\n')}`);
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nEverything the collector needs can be read.');
process.exitCode = failed ? 1 : 0;
