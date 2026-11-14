// The Monetization page, on top of the Money tab (query.js moneyTab stays an exact port of the in-game panel; this
// file never changes one of its numbers, it adds and arranges):
// - Sales right now: this hour, the hour before and today (the buckets), and the sales feed (poller.js).
// - Each item over time, its price now, and every price change the 60 days of day buckets show: an item's price
//   on a day is its Robux / purchases (a game pass's price is looked up when it's bought, a product's comes from
//   its receipt). A day that sold at two prices (the change was that day) is left out of both.
// - Suggestions on prices: each item's prompt -> purchase rate against the game's other items, with a 90%
//   interval so a few lucky sales don't count, and before / after every price change.
// Everything here is a suggestion to test, and the page says so.

import * as S from './stats.js';
import { loadRange, labelsOf, get, ratio, series, tile, tiles, section, note, bars } from './query.js';

// Prices people are used to seeing on Roblox; a suggested price is the nearest one
export const PRICE_STEPS = [5, 10, 15, 19, 25, 29, 35, 39, 45, 49, 59, 69, 75, 79, 89, 99, 119, 129, 149, 179, 199, 249, 299, 349, 399, 449, 499, 599, 699, 799, 899, 999, 1199, 1499, 1999, 2499, 2999, 3999, 4999, 7499, 9999];
export const MIN_PROMPTS = 30; // prompts before an item's rate means anything
const MIN_SIDE = 20; // prompts on each side of a price change before comparing them
const RAISE_AT = 1.5; // the rate's low end above this many times the game's typical rate: buyers barely hesitate
const RAISE_FLOOR = 0.1; // ...and surely above 1 in 10 (a game whose prompts mostly pop up on their own has a tiny typical rate)
const RAISE_SALES = 8;
const PLACEMENT_PROMPTS = 300; // shown this often, and surely under 1 in 100 buying: the prompt's moment is the problem
const LOWER_AT = 0.5; // the rate's high end below this share of it: most who look say no
const CHART_ITEMS = 6; // items that can be drawn over time (one colour each, never reused)
const FEED_ROWS = 40;
const Z = 1.645; // 90%

// The range [low, high] the true rate is in with 90% confidence (Wilson), from `hits` of `tries`
export function wilson(hits, tries, z = Z) {
  if (!(tries > 0)) return [0, 1];
  const p = hits / tries;
  const z2 = z * z;
  const centre = p + z2 / (2 * tries);
  const margin = z * Math.sqrt((p * (1 - p)) / tries + z2 / (4 * tries * tries));
  const scale = 1 + z2 / tries;
  return [Math.max(0, (centre - margin) / scale), Math.min(1, (centre + margin) / scale)];
}

// The price step nearest `price * factor`, and at least 5% away from `price` in that direction
export function nextPrice(price, factor) {
  const target = price * factor;
  const up = factor > 1;
  const options = PRICE_STEPS.filter((step) => (up ? step >= price * 1.05 : step <= price * 0.95));
  if (!options.length) return up ? Math.round(target) : null;
  return options.reduce((best, step) => (Math.abs(step - target) < Math.abs(best - target) ? step : best));
}

// Each item's prompts (p), purchases (n) and Robux (r) in a bucket (only the totals, not the per-dimension copies)
export function itemCounters(bucket) {
  const items = {};
  for (const [key, value] of Object.entries(bucket?.c || {})) {
    if (key.includes('|')) continue;
    const match = /^(prompt|purchases|robux)#(.+)$/.exec(key);
    if (!match) continue;
    const item = (items[match[2]] ??= { p: 0, n: 0, r: 0 });
    item[match[1] === 'prompt' ? 'p' : match[1] === 'purchases' ? 'n' : 'r'] += value;
  }
  return items;
}

const soldOnePrice = (entry) => entry.n > 0 && entry.r > 0 && Math.abs(entry.r / entry.n - Math.round(entry.r / entry.n)) < 0.01;

// An item's days (oldest first, { day, p, n, r, dau }) split into runs at one price. Days without a sale stay with
// the price before them (the first run also takes the days before its first sale). A day that sold at two prices
// is marked mixed and counts for neither: its average isn't a whole number, or it's a one-day run whose price sits
// between the runs on either side.
export function priceRuns(days) {
  const runs = [];
  const lead = [];
  for (const source of days) {
    const entry = { ...source, mixed: source.n > 0 && !soldOnePrice(source) };
    const run = runs[runs.length - 1];
    if (!soldOnePrice(entry)) {
      (run ? run.days : lead).push(entry);
      continue;
    }
    const price = Math.round(entry.r / entry.n);
    if (run && run.price === price) run.days.push(entry);
    else runs.push({ price, days: runs.length ? [entry] : [...lead, entry] });
  }
  for (let index = runs.length - 2; index >= 1; index--) {
    const run = runs[index], before = runs[index - 1], after = runs[index + 1];
    const sold = run.days.filter(soldOnePrice);
    if (sold.length === 1 && (run.price - before.price) * (run.price - after.price) < 0) {
      sold[0].mixed = true;
      after.days.unshift(...run.days);
      runs.splice(index, 1);
    }
  }
  // Neighbours at the same price again (a mixed day was between them): one run
  for (let index = runs.length - 1; index >= 1; index--) {
    if (runs[index].price === runs[index - 1].price) {
      runs[index - 1].days.push(...runs[index].days);
      runs.splice(index, 1);
    }
  }
  return runs.map((run) => ({ price: run.price, days: run.days, ...runStats(run.days) }));
}

// Totals over days, leaving out days that sold at two prices
export function runStats(days) {
  const used = days.filter((entry) => !entry.mixed);
  const sum = (field) => used.reduce((total, entry) => total + (entry[field] || 0), 0);
  const p = sum('p'), n = sum('n'), r = sum('r'), dau = sum('dau');
  const firstSale = days.find((entry) => entry.n > 0); // for a run after a change: about when the change was
  return {
    from: days[0]?.day, to: days[days.length - 1]?.day, firstSale: firstSale ? firstSale.day : null,
    p, n, r, dau, rate: p > 0 ? n / p : null, perPrompt: p > 0 ? r / p : null, perPlayerDay: dau > 0 ? r / dau : null,
  };
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const pctText = (value) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
const robuxText = (value) => `R$ ${Math.round(value).toLocaleString('en-US')}`;
const perText = (value) => `R$ ${value >= 10 ? value.toFixed(1) : value.toFixed(2)}`;
const dayText = (day) => {
  const date = new Date(day * 86400000);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${date.getUTCDate()}`;
};

// Every item over the 60 days the collector keeps day buckets for: its days, price runs and the last 30 days at
// its current price
export function itemHistory(game, read, at = S.now(), range = loadRange(game, read, '30d', '', at)) {
  const buckets = [...range.prevSlots, ...range.slots];
  const firstDay = range.first - range.count;
  const perDay = buckets.map((bucket, index) => ({ day: firstDay + index, dau: bucket.c.dau || 0, items: itemCounters(bucket) }));
  const names = new Set(perDay.flatMap((entry) => Object.keys(entry.items)));
  const today = S.dayOf(at);
  const items = [...names].map((name) => {
    const days = perDay.map((entry) => ({ day: entry.day, dau: entry.dau, ...(entry.items[name] || { p: 0, n: 0, r: 0 }) }));
    const runs = priceRuns(days);
    const current = runs[runs.length - 1];
    const recentDays = (current ? current.days : days).filter((entry) => entry.day > today - 30);
    const total = runStats(days);
    const week = runStats(days.filter((entry) => entry.day > today - 7));
    const weekBefore = runStats(days.filter((entry) => entry.day > today - 14 && entry.day <= today - 7));
    return { name, days, runs, price: current ? current.price : null, recent: runStats(recentDays), total, week, weekBefore };
  });
  items.sort((a, b) => b.total.r - a.total.r || b.total.n - a.total.n || b.total.p - a.total.p);
  // Colours follow the item (its place by 60-day Robux), whatever range is shown
  items.forEach((item, index) => { item.slot = index < CHART_ITEMS && (item.total.r > 0 || item.total.n > 0) ? index + 1 : null; });
  return items;
}

const KIND_ORDER = { revert: 0, lower: 1, raise: 2, placement: 3, keep: 4, promote: 5, watch: 6, wait: 7 };

// How sure it is that Robux per prompt changed between two runs: the difference over its standard error (each
// prompt earns the price or nothing). Past Z either way is clear at 90%. The rate is kept off 0 and 1, so a side
// with no sales still has some uncertainty.
export function perPromptZ(before, after) {
  const variance = (run) => {
    const rate = Math.min(Math.max(run.n / run.p, 0.5 / run.p), 1 - 0.5 / run.p);
    return (run.price * run.price * rate * (1 - rate)) / run.p;
  };
  const spread = Math.sqrt(variance(before) + variance(after));
  return spread > 0 ? (after.perPrompt - before.perPrompt) / spread : 0;
}

// A price change: what each prompt (or player-day, when prompts aren't recorded) earned before and after it
export function compareChange(before, after) {
  const facts = { from: before.price, to: after.price, day: after.firstSale, before, after };
  if (before.p >= MIN_SIDE && after.p >= MIN_SIDE) {
    const change = before.perPrompt > 0 ? after.perPrompt / before.perPrompt - 1 : null;
    const text = `Each prompt earned ${perText(before.perPrompt)} at R$ ${before.price} and ${perText(after.perPrompt)} at R$ ${after.price}`;
    const z = perPromptZ(before, after);
    if (z > Z) return { ...facts, verdict: 'better', sure: true, change, text: `${text}: clearly better.` };
    if (z < -Z) return { ...facts, verdict: 'worse', sure: true, change, text: `${text}: clearly worse.` };
    if (change !== null && Math.abs(change) >= 0.15) return { ...facts, verdict: change > 0 ? 'better' : 'worse', sure: false, change, text: `${text}: looks ${change > 0 ? 'better' : 'worse'}, but it could still be chance.` };
    return { ...facts, verdict: 'same', sure: false, change, text: `${text}: no clear difference yet.` };
  }
  if (before.p === 0 && after.p === 0 && before.dau >= 200 && after.dau >= 200) {
    const change = before.perPlayerDay > 0 ? after.perPlayerDay / before.perPlayerDay - 1 : null;
    const text = `It earned ${perText(before.perPlayerDay * 100)} per 100 player-days at R$ ${before.price} and ${perText(after.perPlayerDay * 100)} at R$ ${after.price} (the game doesn't report its prompts)`;
    if (change !== null && Math.abs(change) >= 0.2) return { ...facts, verdict: change > 0 ? 'better' : 'worse', sure: false, change, text: `${text}: looks ${change > 0 ? 'better' : 'worse'}.` };
    return { ...facts, verdict: 'same', sure: false, change, text: `${text}: no clear difference yet.` };
  }
  return { ...facts, verdict: 'unknown', sure: false, change: null, text: `Too few prompts on one side of the change to compare yet (${before.p} before, ${after.p} after).` };
}

// The game's typical prompt -> purchase rate: the median of its items with enough prompts (null under two)
export function typicalRate(items) {
  const rates = items.filter((item) => item.recent.p >= MIN_PROMPTS).map((item) => item.recent.n / item.recent.p);
  return rates.length >= 2 ? median(rates) : null;
}

// One suggestion per item at most, the most useful first
export function adviseItems(items) {
  const typical = typicalRate(items);
  const advice = [];
  let quiet = 0, untracked = 0;
  for (const item of items) {
    const now = item.recent;
    const price = item.price;
    const facts = [
      { Label: 'Price now', Value: price, Format: 'robux' },
      { Label: 'Prompts', Value: now.p, Format: 'int' },
      { Label: 'Bought', Value: now.n, Format: 'int' },
      { Label: 'Rate', Value: now.rate, Format: 'pct' },
      { Label: 'Robux', Value: now.r, Format: 'robux' },
    ];
    const add = (kind, title, text, confidence, suggested = null) => advice.push({ Item: item.name, Kind: kind, Title: title, Text: text, Confidence: confidence, Price: price, Suggested: suggested, Facts: facts, Stake: now.r || now.p * (price || 0) });

    // A recent price change says the most: did it pay?
    if (item.runs.length >= 2) {
      const before = item.runs[item.runs.length - 2], after = item.runs[item.runs.length - 1];
      const result = compareChange(before, after);
      const changed = `It went from R$ ${before.price} to R$ ${after.price} around ${dayText(after.firstSale)}.`;
      if (result.verdict === 'worse') {
        add('revert', `Go back to R$ ${before.price}`, `${changed} ${result.text}`, result.sure ? 'high' : 'medium', before.price);
        continue;
      }
      if (result.verdict === 'better') {
        add('keep', `Keep R$ ${after.price}`, `${changed} ${result.text}`, result.sure ? 'high' : 'medium');
        continue;
      }
      if (result.verdict === 'unknown' || (result.verdict === 'same' && after.p < MIN_PROMPTS)) {
        add('wait', 'Give the new price time', `${changed} ${result.text}`, 'low');
        continue;
      }
    }

    if (now.p === 0) {
      if (now.n > 0) untracked++;
      else quiet++;
      continue;
    }
    if (now.p >= MIN_PROMPTS) {
      if (now.n === 0 && now.p >= 50) {
        const suggested = price ? nextPrice(price, 0.75) : null;
        add('lower', suggested ? `Try R$ ${suggested}` : 'Rethink this offer',
          `${now.p.toLocaleString('en-US')} prompts in the last 30 days and nobody bought it. Players see it and say no: try a lower price, or show it at a better moment (where prompts come from is below). If you know it does sell, the game isn't reporting its purchases (Stats.purchase).`,
          now.p >= 100 ? 'high' : 'medium', suggested);
        continue;
      }
      const [low, high] = wilson(now.n, now.p);
      // Lots of prompts and surely under 1 in 100 buying: the moment it's shown is the problem before the price
      if (now.p >= PLACEMENT_PROMPTS && high < 0.01) {
        add('placement', 'Show it at a better moment',
          `${now.p.toLocaleString('en-US')} prompts in the last 30 days, ${now.n} bought (${pctText(now.rate)}). When almost nobody buys from that many prompts, it usually pops up on its own at a moment players don't want it. Prompt it when it helps (out of cash, after a loss, next to what it improves) and less often; change the price after that.`,
          'medium');
        continue;
      }
      if (typical !== null && price) {
        if (low > typical * RAISE_AT && low >= RAISE_FLOOR && now.n >= RAISE_SALES) {
          const suggested = nextPrice(price, 1.25);
          const breakEven = now.rate * (price / suggested);
          add('raise', `Try R$ ${suggested}`,
            `${pctText(now.rate)} of prompts end in a purchase, against ${pctText(typical)} for your typical item: buyers barely hesitate at R$ ${price}. At R$ ${suggested} it earns more as long as at least ${pctText(breakEven)} still buy.`,
            now.p >= 200 ? 'high' : 'medium', suggested);
          continue;
        }
        if (high < typical * LOWER_AT && now.p >= 100) {
          const suggested = nextPrice(price, 0.75);
          if (suggested) {
            const breakEven = now.rate * (price / suggested);
            add('lower', `Try R$ ${suggested}`,
              `Only ${pctText(now.rate)} of prompts end in a purchase, against ${pctText(typical)} for your typical item: most who look say no at R$ ${price}. At R$ ${suggested} it earns more if at least ${pctText(breakEven)} of prompts buy.`,
              now.p >= 300 ? 'high' : 'medium', suggested);
            continue;
          }
        }
      }
    } else if (now.n >= 3 && now.rate >= Math.max(0.3, typical !== null ? typical * 2 : 0)) {
      add('promote', 'Show it more', `Only ${now.p} prompts in the last 30 days, but ${now.n} of them bought it (${pctText(now.rate)}). More players would buy it if more saw it: put it in the shop's first row, or prompt it where players need it.`, 'medium');
      continue;
    }
    // No price signal: say so when its sales are sliding
    if (item.weekBefore.n >= 5 && item.week.r < item.weekBefore.r * 0.6) {
      add('watch', 'Sales are falling', `Robux from it the last 7 days: ${robuxText(item.week.r)}, against ${robuxText(item.weekBefore.r)} the 7 days before (${pctText(1 - item.week.r / item.weekBefore.r)} less).`, 'medium');
      continue;
    }
    quiet++;
  }
  advice.sort((a, b) => KIND_ORDER[a.Kind] - KIND_ORDER[b.Kind] || b.Stake - a.Stake);
  return { items: advice, typical, quiet, untracked };
}

// Every price change in the 60 days, newest first
export function priceChanges(items, gameName) {
  const changes = [];
  for (const item of items) {
    for (let index = 1; index < item.runs.length; index++) {
      const result = compareChange(item.runs[index - 1], item.runs[index]);
      changes.push({
        Item: item.name, Game: gameName, Day: result.day, DayLabel: dayText(result.day), From: result.from, To: result.to,
        Before: { Prompts: result.before.p, Bought: result.before.n, Rate: result.before.rate, PerPrompt: result.before.perPrompt, Robux: result.before.r, Days: result.before.to - result.before.from + 1 },
        After: { Prompts: result.after.p, Bought: result.after.n, Rate: result.after.rate, PerPrompt: result.after.perPrompt, Robux: result.after.r, Days: result.after.to - result.after.from + 1 },
        Verdict: result.verdict, Sure: result.sure, Text: result.text,
      });
    }
  }
  return changes.sort((a, b) => b.Day - a.Day);
}

// This hour, the hour before and today, straight from the buckets (summed over shards)
export function salesNow(game, read, at = S.now()) {
  const sum = (key) => {
    let robux = 0, purchases = 0;
    for (let shard = 0; shard < game.shards; shard++) {
      const bucket = read(key(shard));
      robux += bucket?.c?.robux || 0;
      purchases += bucket?.c?.purchases || 0;
    }
    return { robux, purchases };
  };
  const hour = S.hourOf(at), day = S.dayOf(at);
  return {
    thisHour: sum((shard) => S.hourKey(hour, shard)),
    lastHour: sum((shard) => S.hourKey(hour - 1, shard)),
    today: sum((shard) => S.dayKey(day, shard)),
    yesterday: sum((shard) => S.dayKey(day - 1, shard)),
  };
}

const addSums = (list, field) => list.reduce((total, entry) => ({ robux: total.robux + entry[field].robux, purchases: total.purchases + entry[field].purchases }), { robux: 0, purchases: 0 });

export function salesWidget(now, feed, games) {
  const byId = Object.fromEntries(games.map((game) => [game.id, game]));
  return {
    Type: 'Sales',
    Title: 'Sales right now',
    Hours: { This: now.thisHour, Last: now.lastHour, Today: now.today, Yesterday: now.yesterday },
    Items: feed.slice(0, FEED_ROWS).map((sale) => ({
      Game: sale.game, GameName: byId[sale.game]?.name || sale.game, Slot: byId[sale.game]?.slot || 1,
      Item: sale.item, Count: sale.count, Robux: sale.robux, From: sale.from, To: sale.to,
    })),
    Multi: games.length > 1,
  };
}

function adviceWidget(advice, multi) {
  const typical = advice.typical;
  const parts = ['Suggestions to test, not sure things. They use the last 30 days at each item\'s current price.'];
  if (!multi) {
    parts.push(typical !== null
      ? `Each item's share of prompts that end in a purchase is compared with your typical item's (${pctText(typical)}), and only counts when it's clear beyond chance.`
      : 'Fewer than two items have enough prompts yet to compare them with each other.');
  }
  parts.push('Change one price at a time, then check back after a few days: the price history below shows whether it paid.');
  return {
    Type: 'Advice',
    Title: 'What to change',
    Description: parts.join(' '),
    Items: advice.items,
    Quiet: advice.quiet,
    Untracked: advice.untracked,
  };
}

// The item table and chart for a range: each item's numbers in it and the period before, its price now, and
// its Robux and purchases per slot
function itemRows(range, history, game) {
  const cur = range.index, prev = range.prevIndex;
  const prompts = labelsOf(cur, 'prompt'), purchases = labelsOf(cur, 'purchases'), robux = labelsOf(cur, 'robux');
  const prevPurchases = labelsOf(prev, 'purchases'), prevRobux = labelsOf(prev, 'robux');
  const total = get(cur, 'robux');
  const known = Object.fromEntries(history.map((item) => [item.name, item]));
  const names = new Set([...Object.keys(prompts), ...Object.keys(purchases), ...Object.keys(robux)]);
  const slotItems = range.slots.map(itemCounters);
  const rows = [...names].map((name) => {
    const p = prompts[name] || 0, n = purchases[name] || 0, r = robux[name] || 0;
    const perSlot = slotItems.map((items) => items[name] || { p: 0, n: 0, r: 0 });
    return {
      Item: name, Game: game?.id, GameName: game?.name, Slot: known[name]?.slot ?? null, Price: known[name]?.price ?? null,
      Prompts: p, Bought: n, Rate: p > 0 ? n / p : null, Robux: r, PrevRobux: prevRobux[name] || 0, PrevBought: prevPurchases[name] || 0,
      Share: total > 0 ? r / total : null, PerPrompt: p > 0 ? r / p : null,
      RobuxSeries: perSlot.map((entry) => entry.r), BoughtSeries: perSlot.map((entry) => entry.n),
    };
  });
  rows.sort((a, b) => b.Robux - a.Robux || b.Bought - a.Bought || b.Prompts - a.Prompts);
  return rows;
}

function sourceTable(cur) {
  const prompts = labelsOf(cur, 'prompt_src'), purchases = labelsOf(cur, 'purchase_src');
  const sources = new Set([...Object.keys(prompts), ...Object.keys(purchases)]);
  const rows = [...sources].map((source) => [source, prompts[source] || 0, purchases[source] || 0, prompts[source] > 0 ? (purchases[source] || 0) / prompts[source] : null]);
  rows.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  return {
    Type: 'Table',
    Title: 'Where prompts come from',
    Columns: [{ Name: 'Where', Format: 'text' }, { Name: 'Prompts', Format: 'int' }, { Name: 'Bought', Format: 'int' }, { Name: 'Rate', Format: 'pct' }],
    Rows: rows,
  };
}

const lineOf = (title, format, range, values, prevValues) => ({
  Type: 'Line', Title: title, Format: format, Labels: range.labels, Partial: true,
  Series: [{ Name: 'This period', Values: values }, { Name: 'Period before', Values: prevValues }],
});

// The per-game page: the Money tab's widgets, rearranged around what the page adds
export function presentMoney(tab, { game, history, advice, now, feed, rangeLabel }) {
  const range = tab.range;
  const [tilesWidget, robuxLine, robuxBars, , promptSources, purchaseSources, firstPurchase, gifts] = tab.widgets;
  const rows = itemRows(range, history, null);
  const chartable = rows.filter((row) => row.Slot);
  const widgets = [
    tilesWidget,
    salesWidget(now, feed, [game]),
    adviceWidget(advice, false),
    section('Sales over time'),
    robuxLine,
    lineOf('Purchases', 'int', range, series(range.slots, 'purchases', ''), series(range.prevSlots, 'purchases', '')),
    {
      Type: 'ItemTrend',
      Title: 'Items over time',
      Labels: range.labels,
      Partial: true,
      Items: chartable.map((row) => ({ Name: row.Item, Slot: row.Slot, Robux: row.RobuxSeries, Bought: row.BoughtSeries })),
      Default: [...chartable].sort((a, b) => b.Robux - a.Robux).slice(0, 3).map((row) => row.Item),
    },
    section('Items'),
    { Type: 'Items', Title: `Items in the ${rangeLabel}`, Rows: rows.map(({ RobuxSeries, BoughtSeries, ...row }) => ({ ...row, Spark: RobuxSeries })), Range: rangeLabel },
    robuxBars,
    { Type: 'PriceChanges', Title: 'Price history', Description: 'Every price change in the last 60 days, from what each sale cost. "Per prompt" is Robux earned per purchase prompt: the fair way to compare two prices.', Items: priceChanges(history, null) },
    section('Where purchases happen'),
    sourceTable(range.index),
    firstPurchase,
  ];
  if (gifts.Items.length) widgets.push(gifts);
  if (!Object.keys(labelsOf(range.index, 'prompt')).length && rows.length) {
    widgets.splice(3, 0, note("This game doesn't report purchase prompts (Stats.prompt), so rates and most price suggestions can't be worked out.", 'muted'));
  }
  return widgets;
}

// All games: totals added up the right way (sums, never averages of rates), every game's suggestions and items
export function moneyAll(entries, { feed, games, rangeLabel }) {
  const sum = (field) => entries.reduce((total, entry) => total + entry.totals[field], 0);
  const sumPrev = (field) => entries.reduce((total, entry) => total + entry.prevTotals[field], 0);
  const add = (values) => values.reduce((total, list) => total.map((value, index) => value + (list[index] || 0)));
  const robuxSeries = entries.length ? add(entries.map((entry) => entry.robuxSeries)) : [];
  const prevSeries = entries.length ? add(entries.map((entry) => entry.prevRobuxSeries)) : [];
  const advice = entries.flatMap((entry) => entry.advice.items.map((item) => ({ ...item, Game: entry.game.id, GameName: entry.game.name })));
  advice.sort((a, b) => KIND_ORDER[a.Kind] - KIND_ORDER[b.Kind] || b.Stake - a.Stake);
  const rows = entries.flatMap((entry) => entry.rows.map(({ RobuxSeries, BoughtSeries, ...row }) => ({ ...row, Spark: RobuxSeries, GameSlot: entry.game.slot })));
  rows.sort((a, b) => b.Robux - a.Robux || b.Bought - a.Bought);
  const robux = sum('robux'), prevRobux = sumPrev('robux');
  const labels = entries[0]?.labels || [];
  return [
    tiles([
      tile('Robux spent', robux, prevRobux, 'robux', robuxSeries),
      tile('You earn (~70%)', robux * S.DEVELOPER_SHARE, prevRobux * S.DEVELOPER_SHARE, 'robux'),
      tile('Purchases', sum('purchases'), sumPrev('purchases'), 'int'),
      tile('Conversion', ratio(sum('payers'), sum('playerDays')), ratio(sumPrev('payers'), sumPrev('playerDays')), 'pct'),
      tile('Robux / player-day', ratio(robux, sum('playerDays')), ratio(prevRobux, sumPrev('playerDays')), 'num'),
      tile('First-time buyers', sum('firstPurchase'), sumPrev('firstPurchase'), 'int'),
    ]),
    salesWidget({
      thisHour: addSums(entries.map((entry) => entry.now), 'thisHour'), lastHour: addSums(entries.map((entry) => entry.now), 'lastHour'),
      today: addSums(entries.map((entry) => entry.now), 'today'), yesterday: addSums(entries.map((entry) => entry.now), 'yesterday'),
    }, feed, games),
    {
      Type: 'Advice', Title: 'What to change',
      Description: "Every game's suggestions, the most useful first. They're suggestions to test, from the last 30 days at each item's current price: open a game for why.",
      Items: advice.slice(0, 12), Multi: true,
      Quiet: entries.reduce((total, entry) => total + entry.advice.quiet, 0), More: Math.max(0, advice.length - 12),
    },
    section('Sales over time'),
    { Type: 'Line', Title: 'Robux spent, all games', Format: 'robux', Labels: labels, Partial: true, Series: [{ Name: 'This period', Values: robuxSeries }, { Name: 'Period before', Values: prevSeries }] },
    bars('Robux by game', 'robux', Object.fromEntries(entries.map((entry) => [entry.game.name, entry.totals.robux])), Object.fromEntries(entries.map((entry) => [entry.game.name, entry.prevTotals.robux]))),
    section('Items'),
    { Type: 'Items', Title: `Every game's items in the ${rangeLabel}`, Rows: rows, Range: rangeLabel, Multi: true },
    { Type: 'PriceChanges', Title: 'Price history', Description: 'Every price change in the last 60 days, from what each sale cost.', Items: entries.flatMap((entry) => priceChanges(entry.history, entry.game.name)).sort((a, b) => b.Day - a.Day), Multi: true },
  ];
}

// What one game gives the all-games page for a range
export function moneyTotals(tab, history, game) {
  const { index, prevIndex, slots, prevSlots, labels } = tab.range;
  const pick = (source) => ({
    robux: get(source, 'robux'), purchases: get(source, 'purchases'), payers: get(source, 'payers'), playerDays: get(source, 'dau'), firstPurchase: get(source, 'first_purchase'),
  });
  return {
    totals: pick(index), prevTotals: pick(prevIndex), labels,
    robuxSeries: series(slots, 'robux', ''), prevRobuxSeries: series(prevSlots, 'robux', ''),
    rows: itemRows(tab.range, history, game),
  };
}
