// The dashboard and its API, on 127.0.0.1 only. The Mac serves the site itself (siteDir) at
// http://127.0.0.1:8090, so nothing has to be published; a tunnel in front of it is optional. Private:
// - POST /v1/session { secret } trades the admin secret (DASHBOARD_SECRET) for a session token that lasts
//   SESSION_HOURS; the page keeps it in sessionStorage (this tab only) and sends it as a Bearer header.
//   Tokens are signed (expiry + HMAC of it with the secret), so restarts don't sign anyone out and changing
//   the secret signs everyone out. Wrong secrets are rate-limited per address and overall. Nothing secret
//   ever goes in a URL.
// - Every /v1 view needs that token. Responses are never cached by browsers or Cloudflare (no-store), and an
//   unchanged view answers 304 to If-None-Match.
// - CORS allows only the dashboard's own origin(s) (ALLOWED_ORIGINS).
// - GET /health says whether collection works (no numbers), for watchdogs on the Mac itself: requests that
//   came through the tunnel (they carry cf-connecting-ip) get 404.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_HOURS = 12;
const MAX_FAILS = 5; // wrong secrets per address per FAIL_WINDOW
const FAIL_WINDOW = 15 * 60 * 1000;
const MAX_FAILS_TOTAL = 50; // wrong secrets from everyone per FAIL_WINDOW
const MAX_TRACKED = 1000; // addresses remembered
const SITE_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// On the Mac the API is the page's own origin, so this replaces site/config.js (which is for a separately hosted site)
const LOCAL_CONFIG = 'window.STATS_API = location.origin;\n';

// The site's files, read once: only these exact paths are ever served, so a URL can't reach anything else.
function loadSite(siteDir) {
  const files = new Map();
  if (!siteDir) return files;
  const add = (route, file) => files.set(route, { body: fs.readFileSync(file), type: SITE_TYPES[path.extname(file)] });
  add('/', path.join(siteDir, 'index.html'));
  add('/index.html', path.join(siteDir, 'index.html'));
  const assets = path.join(siteDir, 'assets');
  for (const name of fs.readdirSync(assets)) if (SITE_TYPES[path.extname(name)]) add(`/assets/${name}`, path.join(assets, name));
  files.set('/config.js', { body: Buffer.from(LOCAL_CONFIG), type: SITE_TYPES['.js'] });
  return files;
}

export function createServer({ secret, allowedOrigins, getView, health, log, siteDir }) {
  const site = loadSite(siteDir);
  const fails = new Map(); // address -> [times]
  let allFails = []; // times, everyone
  const secretHash = crypto.createHash('sha256').update(secret).digest();
  const sign = (expires) => crypto.createHmac('sha256', secret).update(`session:${expires}`).digest('base64url');

  const addressOf = (request) => String(request.headers['cf-connecting-ip'] || request.socket.remoteAddress || '');

  function tooManyFails(address) {
    const now = Date.now();
    allFails = allFails.filter((time) => now - time < FAIL_WINDOW);
    const recent = (fails.get(address) || []).filter((time) => now - time < FAIL_WINDOW);
    fails.set(address, recent);
    return recent.length >= MAX_FAILS || allFails.length >= MAX_FAILS_TOTAL;
  }

  function recordFail(address) {
    allFails.push(Date.now());
    fails.get(address)?.push(Date.now());
    if (fails.size > MAX_TRACKED) for (const key of [...fails.keys()].slice(0, fails.size - MAX_TRACKED)) fails.delete(key);
  }

  function checkSecret(given) {
    const hash = crypto.createHash('sha256').update(String(given || '')).digest();
    return crypto.timingSafeEqual(hash, secretHash);
  }

  function authorized(request) {
    const match = /^Bearer (\d+)\.([\w-]+)$/.exec(request.headers.authorization || '');
    if (!match || Number(match[1]) < Date.now()) return false;
    const expected = Buffer.from(sign(match[1]));
    const given = Buffer.from(match[2]);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
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
          // Chrome's Private Network Access: the public site may call this private (Tailscale 100.x) address
          ...(request.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
        });
      }
      const page = request.method === 'GET' ? site.get(url.pathname) : undefined;
      if (page) {
        response.writeHead(200, { 'Content-Type': page.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
        return response.end(page.body);
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        if (request.headers['cf-connecting-ip']) return send(response, 404, { error: 'not found' });
        const state = health();
        return send(response, state.ok ? 200 : 503, state, cors);
      }
      if (origin && !cors['Access-Control-Allow-Origin']) return send(response, 403, { error: 'origin' });
      if (url.pathname === '/v1/session' && request.method === 'POST') {
        const address = addressOf(request);
        if (tooManyFails(address)) return send(response, 429, { error: 'Too many tries. Wait 15 minutes.' }, cors);
        let body;
        try {
          body = await readBody(request);
        } catch {
          return send(response, 400, { error: 'Bad request.' }, cors);
        }
        if (!checkSecret(body?.secret)) {
          recordFail(address);
          log(`wrong dashboard secret from ${address}`);
          return send(response, 401, { error: 'Wrong secret.' }, cors);
        }
        const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
        return send(response, 200, { token: `${expires}.${sign(String(expires))}`, expires }, cors);
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
