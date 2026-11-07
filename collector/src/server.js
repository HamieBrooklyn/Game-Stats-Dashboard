// The dashboard's API, on 127.0.0.1 only (Cloudflare Tunnel publishes it). Private:
// - POST /v1/session { secret } trades the admin secret (DASHBOARD_SECRET) for a session token that lasts
//   SESSION_HOURS; the page keeps it in sessionStorage (this tab only) and sends it as a Bearer header.
//   Wrong secrets are rate-limited per address. Nothing secret ever goes in a URL.
// - Every /v1 view needs that token. Responses are never cached by browsers or Cloudflare (no-store), and an
//   unchanged view answers 304 to If-None-Match.
// - CORS allows only the dashboard's own origin(s) (ALLOWED_ORIGINS).
// - GET /health says whether collection works (no numbers), for watchdogs.

import http from 'node:http';
import crypto from 'node:crypto';

const SESSION_HOURS = 12;
const MAX_FAILS = 5; // wrong secrets per address per FAIL_WINDOW
const FAIL_WINDOW = 15 * 60 * 1000;

export function createServer({ secret, allowedOrigins, getView, health, log }) {
  const sessions = new Map(); // token -> expires (ms)
  const fails = new Map(); // address -> [times]
  const secretHash = crypto.createHash('sha256').update(secret).digest();

  const addressOf = (request) => String(request.headers['cf-connecting-ip'] || request.socket.remoteAddress || '');

  function tooManyFails(address) {
    const recent = (fails.get(address) || []).filter((time) => Date.now() - time < FAIL_WINDOW);
    fails.set(address, recent);
    return recent.length >= MAX_FAILS;
  }

  function checkSecret(given) {
    const hash = crypto.createHash('sha256').update(String(given || '')).digest();
    return crypto.timingSafeEqual(hash, secretHash);
  }

  function authorized(request) {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization || '');
    if (!match) return false;
    const expires = sessions.get(match[1]);
    if (!expires || expires < Date.now()) {
      sessions.delete(match[1]);
      return false;
    }
    return true;
  }

  function send(response, status, body, headers = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function readBody(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) throw new Error('too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const cors = {};
    if (origin && allowedOrigins.includes(origin)) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Vary'] = 'Origin';
    }
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'OPTIONS') {
        if (!cors['Access-Control-Allow-Origin']) return send(response, 403, { error: 'origin' });
        return send(response, 204, undefined, {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
          'Access-Control-Max-Age': '600',
        });
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        const state = health();
        return send(response, state.ok ? 200 : 503, state, cors);
      }
      if (origin && !cors['Access-Control-Allow-Origin']) return send(response, 403, { error: 'origin' });
      if (url.pathname === '/v1/session' && request.method === 'POST') {
        const address = addressOf(request);
        if (tooManyFails(address)) return send(response, 429, { error: 'Too many tries. Wait 15 minutes.' }, cors);
        const body = await readBody(request);
        if (!checkSecret(body.secret)) {
          fails.get(address).push(Date.now());
          log(`wrong dashboard secret from ${address}`);
          return send(response, 401, { error: 'Wrong secret.' }, cors);
        }
        const token = crypto.randomBytes(32).toString('base64url');
        const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
        sessions.set(token, expires);
        for (const [key, value] of sessions) if (value < Date.now()) sessions.delete(key);
        return send(response, 200, { token, expires }, cors);
      }
      if (!url.pathname.startsWith('/v1/') || request.method !== 'GET') return send(response, 404, { error: 'not found' }, cors);
      if (!authorized(request)) return send(response, 401, { error: 'Sign in again.' }, cors);
      const view = getView(url.pathname, url.searchParams);
      if (!view) return send(response, 404, { error: 'not found' }, cors);
      if (request.headers['if-none-match'] === view.etag) return send(response, 304, undefined, { ...cors, ETag: view.etag });
      return send(response, 200, view.json, { ...cors, ETag: view.etag, 'Access-Control-Expose-Headers': 'ETag' });
    } catch (error) {
      log(`request ${url.pathname} failed: ${error.stack || error}`);
      return send(response, 500, { error: 'server error' }, cors);
    }
  });
  return server;
}
