// Who may see what. Two ways in:
// - Sign in with Roblox (OAuth 2.0 + PKCE). Only people with an invite (a single-use link the owner makes) or who
//   are already members get in. At each sign-in Roblox's consent screen asks which of their experiences to share,
//   and lists only ones their account can access; the member then sees the dashboard's games among those. The
//   Roblox token is used once (who they are, which experiences) and then revoked: nothing of it is kept.
// - The dashboard secret (DASHBOARD_SECRET): the owner's own key, for this Mac and as a fallback.
// Sessions are signed tokens (expiry + who, HMAC'd with the secret), sent as an HttpOnly cookie (Roblox sign-in)
// or a Bearer header (secret). Members are looked up on every request, so removing someone works at once.

import crypto from 'node:crypto';

const SECRET_SESSION_HOURS = 12;
const ROBLOX_SESSION_DAYS = 7;
const INVITE_DAYS = 7;
const LOGIN_TTL = 10 * 60 * 1000; // a sign-in has 10 minutes to come back from Roblox
const MAX_PENDING = 500;
const OWNER = 'owner'; // the session id of the secret

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const random = (size) => b64url(crypto.randomBytes(size));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('base64url');

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

// Requests through the tunnel arrive as http from cloudflared, but the visitor used https
const isHttps = (request) => /"scheme":"https"/.test(String(request.headers['cf-visitor'] || '')) || request.headers['x-forwarded-proto'] === 'https';

function cookie(name, value, { maxAge, path = '/', secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// options: { db, games, secret, oauth: { clientId, clientSecret, publicUrl, scopes, base }, log, now }
export function createAuth({ db, games, secret, oauth = {}, log = () => {}, now = () => Date.now() }) {
  const sign = (payload) => crypto.createHmac('sha256', secret).update(`session:${payload}`).digest('base64url');
  const robloxReady = Boolean(oauth.clientId && oauth.clientSecret && oauth.publicUrl);
  const apis = (oauth.base || 'https://apis.roblox.com').replace(/\/$/, '');
  const redirectUri = robloxReady ? `${oauth.publicUrl.replace(/\/$/, '')}/auth/callback` : '';
  const scopes = oauth.scopes || 'openid profile universe.user-restriction:read';
  const pending = new Map(); // state -> { verifier, invite, at }

  function issue(who, hours) {
    const expires = now() + hours * 3600 * 1000;
    const payload = `${expires}.${who}`;
    return { token: `${payload}.${sign(payload)}`, expires };
  }

  // The session's owner, or null. who: "owner" (the secret) or a Roblox user id.
  function verify(token) {
    const match = /^(\d+)\.(owner|\d+)\.([\w-]+)$/.exec(String(token || ''));
    if (!match || Number(match[1]) < now()) return null;
    const expected = Buffer.from(sign(`${match[1]}.${match[2]}`));
    const given = Buffer.from(match[3]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return match[2];
  }

  // { id, role, name, games: null (every game) or [ids] }, or null when not signed in
  function principal(request) {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization || '');
    const who = verify(bearer ? bearer[1] : parseCookies(request.headers.cookie).gs_session);
    if (!who) return null;
    if (who === OWNER) return { id: OWNER, role: 'owner', name: 'Owner (secret)', games: null };
    const member = db.member(who);
    if (!member) return null; // removed since
    return {
      id: member.id, role: member.role, name: member.displayName || member.username || member.id, username: member.username,
      games: member.role === 'owner' ? null : member.games.filter((id) => games.some((game) => game.id === id)),
    };
  }

  function checkSecret(given) {
    const a = crypto.createHash('sha256').update(String(given || '')).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // --- Invites ---
  function createInvite({ role = 'member', note = '', days = INVITE_DAYS } = {}) {
    if (!['member', 'owner'].includes(role)) throw new Error('bad role');
    const code = random(24);
    const at = Math.floor(now() / 1000);
    const id = db.addInvite(sha256(code), role, String(note).slice(0, 120), at, at + Math.round(days * 86400));
    const base = (oauth.publicUrl || '').replace(/\/$/, '');
    return { id, code, link: `${base}/?invite=${code}`, expiresAt: at + Math.round(days * 86400) };
  }

  function inviteState(row, at) {
    if (row.revoked) return 'revoked';
    if (row.used_by) return 'used';
    if (row.expires_at < at) return 'expired';
    return 'open';
  }

  function people() {
    const at = Math.floor(now() / 1000);
    const names = Object.fromEntries(games.map((game) => [game.id, game.name]));
    const members = db.members();
    const nameOf = Object.fromEntries(members.map((member) => [member.id, member.displayName || member.username || member.id]));
    return {
      members: members.map((member) => ({
        id: member.id, username: member.username, displayName: member.displayName, role: member.role,
        games: member.role === 'owner' ? ['Every game'] : member.games.map((id) => names[id]).filter(Boolean),
        createdAt: member.createdAt, lastLogin: member.lastLogin,
      })),
      invites: db.invites().map((row) => ({
        id: row.id, role: row.role, note: row.note, createdAt: row.created_at, expiresAt: row.expires_at,
        state: inviteState(row, at), usedBy: row.used_by ? nameOf[row.used_by] || row.used_by : null,
      })),
    };
  }

  function removeMember(id, by) {
    const member = db.member(id);
    if (!member) return false;
    if (member.role === 'owner' && db.ownerCount() <= 1 && by !== OWNER) throw new Error("You can't remove the last owner.");
    return db.removeMember(id);
  }

  // --- Sign in with Roblox ---
  function startLogin(request, invite) {
    if (!robloxReady) return { location: '/?auth_error=not_configured' };
    for (const [state, entry] of pending) if (now() - entry.at > LOGIN_TTL) pending.delete(state);
    if (pending.size >= MAX_PENDING) return { location: '/?auth_error=busy' };
    const state = random(24);
    const verifier = random(32);
    pending.set(state, { verifier, invite: typeof invite === 'string' && invite.length <= 64 ? invite : '', at: now() });
    const query = new URLSearchParams({
      client_id: oauth.clientId, redirect_uri: redirectUri, scope: scopes, response_type: 'code',
      // Roblox requires the account picker for apps with experience scopes; consent lets them re-pick their games
      prompt: 'select_account consent',
      state, code_challenge: sha256(verifier), code_challenge_method: 'S256',
    });
    return {
      location: `${apis}/oauth/v1/authorize?${query}`,
      // ties the sign-in to this browser, so nobody can finish it with a link
      cookies: [cookie('gs_login', state, { maxAge: LOGIN_TTL / 1000, path: '/auth', secure: isHttps(request) })],
    };
  }

  async function post(path, fields) {
    const response = await fetch(`${apis}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: oauth.clientId, client_secret: oauth.clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  // Back from Roblox: who is it, which experiences did they share, may they come in
  async function finishLogin(request, url) {
    const secure = isHttps(request);
    const clear = cookie('gs_login', '', { maxAge: 0, path: '/auth', secure });
    const fail = (code) => ({ location: `/?auth_error=${code}`, cookies: [clear] });
    const state = url.searchParams.get('state') || '';
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || now() - entry.at > LOGIN_TTL || parseCookies(request.headers.cookie).gs_login !== state) return fail('expired');
    if (url.searchParams.get('error')) return fail('denied');
    const code = url.searchParams.get('code');
    if (!code) return fail('denied');

    let tokens;
    try {
      tokens = await post('/oauth/v1/token', { grant_type: 'authorization_code', code, code_verifier: entry.verifier });
      const userinfo = await (await fetch(`${apis}/oauth/v1/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000) })).json();
      const resources = await post('/oauth/v1/token/resources', { token: tokens.access_token });
      const universes = new Set();
      for (const info of resources.resource_infos || []) for (const id of info.resources?.universe?.ids || []) universes.add(String(id));
      const userId = String(userinfo.sub || '');
      if (!/^\d+$/.test(userId)) throw new Error('no user id from Roblox');
      const shared = games.filter((game) => game.universeId && universes.has(String(game.universeId))).map((game) => game.id);
      const result = admit({ id: userId, username: userinfo.preferred_username, displayName: userinfo.name || userinfo.nickname }, shared, entry.invite);
      if (result.error) return fail(result.error);
      const session = issue(userId, ROBLOX_SESSION_DAYS * 24);
      log(`signed in with Roblox: ${userinfo.preferred_username || userId} (${result.member.role}, ${shared.length} game${shared.length === 1 ? '' : 's'} shared)`);
      return {
        location: '/',
        cookies: [clear, cookie('gs_session', session.token, { maxAge: ROBLOX_SESSION_DAYS * 86400, secure })],
      };
    } catch (error) {
      log(`Roblox sign-in failed: ${error.message}`);
      return fail('failed');
    } finally {
      // Nothing of Roblox's tokens is kept: revoking the refresh token ends the grant
      if (tokens?.refresh_token) await post('/oauth/v1/token/revoke', { token: tokens.refresh_token }).catch((error) => log(`revoking Roblox's token failed: ${error.message}`));
    }
  }

  // A member signs in again (their games refresh), or an invite makes them one
  function admit(user, shared, invite) {
    const at = Math.floor(now() / 1000);
    return db.transaction(() => {
      const existing = db.member(user.id);
      if (existing) {
        const member = { ...existing, ...user, games: shared };
        db.putMember(member, at);
        return { member };
      }
      if (!invite) return { error: 'no_invite' };
      const row = db.inviteByHash(sha256(invite));
      if (!row) return { error: 'no_invite' };
      const state = inviteState(row, at);
      if (state !== 'open') return { error: `invite_${state}` };
      if (!db.useInvite(row.id, user.id, at)) return { error: 'invite_used' };
      const member = { ...user, role: row.role, games: shared };
      db.putMember(member, at);
      return { member };
    });
  }

  return {
    robloxReady, redirectUri, OWNER,
    principal, checkSecret, issue,
    ownerSession: () => issue(OWNER, SECRET_SESSION_HOURS),
    sessionCookie: (request, token, hours) => cookie('gs_session', token, { maxAge: hours * 3600, secure: isHttps(request) }),
    signOutCookie: (request) => cookie('gs_session', '', { maxAge: 0, secure: isHttps(request) }),
    startLogin, finishLogin, admit,
    createInvite, people, removeMember, revokeInvite: (id) => db.revokeInvite(Number(id)),
  };
}
