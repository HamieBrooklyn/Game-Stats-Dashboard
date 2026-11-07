// Game Stats: pages, the API client (sign-in, ETags, polling) and the shell (game picker, range, theme).
// Everything shown comes from the collector (collector/), which mirrors each game's Spotlight Admin stats.

import { format, h, timeAgo, utcTime } from './format.js';
import { lineChart, sparkline } from './charts.js';
import { renderWidgets, card } from './widgets.js';

const API = String(window.STATS_API || '').replace(/\/$/, '');
const PAGES = { overview: 'Overview', funnels: 'Funnels', live: 'Live', feedback: 'Feedback' };
const REFRESH = { overview: 60, funnels: 60, live: 15, feedback: 120 }; // seconds
const MAX_GAME_LINES = 3; // game lines on one chart (more stop being tellable apart)

const state = {
  page: 'overview',
  game: 'all',
  range: localStorage.getItem('range') || '7d',
  games: [], // from the all-games overview
  shownGames: new Set(), // game lines added to the online chart
  feedbackFilter: { sentiment: '', status: '', search: '' },
};

const content = document.getElementById('content');
const gameSelect = document.getElementById('game');
const rangeGroup = document.getElementById('range');
const asOf = document.getElementById('as-of');
const connection = document.getElementById('connection');

// --- API: a session token (this tab only), ETags so unchanged views aren't sent again ---
const cache = new Map(); // path -> { etag, data }
let signingIn = null;

function signIn() {
  if (signingIn) return signingIn;
  const dialog = document.getElementById('sign-in');
  const form = document.getElementById('sign-in-form');
  const input = document.getElementById('secret');
  const error = document.getElementById('sign-in-error');
  signingIn = new Promise((resolve) => {
    const submit = async (event) => {
      event.preventDefault();
      error.hidden = true;
      try {
        const response = await fetch(`${API}/v1/session`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: input.value }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Sign-in failed (${response.status})`);
        sessionStorage.setItem('session', body.token);
        input.value = '';
        form.removeEventListener('submit', submit);
        dialog.close();
        signingIn = null;
        resolve();
      } catch (failure) {
        error.textContent = failure.message === 'Failed to fetch' ? "Can't reach the collector. Is the Mac on?" : failure.message;
        error.hidden = false;
      }
    };
    form.addEventListener('submit', submit);
    dialog.addEventListener('cancel', (event) => event.preventDefault()); // nothing works without signing in
    dialog.showModal();
    input.focus();
  });
  return signingIn;
}

async function api(path) {
  const cached = cache.get(path);
  const headers = { Authorization: `Bearer ${sessionStorage.getItem('session') || ''}` };
  if (cached) headers['If-None-Match'] = cached.etag;
  let response;
  try {
    response = await fetch(`${API}${path}`, { headers, cache: 'no-store' });
  } catch {
    setConnection('error', "Can't reach the collector");
    throw new Error("Can't reach the collector. Is the Mac on and the tunnel running?");
  }
  if (response.status === 401) {
    sessionStorage.removeItem('session');
    await signIn();
    return api(path);
  }
  if (response.status === 304 && cached) return { data: cached.data, changed: false };
  if (!response.ok) throw new Error(`The collector answered ${response.status}.`);
  const data = await response.json();
  cache.set(path, { etag: response.headers.get('ETag'), data });
  setConnection('ok', 'Connected');
  return { data, changed: true };
}

function setConnection(kind, text) {
  connection.replaceChildren(h('span', { class: `dot ${kind}` }), text);
}

// --- Shell ---
function readHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  state.page = PAGES[path] ? path : 'overview';
  state.game = params.get('game') || 'all';
}

function go(page, game = state.game) {
  const query = game && game !== 'all' ? `?game=${encodeURIComponent(game)}` : '';
  location.hash = `#/${page}${query}`;
}

function syncShell() {
  document.getElementById('page-title').textContent = PAGES[state.page];
  for (const link of document.querySelectorAll('.nav-item[data-page]')) {
    const page = link.dataset.page;
    link.href = `#/${page}${state.game !== 'all' ? `?game=${encodeURIComponent(state.game)}` : ''}`;
    if (page === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  rangeGroup.hidden = state.page === 'live' || state.page === 'feedback';
  for (const button of rangeGroup.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.range === state.range));
  const options = [h('option', { value: 'all' }, 'All games'), ...state.games.map((game) => h('option', { value: game.id }, game.name))];
  gameSelect.replaceChildren(...options);
  gameSelect.value = state.games.some((game) => game.id === state.game) ? state.game : 'all';
}

const gameColor = (game) => `var(--game-${game.slot || 1})`;
const gameById = (id) => state.games.find((game) => game.id === id);

function statusBadge(status) {
  return h('span', { class: 'status', title: status.detail || '' }, h('span', { class: `dot ${status.state}` }), status.label);
}

function setAsOf(at) {
  asOf.replaceChildren(at ? `As of ${utcTime(at)}` : '');
  asOf.title = at ? `Built ${timeAgo(at)}. Days and hours are UTC, like the in-game panel.` : '';
}

// Puts nodes on the page (null ones skipped: replaceChildren would print "null")
function show(...nodes) {
  content.replaceChildren(...nodes.flat().filter((node) => node !== null && node !== undefined && node !== false));
}

function message(text, tone = '') {
  return h('div', { class: 'card empty' }, h('p', { class: `note ${tone}`, style: 'font-size:13px' }, text));
}

function skeleton() {
  return [h('div', { class: 'skeleton', style: 'height:86px' }), h('div', { class: 'skeleton', style: 'height:240px' })];
}

// --- Pages ---
async function overviewAll(quiet) {
  const { data, changed } = await api(`/v1/overview?range=${state.range}`);
  if (quiet && !changed) return;
  state.games = data.games;
  syncShell();
  setAsOf(data.at);
  const k = data.kpis;
  const rangeLabel = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' }[state.range];
  const tiles = h('div', { class: 'tiles' }, [
    ['Playing now', k.online, 'int', 'Every server of every game, right now'],
    ['Players', k.playersSummed, 'int', 'Each game counts its players once; a person in two games counts twice'],
    ['New players', k.newPlayers, 'int'],
    ['Avg session', k.avgSession, 'dur'],
    ['Robux spent', k.robux, 'robux', 'Robux players spent (you keep about 70%)'],
    ['Payer conversion', k.conversion, 'pct', 'Paying player-days ÷ player-days'],
    ['D1 retention', k.d1, 'pct', 'New players back the next day, of the days old enough to know'],
  ].map(([label, value, kind, hint]) => h('div', { class: 'tile', title: hint || '' },
    h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, format(value, kind)),
    h('div', { class: 'tile-foot' }, label === 'Players' ? 'summed across games' : label === 'Playing now' ? 'live' : rangeLabel))));
  const coverage = data.coverage.reporting < data.coverage.total
    ? h('p', { class: 'note' }, `${data.coverage.reporting} of ${data.coverage.total} games are reporting; totals only include those.`)
    : null;
  show(tiles, coverage, onlineCard(data.online), gamesTable(data.games));
}

// Players online over 24 hours: the total, plus up to MAX_GAME_LINES games picked with the chips
function onlineCard(online) {
  const host = h('div');
  const chips = h('div', { class: 'filters', style: 'margin-bottom:8px' });
  const draw = () => {
    const series = [{ name: 'All games', values: online.total, color: 'var(--primary)' }];
    for (const entry of online.series) {
      const game = state.games.find((item) => item.name === entry.Name);
      if (game && state.shownGames.has(game.id)) series.push({ name: entry.Name, values: entry.Values, color: gameColor(game) });
    }
    chips.replaceChildren(...online.series.map((entry) => {
      const game = state.games.find((item) => item.name === entry.Name);
      if (!game) return null;
      const on = state.shownGames.has(game.id);
      return h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(on),
        disabled: !on && state.shownGames.size >= MAX_GAME_LINES ? true : null,
        onclick: () => { on ? state.shownGames.delete(game.id) : state.shownGames.add(game.id); draw(); },
      }, h('span', { class: 'game-dot', style: `background:${gameColor(game)}` }), game.name);
    }));
    host.replaceChildren(lineChart(series, { labels: online.labels, format: 'int', title: 'Players online' }));
  };
  draw();
  const hasSamples = online.total.some((value) => value !== null);
  return card(null,
    h('h3', { class: 'card-title' }, 'Players online', h('span', { class: 'meta' }, '5-minute averages, last 24 h, UTC · gaps = collector was off')),
    hasSamples ? [chips, host] : h('p', { class: 'note' }, 'No samples yet: the collector takes one every 15 seconds.'));
}

function gamesTable(games) {
  const rows = games.map((game) => h('tr', {
    class: game.status.state === 'unconfigured' ? '' : 'row-link',
    tabindex: game.status.state === 'unconfigured' ? null : '0',
    onclick: () => game.status.state !== 'unconfigured' && go('overview', game.id),
    onkeydown: (event) => { if (event.key === 'Enter' && game.status.state !== 'unconfigured') go('overview', game.id); },
  },
  h('td', {}, h('span', { style: 'display:inline-flex;align-items:center;gap:8px' }, h('span', { class: 'game-dot', style: `background:${gameColor(game)}` }), game.name)),
  h('td', {}, statusBadge(game.status)),
  h('td', { class: 'n' }, format(game.online, 'int')),
  h('td', { class: 'n' }, format(game.players, 'int')),
  h('td', { class: 'n' }, format(game.newPlayers, 'int')),
  h('td', { class: 'n' }, format(game.avgSession, 'dur')),
  h('td', { class: 'n' }, format(game.robux, 'robux')),
  h('td', { class: 'n' }, format(game.d1, 'pct')),
  h('td', {}, game.spark.length > 1 ? sparkline(game.spark, gameColor(game)) : '')));
  return card('Games', h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Game', 'Status', 'Online', 'Players', 'New', 'Avg session', 'Robux', 'D1', 'Trend'].map((name, index) => h('th', { class: index >= 2 && index <= 7 ? 'n' : '' }, name)))),
    h('tbody', {}, rows))));
}

async function gamePage(tab, withRange, quiet) {
  const game = gameById(state.game);
  const path = `/v1/games/${encodeURIComponent(state.game)}/${tab}${withRange ? `?range=${state.range}` : ''}`;
  const { data, changed } = await api(path);
  if (quiet && !changed) return;
  setAsOf(data.at);
  const head = h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
    h('span', { class: 'game-dot', style: `background:${gameColor(game || { slot: 1 })}` }),
    h('strong', {}, data.game.name), statusBadge(data.status),
    data.status.state !== 'ok' ? h('span', { class: 'note' }, data.status.detail) : null);
  const body = h('div', { style: 'display:grid;gap:16px' });
  renderWidgets(data.widgets, body);
  show(head, body);
}

function pickGame(page) {
  const ready = state.games.filter((game) => game.status.state !== 'unconfigured' && game.status.state !== 'empty');
  show(card('Pick a game', h('p', { class: 'note', style: 'margin-bottom:10px' }, `${PAGES[page]} are per game.`),
    ready.length
      ? h('div', { class: 'filters' }, ready.map((game) => h('button', { class: 'chip', type: 'button', onclick: () => go(page, game.id) },
        h('span', { class: 'game-dot', style: `background:${gameColor(game)}` }), game.name)))
      : h('p', { class: 'note' }, 'No game is reporting stats yet.')));
}

async function liveAll(quiet) {
  const { data, changed } = await api(`/v1/overview?range=24h`);
  if (quiet && !changed) return;
  state.games = data.games;
  syncShell();
  setAsOf(data.at);
  const rows = data.games.filter((game) => game.status.state !== 'unconfigured');
  show(
    h('div', { class: 'tiles' }, [
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Playing now'), h('div', { class: 'tile-value' }, format(data.kpis.online, 'int')), h('div', { class: 'tile-foot' }, 'all games')),
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Servers'), h('div', { class: 'tile-value' }, format(rows.reduce((sum, game) => sum + (game.servers || 0), 0), 'int')), h('div', { class: 'tile-foot' }, 'running now')),
    ]),
    onlineCard(data.online),
    card('Right now', h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Game', 'Status', 'Online', 'Servers'].map((name, index) => h('th', { class: index >= 2 ? 'n' : '' }, name)))),
      h('tbody', {}, rows.map((game) => h('tr', { class: 'row-link', tabindex: '0', onclick: () => go('live', game.id), onkeydown: (event) => event.key === 'Enter' && go('live', game.id) },
        h('td', {}, h('span', { style: 'display:inline-flex;align-items:center;gap:8px' }, h('span', { class: 'game-dot', style: `background:${gameColor(game)}` }), game.name)),
        h('td', {}, statusBadge(game.status)),
        h('td', { class: 'n' }, format(game.online, 'int')),
        h('td', { class: 'n' }, format(game.servers, 'int')))))))));
}

async function feedbackPage(quiet) {
  const { data, changed } = await api('/v1/feedback');
  if (quiet && !changed) return;
  setAsOf(Math.floor(Date.now() / 1000));
  const filter = state.feedbackFilter;
  const list = h('div', { class: 'feedback-list' });
  const draw = () => {
    const words = filter.search.trim().toLowerCase();
    const items = data.items.filter((item) =>
      (state.game === 'all' || item.game === state.game)
      && (!filter.sentiment || item.sentiment === filter.sentiment)
      && (!filter.status || item.status === filter.status)
      && (!words || `${item.text} ${item.name} ${item.displayName} ${item.tags.join(' ')}`.toLowerCase().includes(words)));
    list.replaceChildren(...(items.length ? items.slice(0, 200).map((item) => {
      const game = gameById(item.game);
      return h('article', { class: 'card feedback' },
        h('div', { class: 'feedback-head' },
          game ? h('span', { class: 'game-dot', style: `background:${gameColor(game)}` }) : null,
          h('span', {}, item.gameName),
          h('span', {}, '·'),
          h('span', { title: `@${item.name}` }, item.displayName || item.name),
          item.sentiment ? h('span', { class: `sentiment ${item.sentiment}` }, item.sentiment) : null,
          item.platform ? h('span', { class: 'tag' }, item.platform) : null,
          item.tags.map((tag) => h('span', { class: 'tag' }, tag)),
          h('span', { class: 'spacer' }),
          h('span', { class: 'tag' }, item.status || 'Open', item.resolvedBy ? ` · ${item.resolvedBy}` : ''),
          h('time', { datetime: new Date(item.at * 1000).toISOString(), title: new Date(item.at * 1000).toUTCString() }, timeAgo(item.at))),
        h('p', { class: 'feedback-text', style: 'margin:0' }, item.text)); // text only: never rendered as HTML
    }) : [message('No feedback matches.')]));
  };
  const select = (key, label, values) => h('select', { class: 'select', 'aria-label': label, onchange: (event) => { filter[key] = event.target.value; draw(); } },
    h('option', { value: '' }, label), values.map((value) => h('option', { value, selected: filter[key] === value ? true : null }, value)));
  const unique = (field) => [...new Set(data.items.map((item) => item[field]).filter(Boolean))].sort();
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search text, player or tag', value: filter.search, style: 'flex:1;min-width:180px', oninput: (event) => { filter.search = event.target.value; draw(); } });
  show(
    h('div', { class: 'filters' }, select('sentiment', 'Any sentiment', unique('sentiment')), select('status', 'Any status', unique('status')), search),
    data.games.length ? null : h('p', { class: 'note' }, 'No game has a feedback source set up yet (games.json "feedback").'),
    list);
  draw();
}

// --- Rendering and polling ---
let timer = null;
let renderToken = 0;

async function render({ quiet = false } = {}) {
  const token = ++renderToken;
  clearTimeout(timer);
  syncShell();
  if (!quiet) show(...skeleton());
  try {
    if (!state.games.length) {
      const { data } = await api(`/v1/overview?range=${state.range}`);
      state.games = data.games;
      syncShell();
    }
    if (token !== renderToken) return;
    const game = state.game !== 'all' ? gameById(state.game) : null;
    if (state.game !== 'all' && !game) {
      state.game = 'all';
      return go(state.page, 'all');
    }
    // A quiet refresh leaves the page alone while someone types in it
    const typing = quiet && content.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    if (typing) {
      // try again at the next refresh
    } else if (state.page === 'overview') await (game ? gamePage('overview', true, quiet) : overviewAll(quiet));
    else if (state.page === 'funnels') await (game ? gamePage('funnels', true, quiet) : pickGame('funnels'));
    else if (state.page === 'live') await (game ? gamePage('live', false, quiet) : liveAll(quiet));
    else await feedbackPage(quiet);
  } catch (error) {
    if (token === renderToken && !quiet) show(message(error.message, 'error'));
    if (quiet) setConnection('error', error.message.split('.')[0]);
  }
  if (token === renderToken && !document.hidden) timer = setTimeout(() => render({ quiet: true }), REFRESH[state.page] * 1000);
}

window.addEventListener('hashchange', () => { readHash(); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) render({ quiet: true }); else clearTimeout(timer); });
gameSelect.addEventListener('change', () => go(state.page, gameSelect.value));
rangeGroup.addEventListener('click', (event) => {
  const range = event.target.closest('button')?.dataset.range;
  if (!range || range === state.range) return;
  state.range = range;
  localStorage.setItem('range', range);
  render();
});
document.getElementById('refresh').addEventListener('click', () => { cache.clear(); render(); });
document.getElementById('sign-out').addEventListener('click', () => { sessionStorage.removeItem('session'); cache.clear(); location.reload(); });

// Theme: system -> light -> dark
const themeButton = document.getElementById('theme');
const THEME_ICONS = {
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
};
function applyTheme(theme) {
  if (theme === 'system') {
    localStorage.removeItem('theme');
    document.documentElement.removeAttribute('data-theme');
  } else {
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }
  themeButton.innerHTML = THEME_ICONS[theme]; // static markup, no data
  themeButton.setAttribute('aria-label', `Theme: ${theme}`);
  themeButton.title = `Theme: ${theme}`;
}
themeButton.addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  applyTheme(order[(order.indexOf(localStorage.getItem('theme') || 'system') + 1) % order.length]);
});
applyTheme(localStorage.getItem('theme') || 'system');

if (!API || API.includes('example.com')) {
  show(message('Set your collector address in site/config.js (window.STATS_API).', 'error'));
} else {
  readHash();
  if (!sessionStorage.getItem('session')) signIn().then(() => render());
  else render();
}

