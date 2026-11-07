// Draws the panel's widget JSON (the collector builds the same widgets the in-game panel shows): Tiles, Line,
// Bars, Columns, Funnel, Table, Text and Section. Unknown types are skipped.

import { format, change, h } from './format.js';
import { lineChart, sparkline, dataTable } from './charts.js';

function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h3', { class: 'card-title' }, title) : null, ...children);
}

const pct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%` : '—');
const fact = (label, value, tone = '') => h('div', { class: 'fact' }, h('div', { class: 'fact-label' }, label), h('div', { class: `fact-value ${tone}` }, value));
const tipRow = (label, value) => h('div', { class: 'tooltip-row' }, label, h('span', { class: 'v' }, value));
const legendItem = (key, text) => h('span', { class: 'legend-item' }, h('span', { class: `fkey ${key}` }), text);

// Steps from an older collector carry no drops: every step then counts from the one before it
function withDrops(steps) {
  if (steps.some((step) => step.From !== undefined || step.Optional)) return steps;
  let biggest = null;
  const list = steps.map((step, index) => {
    if (!index) return { ...step };
    const previous = steps[index - 1].Value;
    const lost = Math.max(0, previous - step.Value);
    return { ...step, From: index - 1, Lost: lost, Rate: previous > 0 ? lost / previous : 0 };
  });
  list.forEach((step, index) => { if (step.Lost > 0 && (biggest === null || step.Lost > list[biggest].Lost)) biggest = index; });
  if (biggest !== null) list[biggest].Biggest = true;
  return list;
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

  // One funnel: what it's for, a one-line summary, then a bar per step. The bar's full width is the funnel's
  // first step; the solid part is who reached this step, the lighter part right after it who was lost since the
  // step before (red for the biggest drop), and a striped bar is an optional step (players can skip it).
  Funnel: (widget) => {
    const steps = withDrops(widget.Steps || []);
    const unit = widget.Unit || 'players';
    const description = widget.Description ? h('p', { class: 'card-sub' }, widget.Description) : null;
    const table = widget.Table ? h('details', { class: 'data' }, h('summary', {}, 'Every step in numbers'), Draw.Table({ ...widget.Table, Title: '' })) : null;
    if (!steps.length || !steps.some((step) => step.Value > 0)) {
      return card(widget.Title, description, h('p', { class: 'note empty' }, `No ${unit} reached this funnel in this range yet.`), table);
    }
    const start = Math.max(1, ...steps.map((step) => step.Value));
    const first = steps.find((step) => !step.Optional) || steps[0];
    const biggest = steps.find((step) => step.Biggest);
    const summary = widget.Summary || {};
    const end = summary.End ?? steps[steps.length - 1].Value;
    const facts = [
      fact('Started', format(first.Value, 'int')),
      fact('Reached the last step', `${format(end, 'int')}${first.Value > 0 ? ` · ${pct(end / first.Value)}` : ''}`),
      biggest
        ? fact('Biggest drop', `${steps[biggest.From].Label} → ${biggest.Label}: −${format(biggest.Lost, 'int')} (${pct(biggest.Rate)})`, 'bad')
        : fact('Biggest drop', 'None'),
    ];
    const tip = h('div', { class: 'tooltip', hidden: true, role: 'status' });
    const show = (row, step) => {
      const lines = [
        h('div', { class: 'tooltip-title' }, `${step.Order ?? ''}${step.Order ? '. ' : ''}${step.Label}`),
        tipRow(unit[0].toUpperCase() + unit.slice(1), format(step.Value, 'int')),
        tipRow('% of start', pct(step.Value / first.Value)),
      ];
      if (step.Optional) lines.push(h('div', { class: 'tooltip-row' }, 'Optional: a later step has more players, so they can skip this one.'));
      else if (step.From !== undefined) {
        lines.push(tipRow(`Lost since "${steps[step.From].Label}"`, `${format(step.Lost, 'int')} (${pct(step.Rate)})`));
      }
      tip.replaceChildren(...lines);
      tip.hidden = false;
      tip.style.left = '50%';
      tip.style.top = `${row.offsetTop - 6}px`;
    };
    const hide = () => { tip.hidden = true; };
    const rows = steps.map((step, index) => {
      const kept = (step.Value / start) * 100;
      const lost = step.From !== undefined ? (step.Lost / start) * 100 : 0;
      const label = `${step.Order ?? index + 1}. ${step.Label}`;
      const row = h('div', {
        class: `fstep${step.Optional ? ' optional' : ''}${step.Biggest ? ' biggest' : ''}`, tabindex: '0',
        'aria-label': `${label}: ${format(step.Value, 'int')} ${unit}${step.Optional ? ', optional' : step.Lost ? `, lost ${format(step.Lost, 'int')}` : ''}`,
      },
        h('span', { class: 'fstep-label', title: label }, label,
          step.Biggest ? h('span', { class: 'flag bad' }, '▼ Biggest drop') : null,
          step.Optional ? h('span', { class: 'flag' }, 'optional') : null),
        h('div', { class: 'fbar' },
          h('div', { class: 'fbar-kept', style: `width:${kept}%` }),
          lost > 0 ? h('div', { class: 'fbar-lost', style: `width:${lost}%` }) : null),
        h('span', { class: 'fnum' }, format(step.Value, 'int')),
        h('span', { class: 'fnum muted' }, pct(step.Value / first.Value)),
        h('span', { class: `fnum ${step.Biggest ? 'bad' : 'muted'}` }, step.Optional ? '' : step.From !== undefined ? (step.Lost ? `−${pct(step.Rate)}` : '0%') : ''));
      row.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') show(row, step); });
      row.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') hide(); });
      row.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'mouse') (tip.hidden ? show(row, step) : hide()); });
      row.addEventListener('focus', () => show(row, step));
      row.addEventListener('blur', hide);
      return row;
    });
    const anyOptional = steps.some((step) => step.Optional);
    const legend = h('div', { class: 'legend' },
      legendItem('fkey-kept', `Reached the step`),
      legendItem('fkey-lost', 'Lost since the step before'),
      biggest ? legendItem('fkey-biggest', 'Biggest drop') : null,
      anyOptional ? legendItem('fkey-optional', 'Optional step') : null);
    return card(widget.Title, description,
      h('div', { class: 'facts' }, facts),
      summary.Small ? h('p', { class: 'note' }, `Only ${format(first.Value, 'int')} ${unit} so far: too few to read much into the drops yet.`) : null,
      h('div', { class: 'funnel' },
        h('div', { class: 'fstep fhead', 'aria-hidden': 'true' }, h('span', {}, 'Step'), h('span', {}), h('span', { class: 'fnum' }, unit[0].toUpperCase() + unit.slice(1)), h('span', { class: 'fnum' }, '% of start'), h('span', { class: 'fnum' }, 'vs before')),
        ...rows, tip),
      legend, table);
  },

  // The biggest drops across every funnel, ranked by players lost
  Drops: (widget) => {
    const items = widget.Items || [];
    const description = widget.Description ? h('p', { class: 'card-sub' }, widget.Description) : null;
    if (!items.length) return card(widget.Title, description, h('p', { class: 'note empty' }, 'No drops yet: no funnel has players in this range.'));
    const top = Math.max(1, ...items.map((item) => item.Lost));
    return card(widget.Title, description, h('ol', { class: 'drops' }, items.map((item) => h('li', { class: 'drop' },
      h('div', { class: 'drop-text' },
        h('div', { class: 'drop-steps' }, `${item.From} → ${item.To}`),
        h('div', { class: 'drop-funnel' }, item.Funnel, item.Small ? ' · small sample' : '')),
      h('div', { class: 'drop-bar' }, h('div', { style: `width:${(item.Lost / top) * 100}%` })),
      h('div', { class: 'drop-value' }, `−${format(item.Lost, 'int')}`, h('span', { class: 'muted' }, `${pct(item.Rate)} of ${item.Unit === 'times' ? 'times' : 'them'}`))))));
  },

  // A short legend that opens on demand
  Help: (widget) => h('details', { class: 'help card' }, h('summary', {}, widget.Title),
    h('dl', {}, (widget.Items || []).flatMap(([term, text]) => [h('dt', {}, term), h('dd', {}, text)]))),

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
    return (widget.Title ? card.bind(null, widget.Title) : (...children) => h('div', {}, ...children))(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), body)),
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
