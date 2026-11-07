// Read-only Roblox Open Cloud client: DataStore entries (v1) and MemoryStore sorted maps (v2). Every request has
// a timeout; 429 and 5xx back off (honouring Retry-After) and a game's requests run at most CONCURRENCY at a time.

const API = process.env.OPEN_CLOUD_BASE || 'https://apis.roblox.com';
const TIMEOUT_MS = 15000;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

export class OpenCloudError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A tiny per-key semaphore, so one slow game can't use every connection
const queues = new Map();
async function limited(key, task) {
  let queue = queues.get(key);
  if (!queue) {
    queue = { active: 0, waiting: [] };
    queues.set(key, queue);
  }
  if (queue.active >= CONCURRENCY) await new Promise((resolve) => queue.waiting.push(resolve));
  queue.active++;
  try {
    return await task();
  } finally {
    queue.active--;
    queue.waiting.shift()?.();
  }
}

export function createClient(apiKey, { onRequest } = {}) {
  async function request(universeId, path) {
    return limited(universeId, async () => {
      for (let attempt = 1; ; attempt++) {
        onRequest?.(universeId);
        let response;
        try {
          response = await fetch(`${API}${path}`, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS) throw new OpenCloudError(`network: ${error.message}`, 0);
          await sleep(1000 * 2 ** attempt + Math.random() * 500);
          continue;
        }
        if (response.status === 404) return null;
        if (response.ok) return response.json();
        const body = await response.text().catch(() => '');
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep((retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt) + Math.random() * 500);
          continue;
        }
        let message = body;
        try {
          const json = JSON.parse(body);
          message = json.message || json.error || body;
        } catch {}
        throw new OpenCloudError(`${response.status} ${String(message).slice(0, 200)}`, response.status);
      }
    });
  }

  return {
    // One DataStore entry's value, or null when the key doesn't exist
    getEntry(universeId, datastore, key) {
      const params = new URLSearchParams({ datastoreName: datastore, entryKey: key });
      return request(universeId, `/datastores/v1/universes/${universeId}/standard-datastores/datastore/entries/entry?${params}`);
    },
    // Every key starting with `prefix` (paged)
    async listKeys(universeId, datastore, prefix) {
      const keys = [];
      let cursor = '';
      do {
        const params = new URLSearchParams({ datastoreName: datastore, prefix, limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const page = await request(universeId, `/datastores/v1/universes/${universeId}/standard-datastores/datastore/entries?${params}`);
        for (const entry of page?.keys || []) keys.push(entry.key);
        cursor = page?.nextPageCursor || '';
      } while (cursor);
      return keys;
    },
    // Every item of a MemoryStore sorted map: [{ id, value }] (paged, 100 at a time)
    async sortedMapItems(universeId, map) {
      const items = [];
      let token = '';
      do {
        const params = new URLSearchParams({ maxPageSize: '100' });
        if (token) params.set('pageToken', token);
        const page = await request(universeId, `/cloud/v2/universes/${universeId}/memory-store/sorted-maps/${encodeURIComponent(map)}/items?${params}`);
        for (const item of page?.memoryStoreSortedMapItems || []) items.push({ id: item.id, value: item.value });
        token = page?.nextPageToken || '';
      } while (token);
      return items;
    },
  };
}
