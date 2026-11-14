// The big counter of Roblox's highly engaged players (the goal: 250, Roblox Kids and Select) and the milestones
// card (what each game reached, what's next). The collector's milestones.js says where the numbers come from.

import { h, timeAgo, abbreviate } from './format.js';
import { sparkline } from './charts.js';
import { celebrate } from './celebrate.js';

const ICONS = { sales: '🛒', ccu: '🔥', engaged: '⭐', players: '🎮', robux: '💰' };
const shown = new Map(); // game -> the count last drawn, so a refresh only counts up when it changed
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const day = (at) => new Date(at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Counts the number up from what was shown before (from 0 the first time)
function countUp(node, game, to) {
  const from = shown.has(game) ? shown.get(game) : 0;
  shown.set(game, to);
  if (from === to || reduced()) { node.textContent = to.toLocaleString(); return; }
  const start = performance.now(), length = Math.min(1600, 500 + Math.abs(to - from) * 6);
  const step = (now) => {
    const t = Math.min(1, (now - start) / length);
    node.textContent = Math.round(from + (to - from) * (1 - (1 - t) ** 3)).toLocaleString();
    if (t < 1 && node.isConnected !== false) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function editor(entry, save) {
  const input = h('input', { class: 'input', inputmode: 'numeric', 'aria-label': 'Highly engaged players', placeholder: 'e.g. 142', value: entry.Count === null ? '' : String(entry.Count) });
  const error = h('p', { class: 'note error', role: 'alert', hidden: true });
  const button = h('button', { class: 'button primary', type: 'submit' }, 'Save');
  const dialog = h('dialog', { class: 'engaged-dialog', 'aria-labelledby': 'engaged-dialog-title' });
  const form = h('form', { onsubmit: async (event) => {
    event.preventDefault();
    error.hidden = true;
    button.disabled = true;
    try {
      await save({ game: entry.Game, count: input.value });
      dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    }
    button.disabled = false;
  } },
    h('ol', { class: 'note bench-steps' },
      h('li', {}, 'On Roblox: Creator Hub → this experience → Audience Reach.'),
      h('li', {}, 'Type the number of highly engaged players it shows.')),
    input,
    h('p', { class: 'note' }, 'Roblox counts unique plays by highly engaged players over the last 60 days, so the number can go down as old plays drop out. Roblox updates it in real time: copy it in whenever you like.'),
    error,
    h('div', { class: 'bench-actions' }, h('button', { class: 'button', type: 'button', onclick: () => dialog.close() }, 'Cancel'), button));
  dialog.append(h('h2', { id: 'engaged-dialog-title' }, `Highly engaged players · ${entry.GameName}`), form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  input.select();
}

// One game's counter
function counter(entry, { single, owner, saveEngaged }) {
  const count = entry.Count;
  const done = count !== null && count >= entry.Goal;
  const share = count === null ? 0 : Math.min(1, count / entry.Goal);
  const number = h('span', { class: 'engaged-num' }, count === null ? '—' : '0');
  const before0 = shown.has(entry.Game) ? Math.min(1, shown.get(entry.Game) / entry.Goal) : 0; // the bar grows from where it was
  if (count !== null) countUp(number, entry.Game, count);
  const history = entry.History || [];
  const before = history.length > 1 ? history[history.length - 2] : null;
  const delta = before && count !== null && count !== before.Count
    ? h('span', { class: `delta ${count > before.Count ? 'good' : 'bad'}` }, `${count > before.Count ? '▲' : '▼'} ${Math.abs(count - before.Count)} since ${day(before.T)}`)
    : null;
  const fill = h('div', { class: 'engaged-fill', style: `width:${(reduced() ? share : before0) * 100}%` });
  if (!reduced() && before0 !== share) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${share * 100}%`; }));
  const ticks = [entry.Keep, 100, 150, 200].map((value) => h('span', { class: `engaged-tick${count !== null && count >= value ? ' passed' : ''}`, style: `left:${(value / entry.Goal) * 100}%`, title: value === entry.Keep ? `${value}: what keeps a game listed once it's in` : String(value) }));
  const foot = count === null
    ? h('p', { class: 'note' }, 'Not copied in yet: Creator Hub → this experience → Audience Reach.')
    : h('p', { class: 'engaged-foot' },
      done ? h('strong', {}, 'Goal reached! ') : h('strong', {}, `${(entry.Goal - count).toLocaleString()} to go`),
      done ? `Keep it above ${entry.Keep} to stay in.` : null,
      delta ? ' · ' : null, delta,
      ` · from Roblox ${timeAgo(entry.At)}`);
  return h('div', { class: `engaged-item${done ? ' done' : ''}${single ? ' single' : ''}` },
    single ? null : h('div', { class: 'engaged-game' }, h('span', { class: 'game-dot', style: `background:var(--game-${entry.Slot})` }), entry.GameName),
    h('div', { class: 'engaged-count' },
      number, h('span', { class: 'engaged-goal' }, `/ ${entry.Goal}`),
      done ? h('span', { class: 'engaged-badge' }, '🏆 Kids and Select') : null,
      h('span', { class: 'spacer' }),
      history.length > 1 ? sparkline(history.map((row) => row.Count), done ? 'var(--engaged-gold)' : 'var(--primary)') : null,
      owner && saveEngaged ? h('button', { class: 'button small', type: 'button', onclick: () => editor(entry, saveEngaged) }, count === null ? 'Copy in' : 'Update') : null),
    h('div', { class: 'engaged-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(entry.Goal), 'aria-valuenow': String(count ?? 0), 'aria-label': `Highly engaged players, ${count ?? 0} of ${entry.Goal}` },
      fill, ticks),
    foot);
}

// The card. items: one per game (Count null = not copied in yet). ctx: { owner, saveEngaged }
export function engagedCard(items, ctx = {}) {
  if (!items?.length) return null;
  const single = items.length === 1;
  // The games closest to the goal first; the ones not copied in last
  const list = [...items].sort((a, b) => (b.Count ?? -1) - (a.Count ?? -1));
  if (!ctx.owner && list.every((item) => item.Count === null)) return null;
  return h('section', { class: `card engaged${single ? ' single' : ''}` },
    h('h3', { class: 'card-title' }, '⭐ Highly engaged players',
      h('span', { class: 'meta' }, `Goal: ${list[0].Goal} in 60 days, for Roblox Kids and Select`)),
    h('div', { class: 'engaged-grid' }, list.map((entry) => counter(entry, { ...ctx, single }))),
    h('p', { class: 'note engaged-about' }, "Roblox's count from Creator Hub → Audience Reach: unique plays in the last 60 days by age-checked players with enough account age and playtime here who bought something anywhere on Roblox. Roblox doesn't publish the exact rules and only Roblox can count them, so the number is copied in."));
}

export const engagedWidget = (widget, ctx) => engagedCard(widget.Items, ctx);

const progressValue = (kind, value) => (kind === 'robux' ? `R$ ${abbreviate(value)}` : value >= 10000 ? abbreviate(value) : value.toLocaleString());

// A reached milestone, with a button to have its party again
export function milestoneRow(item, { withGame } = {}) {
  return h('li', { class: `milestone ${item.Level}` },
    h('span', { class: 'milestone-icon', 'aria-hidden': 'true' }, ICONS[item.Kind] || '🎉'),
    h('span', { class: 'milestone-text' },
      h('strong', {}, item.Title),
      h('span', { class: 'muted' },
        withGame ? [h('span', { class: 'game-dot', style: `background:var(--game-${item.Slot})` }), ` ${item.GameName} · `] : null,
        item.Quiet ? `by ${day(item.At)}` : day(item.At))),
    h('button', { class: 'button small', type: 'button', title: 'Celebrate again', 'aria-label': `Celebrate ${item.Title} again`, onclick: () => celebrate({ ...item, Key: `${item.Key}:again:${Date.now()}` }) }, '🎉'));
}

export function milestonesWidget(widget) {
  const next = h('div', { class: 'milestone-next' }, (widget.Next || []).map((item) => h('div', { class: 'milestone-goal' },
    h('div', { class: 'milestone-goal-head' }, h('span', { 'aria-hidden': 'true' }, ICONS[item.Kind]), h('span', { class: 'muted' }, item.Label)),
    h('strong', {}, item.Title),
    h('div', { class: 'milestone-track' }, h('div', { style: `width:${Math.min(100, (item.Current / item.Value) * 100)}%` })),
    h('span', { class: 'note' }, `${progressValue(item.Kind, item.Current)} of ${progressValue(item.Kind, item.Value)}`))));
  const reached = widget.Reached || [];
  return h('section', { class: 'card' },
    h('h3', { class: 'card-title' }, 'Milestones', h('span', { class: 'meta' }, 'all time · each one gets a party when it happens')),
    h('h4', { class: 'milestone-heading' }, 'Next up'), next,
    h('h4', { class: 'milestone-heading' }, 'Reached'),
    reached.length
      ? h('ul', { class: 'milestone-list' }, reached.map((item) => milestoneRow(item)))
      : h('p', { class: 'note' }, 'Nothing yet. The first sale gets fireworks.'),
    reached.some((item) => item.Quiet) ? h('p', { class: 'note', style: 'margin-top:8px' }, '"by" a date: already reached when milestones started being tracked.') : null);
}

