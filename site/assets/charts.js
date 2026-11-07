// Hand-made SVG charts: a line chart (crosshair + tooltip on hover, tap to pin on touch, the slot still in
// progress dashed, markers for notes and updates), a sparkline, and a data table under each chart.

import { format, h } from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
};

// A round number at or above `value`, for an axis top
function niceCeil(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

export function sparkline(values, color = 'currentColor') {
  const clean = values.map((value) => (typeof value === 'number' ? value : null));
  const max = Math.max(1, ...clean.filter((value) => value !== null));
  const width = 64, height = 18;
  const step = clean.length > 1 ? width / (clean.length - 1) : width;
  let d = '';
  clean.forEach((value, index) => {
    if (value === null) return;
    d += `${d && clean[index - 1] !== null ? 'L' : 'M'}${(index * step).toFixed(1)},${(height - 1 - (value / max) * (height - 2)).toFixed(1)}`;
  });
  const element = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  element.append(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
  return element;
}

// series: [{ name, values, color, dashed?, muted? }] (values may hold null = no data)
// options: { labels, format, partial (last slot still in progress), markers: [{ At, Text, Kind }], height }
export function lineChart(series, options) {
  const labels = options.labels || [];
  const count = labels.length;
  const height = options.height || 180;
  const pad = { top: 8, right: 8, bottom: 22, left: 40 };
  const root = h('div', { class: 'chart' });
  const tooltip = h('div', { class: 'tooltip', hidden: true, role: 'status' });
  root.append(tooltip);
  const all = series.flatMap((entry) => entry.values).filter((value) => typeof value === 'number');
  const top = niceCeil(Math.max(0, ...all));
  let pinned = null;

  function draw() {
    root.querySelector('svg')?.remove();
    const width = Math.max(root.clientWidth || 600, 240);
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const x = (index) => pad.left + (count > 1 ? (index / (count - 1)) * plotW : plotW / 2);
    const y = (value) => pad.top + plotH - (value / top) * plotH;
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': options.title || 'chart' });

    const axis = svg('g', { class: 'axis' });
    for (let tick = 0; tick <= 3; tick++) {
      const value = (top / 3) * tick;
      axis.append(svg('line', { class: 'gridline', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) }));
      const text = svg('text', { x: pad.left - 6, y: y(value) + 4, 'text-anchor': 'end' });
      text.textContent = format(value, options.format === 'pct' ? 'pct' : options.format === 'dur' ? 'dur' : 'big');
      axis.append(text);
    }
    const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotW / 64))));
    labels.forEach((label, index) => {
      if (index % every !== 0 && index !== count - 1) return;
      const text = svg('text', { x: x(index), y: height - 6, 'text-anchor': index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle' });
      text.textContent = label;
      axis.append(text);
    });
    chart.append(axis);

    for (const marker of options.markers || []) {
      const mx = pad.left + (count > 1 ? (marker.At / (count - 1)) * plotW : 0);
      // (its note shows in the tooltip when that point is hovered or tapped)
      chart.append(svg('line', { x1: mx, x2: mx, y1: pad.top, y2: pad.top + plotH, stroke: 'var(--faint)', 'stroke-dasharray': '2 3' }));
    }

    for (const entry of series) {
      const color = entry.color || 'var(--primary)';
      const points = entry.values.map((value, index) => (typeof value === 'number' ? [x(index), y(value)] : null));
      const solidEnd = options.partial && !entry.dashed ? count - 2 : count - 1;
      let d = '';
      points.forEach((point, index) => {
        if (!point || index > solidEnd) return;
        d += `${d && points[index - 1] && index - 1 <= solidEnd ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
      });
      const attrs = { fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      if (entry.dashed) attrs['stroke-dasharray'] = '4 4';
      chart.append(svg('path', { d, ...attrs }));
      // The slot still in progress: dashed, so a half-finished hour doesn't read as a drop
      if (options.partial && !entry.dashed && count > 1 && points[count - 1] && points[count - 2]) {
        chart.append(svg('path', { d: `M${points[count - 2][0]},${points[count - 2][1]}L${points[count - 1][0]},${points[count - 1][1]}`, ...attrs, 'stroke-dasharray': '3 4', opacity: '0.7' }));
      }
    }

    const cross = svg('line', { class: 'crosshair', y1: pad.top, y2: pad.top + plotH, visibility: 'hidden' });
    chart.append(cross);
    const dots = series.map((entry) => {
      const dot = svg('circle', { r: 4, fill: entry.color || 'var(--primary)', stroke: 'var(--card)', 'stroke-width': 2, visibility: 'hidden' });
      chart.append(dot);
      return dot;
    });
    const hit = svg('rect', { x: pad.left, y: 0, width: plotW, height, fill: 'transparent' });
    chart.append(hit);

    function show(index) {
      if (index === null || index < 0 || index >= count) {
        cross.setAttribute('visibility', 'hidden');
        dots.forEach((dot) => dot.setAttribute('visibility', 'hidden'));
        tooltip.hidden = true;
        return;
      }
      const px = x(index);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      tooltip.replaceChildren(h('div', { class: 'tooltip-title' }, labels[index], options.partial && index === count - 1 ? ' · in progress' : ''));
      // Notes and updates at this point (the dashed vertical lines)
      for (const marker of options.markers || []) {
        if (Math.round(marker.At) === index) tooltip.append(h('div', { class: 'tooltip-title' }, `${marker.Kind}: ${marker.Text}`));
      }
      series.forEach((entry, i) => {
        const value = entry.values[index];
        if (typeof value === 'number') {
          dots[i].setAttribute('cx', px);
          dots[i].setAttribute('cy', y(value));
          dots[i].setAttribute('visibility', 'visible');
        } else dots[i].setAttribute('visibility', 'hidden');
        tooltip.append(h('div', { class: 'tooltip-row' },
          h('span', { class: 'legend-swatch' + (entry.dashed ? ' dashed' : ''), style: `color:${entry.color || 'var(--primary)'}` }),
          entry.name, h('span', { class: 'v' }, format(value ?? null, options.format))));
      });
      tooltip.hidden = false;
      const left = Math.min(Math.max(px, 80), width - 80);
      tooltip.style.left = `${(left / width) * 100}%`;
      tooltip.style.top = `${pad.top}px`;
    }
    const indexAt = (event) => {
      const rect = chart.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * width;
      return Math.round(((px - pad.left) / plotW) * (count - 1));
    };
    hit.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse' && pinned === null) show(indexAt(event)); });
    hit.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && pinned === null) show(null); });
    hit.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      const index = indexAt(event);
      pinned = pinned === index ? null : index;
      show(pinned);
    });
    root.prepend(chart);
    if (pinned !== null) show(pinned);
  }

  // Redraw for the width; stop watching once the chart is gone (the page re-renders on updates)
  const observer = new ResizeObserver(() => (root.isConnected ? draw() : observer.disconnect()));
  observer.observe(root);
  queueMicrotask(draw);

  const legend = series.length > 1
    ? h('div', { class: 'legend' }, series.map((entry) => h('span', { class: 'legend-item' },
      h('span', { class: 'legend-swatch' + (entry.dashed ? ' dashed' : ''), style: `color:${entry.color || 'var(--primary)'}` }), entry.name)))
    : null;
  const table = dataTable(['', ...series.map((entry) => entry.name)], labels.map((label, index) => [label, ...series.map((entry) => entry.values[index])]), options.format);
  return h('div', {}, root, legend, h('details', { class: 'data' }, h('summary', {}, 'Show data'), table));
}

// A plain table of a chart's numbers (the accessible view)
export function dataTable(headers, rows, kind) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map((name, index) => h('th', { class: index ? 'n' : '' }, name)))),
    h('tbody', {}, rows.map((row) => h('tr', {}, row.map((value, index) => h('td', { class: index ? 'n' : '' }, index ? format(value ?? null, kind) : value)))))));
}
