// Number and time formats, matching the in-game panel's (StatsWidgets.Format)

export function abbreviate(value) {
  const abs = Math.abs(value);
  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (abs >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(Math.round(value));
}

export function duration(seconds) {
  if (!(seconds > 0)) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

// A value in a widget's format ("int", "pct", "dur", "robux", "num", "big", "ms", "mb", "text").
// null / undefined is "—": not known yet, never 0.
export function format(value, kind) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  switch (kind) {
    case 'pct': return `${(value * 100).toFixed(1)}%`;
    case 'signedpct': return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
    case 'dur': return duration(value);
    case 'robux': return `R$ ${abbreviate(value)}`;
    case 'num': return Math.abs(value) >= 1000 ? abbreviate(value) : Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1);
    case 'ms': return `${Math.round(value)} ms`;
    case 'mb': return `${Math.round(value)} MB`;
    case 'big': return abbreviate(value);
    case 'text': return String(value);
    default: return Math.abs(value) >= 10000 ? abbreviate(value) : String(Math.round(value));
  }
}

// Change against the period before: text and whether it's good, bad or neither
export function change(value, prev, good = 'up') {
  if (prev === null || prev === undefined || value === null || value === undefined) return null;
  if (prev === 0) return value === 0 ? { text: 'no change', tone: '' } : { text: 'new', tone: '' };
  const ratio = value / prev - 1;
  if (Math.abs(ratio) < 0.0005) return { text: 'no change', tone: '' };
  const up = ratio > 0;
  const tone = good === 'none' ? '' : (up === (good === 'up') ? 'good' : 'bad');
  return { text: `${up ? '▲' : '▼'} ${Math.abs(ratio * 100).toFixed(1)}%`, tone };
}

export function timeAgo(at) {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - at));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function utcTime(at) {
  const date = new Date(at * 1000);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// Text-safe element builder (never innerHTML with data)
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'style') element.style.cssText = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
