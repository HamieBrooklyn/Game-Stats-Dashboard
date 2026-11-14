// Roblox's Benchmarks cards (Creator Hub → Analytics → Overview), live: the value is counted by the collector
// from the game's own stats (benchmarks.js there says how), the 50th and 90th percentiles are Roblox's, copied in
// by the owner. The bar is Roblox's: 0-50th, 50th-90th and 90th-100th, the game's percentile marked on it.

import { h, abbreviate } from './format.js';
import { parseRobloxBenchmarks, toStored, toShown, UNITS } from './benchparse.js';

const WINDOW_LABELS = { 7: '7 day average', 30: '30 day average' };
const SEGMENTS = [[0, 50], [50, 90], [90, 100]];
const BASIS_LABELS = { similar: 'experiences with similar players', genre: 'experiences in your genre', all: 'all experiences' };

const store = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
};

// Rounded down, like Roblox ("22nd": above 22% of similar experiences, not yet 23%)
export function ordinal(n) {
  const value = Math.floor(n + 1e-6);
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] || 'th');
  return `${value}${suffix}`;
}

// Roblox's formats: "10.3 min", "14.40%", "31.9" (Robux)
function show(value, kind) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (kind === 'min') return value < 60 ? `${Math.round(value)} sec` : `${(value / 60).toFixed(1)} min`;
  if (kind === 'pct') return `${(value * 100).toFixed(2)}%`;
  if (kind === 'robux') return value >= 1000 ? abbreviate(value) : value.toFixed(1);
  return String(value);
}

const robuxIcon = () => h('span', { class: 'bench-robux', 'aria-label': 'Robux' }, 'R$');
const valueNode = (value, kind) => h('span', {}, kind === 'robux' && Number.isFinite(value) ? [robuxIcon(), ' '] : null, show(value, kind));

// Orange at the bottom, through yellow, to green from the 50th up (Roblox's colours)
const toneOf = (pct) => `hsl(${Math.round(28 + (Math.min(Math.max(pct, 0), 50) / 50) * 92)} 68% 50%)`;

function changePill(value, prev) {
  if (!Number.isFinite(value) || !Number.isFinite(prev) || prev <= 0) return null;
  const ratio = value / prev - 1;
  if (Math.abs(ratio) < 0.0005) return h('span', { class: 'bench-change' }, 'no change');
  return h('span', { class: `bench-change ${ratio > 0 ? 'up' : ''}`, title: 'Against the window before this one' }, `${ratio > 0 ? '↑' : '↓'} ${Math.abs(ratio * 100).toFixed(1)}%`);
}

// The 3-part bar, the marker at the percentile, and the 50th/90th marks under it
function bar(item) {
  const pct = Number.isFinite(item.Percentile) ? Math.min(Math.max(item.Percentile, 0), 100) : null;
  const tone = pct === null ? null : toneOf(pct);
  const segments = SEGMENTS.map(([from, to]) => {
    const filled = pct === null ? 0 : Math.min(Math.max((pct - from) / (to - from), 0), 1);
    const inside = pct !== null && pct >= from && (pct < to || (to === 100 && pct <= 100));
    return h('div', { class: 'bench-seg', style: `flex-grow:${to - from}` },
      filled > 0 ? h('div', { class: 'bench-fill', style: `width:${filled * 100}%;background:${tone}` }) : null,
      inside ? h('div', { class: 'bench-knob', style: `left:${filled * 100}%` },
        h('span', { class: 'bench-rank' }, pct < 1 ? '<1st' : pct >= 99 ? '99th' : ordinal(pct))) : null);
  });
  const marks = item.Benchmark
    ? h('div', { class: 'bench-marks' },
      h('span', { class: 'bench-mark', style: 'left:50%' }, h('b', {}, '50th'), show(item.Benchmark.P50, item.Format)),
      h('span', { class: 'bench-mark end' }, h('b', {}, '90th'), show(item.Benchmark.P90, item.Format)))
    : h('div', { class: 'bench-marks empty' }, 'No Roblox benchmark copied in yet');
  return h('div', { class: `bench-bar${pct === null ? ' none' : ''}`, role: 'img', 'aria-label': pct === null ? 'No percentile yet' : `${ordinal(pct)} percentile among similar experiences` },
    h('div', { class: 'bench-track' }, segments), marks);
}

function infoButton(item, windowLabel) {
  const lines = [item.Info];
  if (item.Live) {
    lines.push(`Live: the ${windowLabel.replace(' average', '')}s up to now (UTC), today so far included, pooled over the days.`);
    if (Number.isFinite(item.Roblox)) lines.push(`Averaged the way Roblox does (the mean of each complete day): ${show(item.Roblox, item.Format)}.`);
    if (item.Small) lines.push('Small sample: a handful of players can move this a lot.');
  }
  if (item.Benchmark) lines.push(`The 50th and 90th are Roblox's: half of similar experiences are below ${show(item.Benchmark.P50, item.Format)}, and 1 in 10 is above ${show(item.Benchmark.P90, item.Format)}.`);
  const text = lines.join(' ');
  const pop = h('div', { class: 'bench-pop', hidden: true, role: 'tooltip' }, lines.map((line) => h('p', {}, line)));
  const button = h('button', { class: 'bench-info', type: 'button', 'aria-label': `About ${item.Title}`, 'aria-expanded': 'false', title: text }, 'i');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
    button.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) document.addEventListener('click', () => { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); }, { once: true });
  });
  return [button, pop];
}

function benchCard(item, windowLabel, savedAt) {
  const day = savedAt ? new Date(savedAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  let foot = null;
  if (!item.Live) {
    foot = h('p', { class: 'bench-foot' }, item.FromRoblox ? `Roblox's own number${day ? `, copied ${day}` : ''}: only Roblox counts impressions.` : "Only Roblox can count this (it needs your home-page impressions). Copy Roblox's card in to see it here.");
  } else if (item.FromRoblox && Number.isFinite(item.FromRoblox.Value)) {
    foot = h('p', { class: 'bench-foot' }, `Roblox showed ${show(item.FromRoblox.Value, item.Format)}${Number.isFinite(item.FromRoblox.Percentile) ? ` (${ordinal(item.FromRoblox.Percentile)})` : ''}${day ? ` on ${day}` : ''}`, item.Small ? ' · small sample' : '');
  } else if (item.Small) foot = h('p', { class: 'bench-foot' }, 'Small sample');
  return h('div', { class: 'bench-card' },
    h('div', { class: 'bench-head' },
      h('span', { class: 'bench-title', title: `${item.Title} (${item.Live ? windowLabel : 'from Roblox'})` }, `${item.Title} (${item.Live ? windowLabel : 'from Roblox'})`),
      ...infoButton(item, windowLabel)),
    h('div', { class: 'bench-value' }, valueNode(item.Value, item.Format), item.Live ? changePill(item.Value, item.Prev) : h('span', { class: 'bench-tag' }, 'Roblox only')),
    bar(item), foot);
}

// The editor: paste Roblox's section, or type the numbers in
function editor(widget, save) {
  const latest = widget.Windows[7] || [];
  const inputs = {};
  const field = (id, key, value, label) => {
    const input = h('input', { class: 'input', inputmode: 'decimal', 'aria-label': label, value: value === undefined ? '' : String(+value.toFixed(4)) });
    inputs[`${id}.${key}`] = input;
    return h('td', {}, input);
  };
  const rows = latest.map((item) => {
    const saved = { p50: item.Benchmark?.P50, p90: item.Benchmark?.P90, value: item.FromRoblox?.Value, pct: item.FromRoblox?.Percentile };
    const unit = UNITS[item.Id];
    return h('tr', {},
      h('th', { scope: 'row' }, item.Title, h('span', { class: 'muted' }, ` (${unit})`)),
      field(item.Id, 'value', toShown(item.Id, saved.value), `${item.Title}: Roblox's value`),
      field(item.Id, 'pct', saved.pct ?? undefined, `${item.Title}: Roblox's percentile`),
      field(item.Id, 'p50', toShown(item.Id, saved.p50), `${item.Title}: 50th percentile`),
      field(item.Id, 'p90', toShown(item.Id, saved.p90), `${item.Title}: 90th percentile`));
  });
  const basis = h('select', { class: 'select', 'aria-label': 'Benchmarks based on' },
    Object.entries(BASIS_LABELS).map(([value, label]) => h('option', { value, selected: (widget.Basis || 'similar') === value ? true : null }, label)));
  const status = h('p', { class: 'note', role: 'status' });
  const error = h('p', { class: 'note error', role: 'alert', hidden: true });
  const paste = h('textarea', { class: 'input bench-paste', rows: '3', placeholder: 'Paste Roblox\'s Benchmarks section here', 'aria-label': "Roblox's Benchmarks section, pasted" });
  paste.addEventListener('input', () => {
    const parsed = parseRobloxBenchmarks(paste.value);
    if (parsed.basis) basis.value = parsed.basis;
    for (const [id, card] of Object.entries(parsed.metrics)) {
      for (const key of ['value', 'pct', 'p50', 'p90']) if (card[key] !== undefined && inputs[`${id}.${key}`]) inputs[`${id}.${key}`].value = String(card[key]);
    }
    status.textContent = parsed.found ? `Read ${parsed.found} of ${latest.length} cards. Check them, then save.` : "Couldn't find Roblox's cards in that text.";
  });
  const dialog = h('dialog', { class: 'bench-dialog', 'aria-labelledby': 'bench-dialog-title' });
  const saveButton = h('button', { class: 'button primary', type: 'submit' }, 'Save');
  const form = h('form', { onsubmit: async (event) => {
    event.preventDefault();
    error.hidden = true;
    const metrics = {};
    for (const item of latest) {
      const entry = {};
      for (const key of ['value', 'pct', 'p50', 'p90']) {
        const raw = inputs[`${item.Id}.${key}`].value.replace(/[^\d.]/g, '');
        if (raw === '') continue;
        const number = Number(raw);
        if (!Number.isFinite(number)) continue;
        entry[key] = key === 'pct' ? number : toStored(item.Id, number);
      }
      if (Object.keys(entry).length) metrics[item.Id] = entry;
    }
    saveButton.disabled = true;
    try {
      await save({ game: widget.Game, basis: basis.value, metrics });
      dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    }
    saveButton.disabled = false;
  } },
    h('ol', { class: 'note bench-steps' },
      h('li', {}, 'On Roblox: Creator Hub → this experience → Analytics → Overview, with "7 day average" picked.'),
      h('li', {}, 'Select from "Benchmarks based on" to the last card, copy, and paste below. Or type the numbers in.')),
    paste, status,
    h('label', { class: 'bench-basis' }, 'Based on ', basis),
    h('div', { class: 'table-wrap' }, h('table', { class: 'bench-table' },
      h('thead', {}, h('tr', {}, ['Card', "Roblox's value", 'Its percentile', '50th', '90th'].map((name) => h('th', {}, name)))),
      h('tbody', {}, rows))),
    h('p', { class: 'note' }, "Roblox refreshes these daily, but they move slowly: copying them in every week or two is plenty. Roblox's own value and percentile are optional; with them, the bar matches Roblox's exactly at that value."),
    error,
    h('div', { class: 'bench-actions' }, h('button', { class: 'button', type: 'button', onclick: () => dialog.close() }, 'Cancel'), saveButton));
  dialog.append(h('h2', { id: 'bench-dialog-title' }, "Roblox's benchmarks"), form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  paste.focus();
}

// The section. ctx: { owner, saveBenchmarks(body) }
export function benchmarksWidget(widget, ctx = {}) {
  const windows = Object.keys(widget.Windows || {}).map(Number).sort((a, b) => a - b);
  if (!windows.length) return null;
  let days = Number(store.get('benchWindow')) || 7;
  if (!windows.includes(days)) days = windows[0];
  const grid = h('div', { class: 'bench-grid' });
  const draw = () => grid.replaceChildren(...widget.Windows[days].map((item) => benchCard(item, WINDOW_LABELS[days] || `${days} day average`, widget.SavedAt)));
  draw();
  const picker = h('select', { class: 'select bench-window', 'aria-label': 'Window' }, windows.map((value) => h('option', { value, selected: value === days ? true : null }, WINDOW_LABELS[value] || `${value} day average`)));
  picker.addEventListener('change', () => {
    days = Number(picker.value);
    store.set('benchWindow', String(days));
    draw();
  });
  const saved = widget.SavedAt ? new Date(widget.SavedAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  return h('section', { class: 'card bench' },
    h('div', { class: 'bench-top' },
      h('div', {},
        h('h2', { class: 'bench-heading' }, 'Benchmarks based on ', h('span', { class: 'bench-basis-pill' }, widget.BasisLabel || 'Roblox (not copied in yet)')),
        h('p', { class: 'note' }, h('span', { class: 'dot ok' }), ' Live from the game\'s own stats, every minute. ',
          saved ? `Percentiles from Roblox, copied ${saved}.` : "Copy Roblox's percentiles in to see where you stand.")),
      h('span', { class: 'spacer' }),
      picker,
      ctx.owner && ctx.saveBenchmarks ? h('button', { class: 'button', type: 'button', onclick: () => editor(widget, ctx.saveBenchmarks) }, saved ? 'Update from Roblox' : 'Copy in from Roblox') : null),
    grid);
}
