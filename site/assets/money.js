// The Monetization page's own widgets (the collector's money.js builds them): Sales (right now and the feed),
// Advice (what to change), ItemTrend (items over time), Items (the item table) and PriceChanges (price history).
// widgets.js draws them like the panel's own.

import { format, change, h, timeAgo, utcTime } from './format.js';
import { lineChart, sparkline } from './charts.js';

const MAX_LINES = 3; // item lines on one chart (more stop being tellable apart)
const card = (title, ...children) => h('section', { class: 'card' }, title ? h('h3', { class: 'card-title' }, title) : null, ...children);
const colorOf = (slot) => (slot ? `var(--game-${slot})` : 'var(--faint)');
const dot = (slot) => h('span', { class: 'game-dot', style: `background:${colorOf(slot)}`, 'aria-hidden': 'true' });
const pct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%` : '—');

// When a sale happened: "2 min ago" when the window is short, else the window ("between 13:00 and 14:00 UTC")
function saleTime(sale) {
  if (sale.To - sale.From <= 180) return h('time', { datetime: new Date(sale.To * 1000).toISOString(), title: new Date(sale.To * 1000).toUTCString() }, timeAgo(sale.To));
  return h('time', { datetime: new Date(sale.To * 1000).toISOString(), title: 'The collector was off or just started, so only the window is known' },
    `${utcTime(sale.From).replace(' UTC', '')}–${utcTime(sale.To)}`);
}

// What each kind of suggestion is called, with an icon so it's never colour alone
const KINDS = {
  revert: { label: 'Undo', icon: '↺', tone: 'bad' },
  lower: { label: 'Lower', icon: '▼', tone: 'warn' },
  raise: { label: 'Raise', icon: '▲', tone: 'good' },
  placement: { label: 'Placement', icon: '◎', tone: 'warn' },
  keep: { label: 'Keep', icon: '✓', tone: 'good' },
  promote: { label: 'Show more', icon: '+', tone: 'good' },
  watch: { label: 'Watch', icon: '!', tone: 'warn' },
  wait: { label: 'Wait', icon: '…', tone: '' },
};
const CONFIDENCE = { high: 'Clear signal', medium: 'Likely', low: 'Too early to tell' };

// Remembered while the page is open, so a refresh with new numbers keeps what was picked
const trend = { metric: 'Robux', picked: null };
const itemSort = { key: 'Robux', descending: true };

export const moneyWidgets = {
  Sales: (widget) => {
    const hours = widget.Hours || {};
    const hourStart = utcTime(Math.floor(Date.now() / 3600000) * 3600);
    const cell = (label, entry, foot) => h('div', { class: 'tile' },
      h('div', { class: 'tile-label' }, label),
      h('div', { class: 'tile-value' }, format(entry?.robux ?? null, 'robux')),
      h('div', { class: 'tile-foot' }, `${format(entry?.purchases ?? null, 'int')} purchase${entry?.purchases === 1 ? '' : 's'}`, foot ? h('span', {}, `· ${foot}`) : null));
    const items = widget.Items || [];
    const list = items.length
      ? h('ol', { class: 'sales-feed' }, items.map((sale) => h('li', { class: 'sale' },
        widget.Multi ? dot(sale.Slot) : h('span', { class: 'sale-mark', 'aria-hidden': 'true' }),
        h('span', { class: 'sale-item' }, h('strong', {}, sale.Item), sale.Count > 1 ? h('span', { class: 'muted' }, ` ×${sale.Count}`) : null,
          widget.Multi ? h('span', { class: 'muted' }, ` · ${sale.GameName}`) : null),
        h('span', { class: 'sale-robux' }, format(sale.Robux, 'robux')),
        h('span', { class: 'sale-time muted' }, saleTime(sale)))))
      : h('p', { class: 'note empty' }, 'No sales in the last 24 hours yet. New ones show up here about a minute after they happen.');
    return card(null,
      h('h3', { class: 'card-title' }, h('span', { class: 'dot ok', 'aria-hidden': 'true' }), widget.Title,
        h('span', { class: 'meta' }, 'updates every minute · UTC')),
      h('div', { class: 'tiles sales-hours' },
        cell('This hour', hours.This, `since ${hourStart.replace(' UTC', '')}`),
        cell('Last hour', hours.Last),
        cell('Today', hours.Today, 'since 00:00 UTC'),
        cell('Yesterday', hours.Yesterday)),
      h('h4', { class: 'sub-title' }, 'Latest sales', h('span', { class: 'muted' }, ' · last 24 hours')),
      list);
  },

  Advice: (widget) => {
    const items = widget.Items || [];
    const description = widget.Description ? h('p', { class: 'card-sub' }, widget.Description) : null;
    const rest = [];
    if (widget.More) rest.push(`${widget.More} more in the games' own pages.`);
    if (widget.Quiet) rest.push(`${widget.Quiet} other item${widget.Quiet === 1 ? '' : 's'}: nothing to change, or not enough sales and prompts yet to say.`);
    if (widget.Untracked) rest.push(`${widget.Untracked} item${widget.Untracked === 1 ? ' sells' : 's sell'} without the game reporting prompts for ${widget.Untracked === 1 ? 'it' : 'them'} (Stats.prompt), so ${widget.Untracked === 1 ? 'its' : 'their'} rate is unknown.`);
    const footer = rest.length ? h('p', { class: 'note', style: 'margin-top:12px' }, rest.join(' ')) : null;
    if (!items.length) return card(widget.Title, description, h('p', { class: 'note empty' }, 'Nothing to change yet: no item has a clear signal. Suggestions show up once items have enough prompts and sales.'), footer);
    return card(widget.Title, description, h('ul', { class: 'advice-list' }, items.map((item) => {
      const kind = KINDS[item.Kind] || KINDS.wait;
      return h('li', { class: 'advice' },
        h('span', { class: `kind ${kind.tone}` }, h('span', { 'aria-hidden': 'true' }, kind.icon), kind.label),
        h('div', { class: 'advice-body' },
          h('div', { class: 'advice-head' },
            widget.Multi ? h('span', { class: 'muted' }, `${item.GameName} · `) : null,
            h('strong', {}, item.Item), h('span', { class: 'muted' }, ' — '), h('span', {}, item.Title),
            h('span', { class: `confidence ${item.Confidence}`, title: 'How sure: from how many prompts and sales it rests on' }, CONFIDENCE[item.Confidence] || '')),
          h('p', { class: 'advice-text' }, item.Text),
          h('div', { class: 'advice-facts' }, (item.Facts || []).map((fact) => h('span', {}, h('span', { class: 'muted' }, `${fact.Label} `), format(fact.Value, fact.Format))))));
    })), footer);
  },

  // Up to MAX_LINES items at once, picked with the chips; Robux or purchases. Each item keeps its colour.
  ItemTrend: (widget) => {
    const items = widget.Items || [];
    if (!items.length) return card(widget.Title, h('p', { class: 'note' }, 'No item has sold in the last 60 days yet.'));
    const names = new Set(items.map((item) => item.Name));
    if (!trend.picked || ![...trend.picked].every((name) => names.has(name)) || !trend.picked.size) trend.picked = new Set(widget.Default || []);
    const host = h('div');
    const chips = h('div', { class: 'filters' });
    const metric = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' });
    const draw = () => {
      metric.replaceChildren(...['Robux', 'Bought'].map((name) => h('button', {
        type: 'button', 'aria-pressed': String(trend.metric === name), onclick: () => { trend.metric = name; draw(); },
      }, name === 'Robux' ? 'Robux' : 'Purchases')));
      chips.replaceChildren(...items.map((item) => {
        const on = trend.picked.has(item.Name);
        return h('button', {
          class: 'chip', type: 'button', 'aria-pressed': String(on),
          disabled: !on && trend.picked.size >= MAX_LINES ? true : null,
          title: !on && trend.picked.size >= MAX_LINES ? `Up to ${MAX_LINES} at once` : null,
          onclick: () => { on ? trend.picked.delete(item.Name) : trend.picked.add(item.Name); draw(); },
        }, dot(item.Slot), item.Name);
      }));
      const series = items.filter((item) => trend.picked.has(item.Name)).map((item) => ({ name: item.Name, values: item[trend.metric], color: colorOf(item.Slot) }));
      host.replaceChildren(series.length
        ? lineChart(series, { labels: widget.Labels, format: trend.metric === 'Robux' ? 'robux' : 'int', partial: widget.Partial, title: widget.Title })
        : h('p', { class: 'note empty' }, 'Pick an item above.'));
    };
    draw();
    return card(null, h('h3', { class: 'card-title' }, widget.Title, h('span', { class: 'meta' }, 'your best-selling items of the last 60 days')),
      h('div', { class: 'trend-controls' }, metric, chips), host);
  },

  // Every item, sortable: price now, prompts, purchases, rate, Robux and its change, share, Robux per prompt
  Items: (widget) => {
    const rows = [...(widget.Rows || [])];
    if (!rows.length) return card(widget.Title, h('p', { class: 'note' }, 'No prompts or purchases in this range.'));
    const columns = [
      { key: 'Item', name: 'Item', text: true, cell: (row) => h('span', { class: 'item-name' }, dot(widget.Multi ? row.GameSlot : row.Slot), row.Item, widget.Multi ? h('span', { class: 'muted' }, ` · ${row.GameName}`) : null) },
      { key: 'Price', name: 'Price now', format: 'robux', title: 'What its latest sales cost' },
      { key: 'Prompts', name: 'Prompts', format: 'int' },
      { key: 'Bought', name: 'Bought', format: 'int' },
      { key: 'Rate', name: 'Rate', format: 'pct', title: 'Purchases ÷ prompts' },
      { key: 'Robux', name: 'Robux', format: 'robux' },
      { key: 'Change', name: 'vs before', value: (row) => (row.PrevRobux > 0 ? row.Robux / row.PrevRobux - 1 : null), cell: (row) => {
        const delta = row.Robux || row.PrevRobux ? change(row.Robux, row.PrevRobux) : null;
        return delta ? h('span', { class: `delta ${delta.tone}`, title: `Before: ${format(row.PrevRobux, 'robux')}` }, delta.text) : '—';
      } },
      { key: 'Share', name: 'Share', format: 'pct', title: "Its part of the range's Robux" },
      { key: 'PerPrompt', name: 'Per prompt', format: 'num', title: 'Robux earned per purchase prompt' },
      { key: 'Spark', name: 'Trend', sortable: false, cell: (row) => (row.Spark && row.Spark.length > 1 && row.Spark.some((value) => value > 0) ? sparkline(row.Spark, colorOf(widget.Multi ? row.GameSlot : row.Slot)) : '') },
    ];
    const valueOf = (column, row) => (column.value ? column.value(row) : row[column.key]);
    const head = h('tr');
    const body = h('tbody');
    const render = () => {
      const column = columns.find((entry) => entry.key === itemSort.key) || columns[5];
      rows.sort((a, b) => {
        const x = valueOf(column, a), y = valueOf(column, b);
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const order = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
        return itemSort.descending ? -order : order;
      });
      head.replaceChildren(...columns.map((entry) => h('th', { class: entry.text ? '' : 'n', title: entry.title || null, 'aria-sort': entry.key === itemSort.key ? (itemSort.descending ? 'descending' : 'ascending') : null },
        entry.sortable === false ? entry.name : h('button', { type: 'button', onclick: () => {
          if (itemSort.key === entry.key) itemSort.descending = !itemSort.descending;
          else { itemSort.key = entry.key; itemSort.descending = !entry.text; }
          render();
        } }, entry.name, entry.key === itemSort.key ? (itemSort.descending ? ' ↓' : ' ↑') : ''))));
      body.replaceChildren(...rows.slice(0, 300).map((row) => h('tr', {}, columns.map((entry) =>
        h('td', { class: entry.text ? '' : 'n' }, entry.cell ? entry.cell(row) : format(row[entry.key], entry.format))))));
    };
    render();
    return card(widget.Title, h('p', { class: 'card-sub' }, 'Sort by any column: Robux for what earns most, Bought for what sells most, Rate for what players say yes to.'),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), body)));
  },

  PriceChanges: (widget) => {
    const items = widget.Items || [];
    const description = widget.Description ? h('p', { class: 'card-sub' }, widget.Description) : null;
    if (!items.length) return card(widget.Title, description, h('p', { class: 'note empty' }, 'No price changes in the last 60 days. Change a price and this shows whether it paid: Robux per prompt before and after.'));
    const verdict = { better: ['good', '▲ Better'], worse: ['bad', '▼ Worse'], same: ['', '= No clear difference'], unknown: ['', '… Not enough data yet'] };
    return card(widget.Title, description, h('div', { class: 'price-changes' }, items.map((item) => {
      const [tone, label] = verdict[item.Verdict] || verdict.unknown;
      const side = (name, price, stats) => h('tr', {},
        h('td', {}, name, h('span', { class: 'muted' }, ` · R$ ${price}`)),
        h('td', { class: 'n' }, format(stats.Days, 'int')),
        h('td', { class: 'n' }, format(stats.Prompts, 'int')),
        h('td', { class: 'n' }, format(stats.Bought, 'int')),
        h('td', { class: 'n' }, stats.Rate === null ? '—' : pct(stats.Rate)),
        h('td', { class: 'n' }, stats.PerPrompt === null ? '—' : format(stats.PerPrompt, 'num')),
        h('td', { class: 'n' }, format(stats.Robux, 'robux')));
      return h('article', { class: 'price-change' },
        h('div', { class: 'advice-head' },
          widget.Multi && item.Game ? h('span', { class: 'muted' }, `${item.Game} · `) : null,
          h('strong', {}, item.Item), h('span', {}, ` R$ ${item.From} → R$ ${item.To}`), h('span', { class: 'muted' }, ` · around ${item.DayLabel}`),
          h('span', { class: `kind ${tone}` }, label, item.Sure ? '' : item.Verdict === 'better' || item.Verdict === 'worse' ? ' (not sure yet)' : '')),
        h('p', { class: 'advice-text' }, item.Text),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['', 'Days', 'Prompts', 'Bought', 'Rate', 'Per prompt', 'Robux'].map((name, index) => h('th', { class: index ? 'n' : '' }, name)))),
          h('tbody', {}, side('Before', item.From, item.Before), side('After', item.To, item.After)))));
    })));
  },
};
