// Draws the panel's widget JSON (the collector builds the same widgets the in-game panel shows): Tiles, Line,
// Bars, Columns, Funnel, Table, Text and Section. Unknown types are skipped.

import { format, change, h } from './format.js';
import { lineChart, sparkline, dataTable } from './charts.js';

function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h3', { class: 'card-title' }, title) : null, ...children);
}

const Draw = {
  Section: (widget) => h('h2', { class: 'section-title' }, widget.Title),
  Text: (widget) => (widget.Text ? h('p', { class: `note ${widget.Tone === 'error' ? 'error' : ''}` }, widget.Text) : null),

  Tiles: (widget) => h('div', { class: 'tiles' }, widget.Items.map((item) => {
    const delta = change(item.Value, item.Prev, item.Good);
    return h('div', { class: 'tile' },
      h('div', { class: 'tile-label' }, item.Label),
      h('div', { class: 'tile-value' }, format(item.Value, item.Format)),
      h('div', { class: 'tile-foot' },
        delta ? h('span', { class: `delta ${delta.tone}`, title: `Before: ${format(item.Prev, item.Format)}` }, delta.text) : null,
        delta ? h('span', {}, 'vs before') : null,
        item.Spark && item.Spark.length > 1 ? sparkline(item.Spark) : null));
  })),

  Line: (widget) => {
    const series = widget.Series.map((entry, index) => ({
      name: entry.Name,
      values: entry.Values,
      // The current period in the accent; the one before dashed and muted, never another hue
      color: index === 0 ? 'var(--primary)' : 'var(--series-prev)',
      dashed: index > 0 && /before/i.test(entry.Name),
    }));
    return card(widget.Title, lineChart(series, { labels: widget.Labels, format: widget.Format, partial: widget.Partial, markers: widget.Markers, title: widget.Title }));
  },

  Bars: (widget) => {
    const items = widget.Items || [];
    if (!items.length) return card(widget.Title, h('p', { class: 'note' }, 'Nothing yet.'));
    const top = Math.max(1, ...items.map((item) => item.Value));
    return card(widget.Title, h('div', { class: 'bars' }, items.map((item) => h('div', { class: 'bar-row' },
      h('span', { class: 'bar-label', title: item.Label }, item.Label),
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${(item.Value / top) * 100}%` })),
      h('span', { class: 'bar-value' }, format(item.Value, widget.Format),
        item.Prev !== undefined ? h('span', { class: 'muted' }, `was ${format(item.Prev, widget.Format)}`) : null)))));
  },

  Columns: (widget) => Draw.Bars({ ...widget, Items: (widget.Items || []).filter((item) => item.Value) }),

  // Steps as bars, each with its share of step 1 and what was lost since the step before
  Funnel: (widget) => {
    const steps = widget.Steps || [];
    if (!steps.length) return card(widget.Title, h('p', { class: 'note' }, 'Nothing yet.'));
    const start = Math.max(steps[0].Value, 1);
    const top = Math.max(1, ...steps.map((step) => step.Value));
    return card(widget.Title, h('div', { class: 'bars' }, steps.map((step, index) => {
      const previous = index > 0 ? steps[index - 1].Value : null;
      const lost = previous ? 1 - step.Value / previous : null;
      return h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label', title: step.Label }, `${index + 1}. ${step.Label}`),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${(step.Value / top) * 100}%` })),
        h('span', { class: 'bar-value' }, format(step.Value, 'int'),
          h('span', { class: 'muted' }, `${((step.Value / start) * 100).toFixed(0)}%`),
          lost !== null && lost > 0.0005 ? h('span', { class: `delta ${lost >= 0.5 ? 'bad' : ''}`, style: 'margin-left:6px' }, `−${(lost * 100).toFixed(0)}%`) : null));
    })));
  },

  // Sortable: click (or Enter on) a header
  Table: (widget) => {
    const columns = widget.Columns || [];
    const rows = [...(widget.Rows || [])];
    if (!rows.length) return card(widget.Title, h('p', { class: 'note' }, 'Nothing yet.'));
    let sortColumn = null, descending = true;
    const body = h('tbody');
    const head = h('tr');
    const render = () => {
      if (sortColumn !== null) {
        rows.sort((a, b) => {
          const x = a[sortColumn], y = b[sortColumn];
          if (typeof x !== typeof y) return String(x).localeCompare(String(y));
          const order = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
          return descending ? -order : order;
        });
      }
      body.replaceChildren(...rows.slice(0, 300).map((row) => h('tr', {}, columns.map((column, index) =>
        h('td', { class: column.Format === 'text' ? '' : 'n' }, format(row[index], column.Format))))));
      head.replaceChildren(...columns.map((column, index) => h('th', { class: column.Format === 'text' ? '' : 'n', 'aria-sort': sortColumn === index ? (descending ? 'descending' : 'ascending') : null },
        h('button', { type: 'button', onclick: () => {
          if (sortColumn === index) descending = !descending;
          else { sortColumn = index; descending = column.Format !== 'text'; }
          render();
        } }, column.Name || '', sortColumn === index ? (descending ? ' ↓' : ' ↑') : ''))));
    };
    render();
    return card(widget.Title, h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), body)),
      rows.length > 300 ? h('p', { class: 'note' }, `and ${rows.length - 300} more`) : null);
  },
};

export function renderWidgets(widgets, container) {
  const nodes = [];
  for (const widget of widgets || []) {
    const draw = Draw[widget.Type];
    if (!draw) continue;
    try {
      const node = draw(widget);
      if (node) nodes.push(node);
    } catch (error) {
      console.warn('widget failed', widget.Type, error);
    }
  }
  container.replaceChildren(...nodes);
}

export { card, dataTable };
