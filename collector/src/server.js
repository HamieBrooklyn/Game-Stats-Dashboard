// The dashboard and its API, on 127.0.0.1 only. The Mac serves the site itself (siteDir); the Cloudflare tunnel
// publishes it at the public address. Who sees what is auth.js's job:
// - GET /auth/roblox?invite=.. and /auth/callback: Sign in with Roblox (invites, games from Roblox's consent).
// - POST /v1/session { secret }: the owner's secret, swapped for a 12-hour session token (Bearer). Wrong secrets
//   are rate-limited per address and overall. Nothing secret ever goes in a URL except a single-use invite.
// - Every /v1 view needs a session and only shows that person's games (getView gets who is asking).
//   Responses are never cached by browsers or Cloudflare (no-store); an unchanged view answers 304.
// - /v1/admin/*: the owner's People page (invites, members).
// - CORS allows only the dashboard's own origin(s) (ALLOWED_ORIGINS).
// - GET /health says whether collection works (no numbers), for watchdogs on the Mac itself: requests that
//   came through the tunnel (they carry cf-connecting-ip) get 404.

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createAuth } from './auth.js';
import path from 'node:path';

const MAX_FAILS = 5; // wrong secrets per address per FAIL_WINDOW
const FAIL_WINDOW = 15 * 60 * 1000;
const MAX_FAILS_TOTAL = 50; // wrong secrets from everyone per FAIL_WINDOW
const MAX_TRACKED = 1000; // addresses remembered
const SITE_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webm': 'video/webm' };
// Pages beside the dashboard (for the Roblox OAuth app's listing): /privacy, /terms, /demo.webm
const EXTRA_PAGES = { '/privacy': 'privacy.html', '/terms': 'terms.html', '/demo.webm': 'demo.webm' };
// On the Mac the API is the page's own origin, so this replaces site/config.js (which is for a separately hosted site)
const LOCAL_CONFIG = 'window.STATS_API = location.origin;\n';

// The site's files, read once: only these exact paths are ever served, so a URL can't reach anything else.
// The pages load their code from /assets-<version>/ (version: a hash of every asset), so an update always
// reaches browsers: Cloudflare tells browsers to keep .js and .css for hours whatever the Mac says, and a new
// path is never in anyone's cache. (Modules import each other relatively, so they stay in the same version.)
function loadSite(siteDir) {
  const files = new Map();
  if (!siteDir) return files;
  const assets = path.join(siteDir, 'assets');
  const names = fs.readdirSync(assets).filter((name) => SITE_TYPES[path.extname(name)]).sort();
  const hash = crypto.createHash('sha1');
  for (const name of names) hash.update(name).update(fs.readFileSync(path.join(assets, name)));
  const version = hash.digest('hex').slice(0, 10);
  const html = (file) => Buffer.from(fs.readFileSync(file, 'utf8').replace(/(["'])assets\//g, `$1assets-${version}/`));
  const add = (route, file, extra = {}) => files.set(route, { body: path.extname(file) === '.html' ? html(file) : fs.readFileSync(file), type: SITE_TYPES[path.extname(file)], ...extra });
  add('/', path.join(siteDir, 'index.html'));
  add('/index.html', path.join(siteDir, 'index.html'));
  for (const name of names) {
    add(`/assets/${name}`, path.join(assets, name));
    add(`/assets-${version}/${name}`, path.join(assets, name), { immutable: true });
  }
  for (const [route, name] of Object.entries(EXTRA_PAGES)) if (fs.existsSync(path.join(siteDir, name))) add(route, path.join(siteDir, name));
  files.set('/config.js', { body: Buffer.from(LOCAL_CONFIG), type: SITE_TYPES['.js'] });
  files.version = version;
  return files;
}

// auth: createAuth(...) (auth.js). getView(pathname, params, principal) answers a view for that person or null.
// (Given only `secret`, it's the secret alone, with no Roblox sign-in: for tests and the demo.)
export function createServer({ auth, secret, allowedOrigins, getView, health, log, siteDir }) {
  auth = auth || createAuth({ db: { member: () => undefined }, games: [], secret });
  const site = loadSite(siteDir);
  const fails = new Map(); // address -> [times]
  let allFails = []; // times, everyone

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

  function send(response, status, body, headers = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  }

  function redirect(response, { location, cookies = [] }) {
    response.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
    response.end();
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
      const page = request.method === 'GET' || request.method === 'HEAD' ? site.get(url.pathname) : undefined;
      if (page) {
        response.writeHead(200, { 'Content-Type': page.type, 'Cache-Control': page.immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
        return response.end(request.method === 'HEAD' ? undefined : page.body);
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        if (request.headers['cf-connecting-ip']) return send(response, 404, { error: 'not found' });
        const state = health();
        return send(response, state.ok ? 200 : 503, state, cors);
      }
      if (origin && !cors['Access-Control-Allow-Origin']) return send(response, 403, { error: 'origin' });
      if (url.pathname === '/auth/options' && request.method === 'GET') return send(response, 200, { roblox: auth.robloxReady }, cors);
      if (url.pathname === '/auth/roblox' && request.method === 'GET') {
        const next = auth.startLogin(request, url.searchParams.get('invite'));
        return redirect(response, next);
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        const address = addressOf(request);
        if (tooManyFails(address)) return redirect(response, { location: '/?auth_error=busy' });
        const next = await auth.finishLogin(request, url);
        if (/auth_error=(no_invite|invite_|expired)/.test(next.location)) recordFail(address);
        return redirect(response, next);
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        return send(response, 200, { ok: true }, { ...cors, 'Set-Cookie': auth.signOutCookie(request) });
      }
      if (url.pathname === '/v1/session' && request.method === 'POST') {
        const address = addressOf(request);
        if (tooManyFails(address)) return send(response, 429, { error: 'Too many tries. Wait 15 minutes.' }, cors);
        let body;
        try {
          body = await readBody(request);
        } catch {
          return send(response, 400, { error: 'Bad request.' }, cors);
        }
        if (!auth.checkSecret(body?.secret)) {
          recordFail(address);
          log(`wrong dashboard secret from ${address}`);
          return send(response, 401, { error: 'Wrong secret.' }, cors);
        }
        return send(response, 200, auth.ownerSession(), cors);
      }
      if (!url.pathname.startsWith('/v1/')) return send(response, 404, { error: 'not found' }, cors);
      const who = auth.principal(request);
      if (!who) return send(response, 401, { error: 'Sign in again.' }, cors);
      if (url.pathname === '/v1/me' && request.method === 'GET') {
        return send(response, 200, { id: who.id, name: who.name, username: who.username || null, role: who.role, games: who.games, roblox: auth.robloxReady }, cors);
      }
      if (url.pathname.startsWith('/v1/admin/')) {
        if (who.role !== 'owner') return send(response, 403, { error: 'Only the owner can do that.' }, cors);
        if (url.pathname === '/v1/admin/people' && request.method === 'GET') return send(response, 200, auth.people(), cors);
        if (request.method !== 'POST' || !/^application\/json/.test(request.headers['content-type'] || '')) return send(response, 404, { error: 'not found' }, cors);
        let body;
        try {
          body = await readBody(request);
        } catch {
          return send(response, 400, { error: 'Bad request.' }, cors);
        }
        try {
          if (url.pathname === '/v1/admin/invites') {
            if (!auth.robloxReady) return send(response, 409, { error: 'Set up Sign in with Roblox first (README).' }, cors);
            const invite = auth.createInvite({ note: body.note, days: Math.min(Math.max(Number(body.days) || 7, 1), 30) });
            log(`invite ${invite.id} made by ${who.name}`);
            return send(response, 200, { id: invite.id, link: invite.link, expiresAt: invite.expiresAt }, cors);
          }
          if (url.pathname === '/v1/admin/invites/revoke') return send(response, 200, { ok: auth.revokeInvite(body.id) }, cors);
          if (url.pathname === '/v1/admin/members/remove') {
            if (String(body.id) === String(who.id)) return send(response, 400, { error: "You can't remove yourself." }, cors);
            const ok = auth.removeMember(body.id, who.id);
            log(`member ${body.id} removed by ${who.name}`);
            return send(response, 200, { ok }, cors);
          }
        } catch (error) {
          return send(response, 400, { error: error.message }, cors);
        }
        return send(response, 404, { error: 'not found' }, cors);
      }
      if (request.method !== 'GET') return send(response, 404, { error: 'not found' }, cors);
      const view = getView(url.pathname, url.searchParams, who);
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
