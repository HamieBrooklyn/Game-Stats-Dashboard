// Sign in with Roblox, invites and per-person views (src/auth.js, server.js, views.viewGate), against a fake
// Roblox that checks PKCE, single-use codes and client credentials the way the real one does.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../src/db.js';
import { createAuth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { viewGate } from '../src/views.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const GAMES = [
  { id: 'cars', name: 'Cars', universeId: 111 },
  { id: 'farm', name: 'Farm', universeId: 222 },
  { id: 'soon', name: 'Soon', universeId: null },
];

// A fake Roblox: /authorize is followed by the test itself (it's the user's browser)
function fakeRoblox() {
  const codes = new Map(); // code -> { challenge, user, universes }
  const tokens = new Map(); // access token -> { user, universes }
  const revoked = [];
  let next = null; // who signs in next and what they share
  const form = async (request) => Object.fromEntries(new URLSearchParams(await new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk)).on('end', () => resolve(body));
  })));
  const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/oauth/v1/token' && request.method === 'POST') {
      const body = await form(request);
      if (body.client_id !== 'cid' || body.client_secret !== 'csecret') return json(response, 401, { error: 'invalid_client' });
      const entry = codes.get(body.code);
      codes.delete(body.code); // single use
      if (!entry) return json(response, 400, { error: 'invalid_grant' });
      const challenge = crypto.createHash('sha256').update(body.code_verifier || '').digest('base64url');
      if (challenge !== entry.challenge) return json(response, 400, { error: 'invalid_grant', detail: 'pkce' });
      const access = crypto.randomBytes(8).toString('hex');
      tokens.set(access, entry);
      return json(response, 200, { access_token: access, refresh_token: `r-${access}`, token_type: 'Bearer', expires_in: 899, scope: 'openid profile' });
    }
    if (url.pathname === '/oauth/v1/userinfo') {
      const entry = tokens.get((request.headers.authorization || '').replace('Bearer ', ''));
      if (!entry) return json(response, 401, {});
      return json(response, 200, { sub: entry.user.id, name: entry.user.name, nickname: entry.user.name, preferred_username: entry.user.username });
    }
    if (url.pathname === '/oauth/v1/token/resources' && request.method === 'POST') {
      const body = await form(request);
      const entry = tokens.get(body.token);
      if (!entry || body.client_secret !== 'csecret') return json(response, 401, {});
      return json(response, 200, { resource_infos: [{ owner: { id: entry.user.id, type: 'User' }, resources: { universe: { ids: entry.universes.map(String) }, creator: { ids: ['U'] } } }] });
    }
    if (url.pathname === '/oauth/v1/token/revoke' && request.method === 'POST') {
      revoked.push((await form(request)).token);
      return json(response, 200, {});
    }
    json(response, 404, {});
  });
  return {
    server, revoked,
    as(user, universes) { next = { user, universes }; },
    // What the user's browser does at Roblox: approve, and Roblox sends it back with a code
    approve(authorizeUrl) {
      const url = new URL(authorizeUrl);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('prompt'), 'select_account consent', 'Roblox requires the account picker');
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), ...next });
      return { code, state: url.searchParams.get('state'), redirect: url.searchParams.get('redirect_uri') };
    },
  };
}

async function setup(t) {
  const roblox = fakeRoblox();
  const apis = await listen(roblox.server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  const auth = createAuth({ db, games: GAMES, secret: 'a-long-enough-secret-for-tests-123', oauth: { clientId: 'cid', clientSecret: 'csecret', publicUrl: 'https://stats.example', base: apis } });
  const views = (ids) => new Map([
    ['/v1/overview?range=7d', { json: JSON.stringify({ games: ids }), etag: `"${ids.join()}"` }],
    ['/v1/feedback', { json: JSON.stringify({ games: ids }), etag: `"f${ids.join()}"` }],
    ...GAMES.map((game) => [`/v1/games/${game.id}/overview?range=7d`, { json: JSON.stringify({ game: game.id }), etag: `"${game.id}"` }]),
  ]);
  const all = views(GAMES.map((game) => game.id));
  const server = createServer({ auth, allowedOrigins: ['https://stats.example'], getView: viewGate(() => all, (ids) => views(ids)), health: () => ({ ok: true }), log: () => {} });
  const base = await listen(server);
  t.after(() => { server.close(); roblox.server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // A browser: keeps cookies, follows our redirects to Roblox by hand
  const browser = () => {
    const jar = {};
    const cookieHeader = () => Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
    const take = (response) => {
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const [name, value] = pair.split('=');
        if (attrs.some((attr) => /max-age=0/i.test(attr))) delete jar[name.trim()];
        else jar[name.trim()] = value;
      }
    };
    return {
      jar,
      async get(pathname, headers = {}) {
        const response = await fetch(`${base}${pathname}`, { headers: { cookie: cookieHeader(), ...headers }, redirect: 'manual' });
        take(response);
        return response;
      },
      async post(pathname, body) {
        const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: { cookie: cookieHeader(), 'Content-Type': 'application/json', Origin: 'https://stats.example' }, body: JSON.stringify(body) });
        take(response);
        return response;
      },
      // The whole round trip; returns where the dashboard sent the browser at the end
      async signIn(invite) {
        const start = await this.get(`/auth/roblox${invite ? `?invite=${invite}` : ''}`);
        assert.equal(start.status, 302);
        const back = roblox.approve(start.headers.get('location'));
        assert.equal(back.redirect, 'https://stats.example/auth/callback');
        const done = await this.get(`/auth/callback?code=${back.code}&state=${back.state}`);
        return done.headers.get('location');
      },
    };
  };
  return { roblox, auth, db, base, browser };
}

test('an invite makes a member who sees only the games Roblox says they can access', async (t) => {
  const { roblox, auth, browser } = await setup(t);
  const invite = auth.createInvite({ note: 'Alex' });
  assert.match(invite.link, /^https:\/\/stats\.example\/\?invite=[\w-]{32}$/);

  const alex = browser();
  roblox.as({ id: '42', username: 'alex', name: 'Alex' }, [222, 999]); // farm, and a game the dashboard doesn't have
  assert.equal(await alex.signIn(invite.code), '/');
  assert.ok(alex.jar.gs_session, 'signed in');
  assert.ok(!alex.jar.gs_login, 'the sign-in cookie is cleared');
  assert.ok(roblox.revoked.length === 1, "Roblox's token is revoked, not kept");

  const me = await (await alex.get('/v1/me')).json();
  assert.deepEqual([me.role, me.games, me.name], ['member', ['farm'], 'Alex']);
  assert.equal((await alex.get('/v1/games/farm/overview?range=7d')).status, 200);
  assert.equal((await alex.get('/v1/games/cars/overview?range=7d')).status, 404, "not their game");
  assert.deepEqual((await (await alex.get('/v1/overview?range=7d')).json()).games, ['farm'], 'totals only from their games');
  assert.deepEqual((await (await alex.get('/v1/feedback')).json()).games, ['farm'], 'feedback only from their games');
  assert.equal((await alex.get('/v1/admin/people')).status, 403, 'not the owner');
  assert.equal((await alex.post('/v1/admin/invites', {})).status, 403);

  // The invite was single use
  const someoneElse = browser();
  roblox.as({ id: '43', username: 'eve', name: 'Eve' }, [111]);
  assert.equal(await someoneElse.signIn(invite.code), '/?auth_error=invite_used');
  assert.ok(!someoneElse.jar.gs_session);
});

test('without an invite nobody gets in, even with access to the games', async (t) => {
  const { roblox, browser } = await setup(t);
  const stranger = browser();
  roblox.as({ id: '7', username: 'stranger', name: 'S' }, [111, 222]);
  assert.equal(await stranger.signIn(), '/?auth_error=no_invite');
  assert.equal(await stranger.signIn('made-up-code'), '/?auth_error=no_invite');
  assert.equal((await stranger.get('/v1/me')).status, 401);
});

test('a member signing in again gets their games refreshed; removing them ends their session', async (t) => {
  const { roblox, auth, browser } = await setup(t);
  const owner = browser();
  roblox.as({ id: '1', username: 'hamie', name: 'Hamie' }, []);
  assert.equal(await owner.signIn(auth.createInvite({ role: 'owner' }).code), '/');
  const ownerMe = await (await owner.get('/v1/me')).json();
  assert.deepEqual([ownerMe.role, ownerMe.games], ['owner', null], 'the owner sees every game');

  const made = await (await owner.post('/v1/admin/invites', { note: 'Sam' })).json();
  const sam = browser();
  roblox.as({ id: '9', username: 'sam', name: 'Sam' }, [111]);
  await sam.signIn(new URL(made.link).searchParams.get('invite'));
  assert.deepEqual((await (await sam.get('/v1/me')).json()).games, ['cars']);
  roblox.as({ id: '9', username: 'sam', name: 'Sam' }, [111, 222]); // given another game on Roblox
  assert.equal(await sam.signIn(), '/', 'members need no new invite');
  assert.deepEqual((await (await sam.get('/v1/me')).json()).games, ['cars', 'farm']);

  const people = await (await owner.get('/v1/admin/people')).json();
  assert.deepEqual(people.members.map((member) => [member.username, member.role]), [['hamie', 'owner'], ['sam', 'member']]);
  assert.deepEqual(people.invites.map((invite) => invite.state), ['used', 'used']);
  assert.equal((await owner.post('/v1/admin/members/remove', { id: '1' })).status, 400, "can't remove yourself");
  assert.equal((await owner.post('/v1/admin/members/remove', { id: '9' })).status, 200);
  assert.equal((await sam.get('/v1/me')).status, 401, 'removed: out at once');
});

test('sign-in is bound to the browser that started it, and revoked or expired invites fail', async (t) => {
  const { roblox, auth, db, browser, base } = await setup(t);
  const victim = browser();
  const start = await victim.get('/auth/roblox');
  roblox.as({ id: '5', username: 'mallory', name: 'M' }, [111]);
  const back = roblox.approve(start.headers.get('location'));
  // Someone else's browser (no gs_login cookie) can't finish it
  const other = await fetch(`${base}/auth/callback?code=${back.code}&state=${back.state}`, { redirect: 'manual' });
  assert.equal(other.headers.get('location'), '/?auth_error=expired');
  // And the state is used up
  assert.equal((await victim.get(`/auth/callback?code=${back.code}&state=${back.state}`)).headers.get('location'), '/?auth_error=expired');
  // A user who says no at Roblox
  const denied = await victim.get('/auth/roblox');
  const state = new URL(denied.headers.get('location')).searchParams.get('state');
  assert.equal((await victim.get(`/auth/callback?error=access_denied&state=${state}`)).headers.get('location'), '/?auth_error=denied');

  const revoked = auth.createInvite();
  auth.revokeInvite(revoked.id);
  roblox.as({ id: '6', username: 'x', name: 'X' }, [111]);
  assert.equal(await browser().signIn(revoked.code), '/?auth_error=invite_revoked');
  const old = auth.createInvite();
  db.db.prepare('UPDATE invites SET expires_at = 1 WHERE id = ?').run(old.id);
  assert.equal(await browser().signIn(old.code), '/?auth_error=invite_expired');
});

test('the secret still signs the owner in, and Roblox sign-in is off until it is configured', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  const db = openDatabase(path.join(dir, 'stats.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const auth = createAuth({ db, games: GAMES, secret: 'a-long-enough-secret-for-tests-123' });
  assert.equal(auth.robloxReady, false);
  assert.equal(auth.startLogin({ headers: {} }).location, '/?auth_error=not_configured');
  const { token } = auth.ownerSession();
  assert.deepEqual(auth.principal({ headers: { authorization: `Bearer ${token}` } }), { id: 'owner', role: 'owner', name: 'Owner (secret)', games: null });
  // A forged member token (right shape, wrong signature) is nobody
  assert.equal(auth.principal({ headers: { cookie: `gs_session=${Date.now() + 1e6}.42.${'A'.repeat(43)}` } }), null);
});
