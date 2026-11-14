// Reads Roblox's Benchmarks section as copied from the Creator Hub (Analytics → Overview: select from
// "Benchmarks based on" to the last card, copy) into numbers. No DOM, so the collector's tests check it too.
// Numbers come back in the units Roblox shows: minutes, percents (14.4 for 14.40%), Robux.

export const UNITS = { playtime: 'min', d1: '%', d7: '%', conversion: '%', arppu: 'R$', ptr: '%' };

// Card titles, in Roblox's words (and the older names)
const HEADINGS = [
  ['playtime', /average\s*(play\s*time|session)|session\s*time/i],
  ['d1', /day\s*1\s*retention|\bD1\b/i],
  ['d7', /day\s*7\s*retention|\bD7\b/i],
  ['conversion', /payer\s*conversion|conversion\s*rate/i],
  ['arppu', /revenue\s*per\s*paying|\bARPPU\b/i],
  ['ptr', /play[\s-]*through/i],
];

const TOKEN = /(\d+)\s*(?:st|nd|rd|th)\b|(\d[\d,]*(?:\.\d+)?)\s*(%|hours?|hrs?|h\b|min(?:ute)?s?|m\b|sec(?:ond)?s?|s\b)?/gi;

// "1.2 hr" / "45 sec" / "10.3 min" -> minutes; anything else as it is
function amount(number, unit, metric) {
  const value = Number(number.replace(/,/g, ''));
  if (metric !== 'playtime' || !unit) return value;
  if (/^h/i.test(unit)) return value * 60;
  if (/^s/i.test(unit)) return value / 60;
  return value;
}

// One card's text (title removed) -> { value, pct, p50, p90 }
function readCard(text, metric) {
  const tokens = [];
  for (const match of text.matchAll(TOKEN)) {
    if (match[1] !== undefined) tokens.push({ ordinal: Number(match[1]) });
    else tokens.push({ number: amount(match[2], match[3], metric) });
  }
  const card = {};
  const plain = [];
  let index = 0;
  for (; index < tokens.length && tokens[index].ordinal === undefined; index++) plain.push(tokens[index].number);
  if (plain.length) card.value = plain[0]; // then the change since the last 7 days, which isn't kept
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.ordinal === undefined) continue;
    const next = tokens[index + 1];
    if (next && next.number !== undefined) {
      // "50th 12.9 min": a mark
      if (token.ordinal === 50) card.p50 = next.number;
      if (token.ordinal === 90) card.p90 = next.number;
      index++;
    } else if (card.pct === undefined) card.pct = token.ordinal; // the game's own percentile, above its marker
  }
  return card;
}

// -> { basis: 'similar' | 'genre' | 'all' | null, metrics: { id: { value, pct, p50, p90 } }, found: n }
export function parseRobloxBenchmarks(text) {
  const all = String(text || '').replace(/\s+/g, ' ');
  const basis = /similar\s*(players|experiences)/i.test(all) ? 'similar' : /genre/i.test(all) ? 'genre' : /all\s*experiences/i.test(all) ? 'all' : null;
  // Each card runs from its title to the next card's title (copies come one per line or all on one line)
  const starts = [];
  for (const [id, pattern] of HEADINGS) {
    const match = new RegExp(pattern.source, 'i').exec(all);
    if (match) starts.push({ id, at: match.index, end: match.index + match[0].length });
  }
  starts.sort((a, b) => a.at - b.at);
  const blocks = starts.map((start, index) => ({
    id: start.id,
    // Without the title's "(7 day average)" (or a cut-off "(7 day…")
    text: all.slice(start.end, index + 1 < starts.length ? starts[index + 1].at : undefined)
      .replace(/^\s*[a-z ]*\(\s*\d+\s*day[^)]*?(\)|…|\.\.\.|(?=\s\d))/i, ' '),
  }));
  const metrics = {};
  for (const block of blocks) {
    const card = readCard(block.text, block.id);
    if (Object.keys(card).length) metrics[block.id] = card;
  }
  return { basis, metrics, found: Object.keys(metrics).length };
}

// Roblox's units <-> the collector's (seconds, fractions, Robux)
export const toStored = (id, value) => (value === undefined || value === null || !Number.isFinite(value) ? undefined : UNITS[id] === 'min' ? value * 60 : UNITS[id] === '%' ? value / 100 : value);
export const toShown = (id, value) => (value === undefined || value === null ? undefined : UNITS[id] === 'min' ? value / 60 : UNITS[id] === '%' ? value * 100 : value);
