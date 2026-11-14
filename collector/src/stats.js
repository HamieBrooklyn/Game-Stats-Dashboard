// Constants and helpers of Spotlight Admin's stats (src/shared/Stats.lua), so the collector reads the same keys
// and does the same math as the in-game panel. Ported from Spotlight-Admin @ dd14298.

export const PACKAGE_COMMIT = 'dd14298';

export const GAP_DAYS = 30;
export const GAP_HOURS = 24;
export const MAX_COHORT_DAY = 30;
export const CLOSE_DELAY = 300; // seconds after a slot's end that the panel still expects late merges
export const DEVELOPER_SHARE = 0.7;
export const JOURNEYS_KEY = 'Journeys';
export const DEFS_KEY = 'FunnelDefs';
export const MAX_JOURNEYS = 300;
export const FIRST_PURCHASE_MINUTES = [5, 15, 30, 60, 180, 600]; // minutes played before the first purchase

export const RANGES = {
  '24h': { unit: 'Hour', count: 24, label: '24 hours' },
  '7d': { unit: 'Day', count: 7, label: '7 days' },
  '30d': { unit: 'Day', count: 30, label: '30 days' },
};

// The package's own Once funnels, added after a game's (Stats.BUILT_IN_FUNNELS)
export const BUILT_IN_FUNNELS = [
  {
    Id: 'Comeback',
    Title: 'Coming back',
    Kind: 'Once',
    Description: 'How far new players come back: their 2nd, 3rd and 5th sessions, and their 2nd, 3rd and 7th day played.',
    Steps: ['Session2', 'Session3', 'Day2', 'Session5', 'Day3', 'Day7'],
  },
  {
    Id: 'Spending',
    Title: 'First Robux',
    Kind: 'Once',
    Description: 'From the first purchase prompt to the first, second and fifth purchases.',
    Steps: ['PurchasePrompted', 'Purchased1', 'Purchased2', 'Purchased5'],
  },
];

export const hourOf = (time) => Math.floor(time / 3600);
export const dayOf = (time) => Math.floor(time / 86400);
export const hourKey = (hour, shard) => `H${hour}_${shard}`;
export const dayKey = (day, shard) => `D${day}_${shard}`;
export const cohortKey = (day) => `C${day}`;
export const now = () => Math.floor(Date.now() / 1000);

// "LoadingScreenDone" -> "Loading screen done", "Roll10" -> "Roll 10", "5Min" -> "5 min" (Stats.labelOf)
export function labelOf(id) {
  const spaced = String(id)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/_/g, ' ');
  return spaced.slice(0, 1) + spaced.slice(1).toLowerCase();
}

// The label of the bucket `value` falls in (Stats.bucketLabel)
export function bucketLabel(value, edges, unit = '') {
  for (let index = 0; index < edges.length; index++) {
    if (value < edges[index]) {
      return index === 0 ? `<${edges[0]}${unit}` : `${edges[index - 1]}-${edges[index]}${unit}`;
    }
  }
  return `${edges[edges.length - 1]}+${unit}`;
}

// Every bucket's label in order (Stats.bucketLabels)
export function bucketLabels(edges, unit = '') {
  const labels = [bucketLabel(edges[0] - 1e-9, edges, unit)];
  for (let index = 1; index < edges.length; index++) labels.push(bucketLabel(edges[index - 1], edges, unit));
  labels.push(bucketLabel(edges[edges.length - 1], edges, unit));
  return labels;
}

export const emptyBucket = () => ({ c: {}, m: {} });

// Adds a saved bucket into `into` (Store.addInto): counters add, peaks keep the higher
export function addInto(into, bucket) {
  if (!bucket || typeof bucket !== 'object') return;
  for (const [name, amount] of Object.entries(bucket.c || {})) into.c[name] = (into.c[name] || 0) + amount;
  for (const [name, value] of Object.entries(bucket.m || {})) {
    if (into.m[name] === undefined || value > into.m[name]) into.m[name] = value;
  }
}
