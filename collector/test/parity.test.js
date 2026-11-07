// The JS port must build the same widgets as the package's real Luau (Query.lua / Funnels.lua @ dd14298).
// test/parity-data.lua builds a store in Roblox Studio with a deterministic generator, runs Query.build and
// prints a hash per widget (fixtures/parity-hashes.json). This test rebuilds the same store, runs the port, and
// compares hashes. Known, intended differences are put back before hashing (see normalize).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { overviewTab, funnelsTab } from '../src/query.js';
import { labelOf } from '../src/stats.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/parity-hashes.json', import.meta.url), 'utf8'));
const AT = fixture.at;

// Roll-A-Car-Show's funnels as the package resolves them (game ones, then built-in, Once before Repeat)
const ONBOARDING = ['Joined', 'LoadingScreenDone', 'IntroFinished', 'RollCar', 'ClaimCar', 'PlaceCar', 'CollectCash', 'TutorialComplete', 'DailyRewardClaimed', 'Roll5', 'AchievementsOpen', 'UpgradeTeleport', 'Upgrade', 'GarageTeleport', 'Roll10'];
const REPEAT = {
  DailyRewards: ['MenuOpened', 'Claimed'],
  GroupReward: ['ChestUsed', 'InGroup', 'Claimed'],
  LeavingReward: ['Offered', 'Revealed', 'Stayed'],
  OfflineEarnings: ['Shown', 'Claimed'],
  Purchase: ['Prompted', 'Purchased'],
  Rebirth: ['CanAfford', 'MenuOpened', 'Rebirthed'],
  SessionTime: ['Joined', '1Min', '2Min', '3Min', '4Min', '5Min', '10Min', '15Min', '20Min', '25Min', '30Min', '35Min', '40Min', '45Min', '50Min', '55Min', '60Min'],
  Shop: ['Opened', 'ItemPrompted', 'Purchased'],
  WheelSpin: ['MenuOpened', 'Spun', 'RewardGiven'],
};
const FUNNELS = [
  { Id: 'Onboarding', Title: 'Onboarding', Kind: 'Once', Description: "A new player's first steps: loading, the intro, the tutorial, then the first lessons and rolls.", Steps: ONBOARDING },
  { Id: 'Lessons', Title: 'Tutorial lessons', Kind: 'Once', Description: 'The lessons that start later (TutorialConfig.LESSON_ORDER), the first time each is finished.', Steps: ['AchievementsOpen', 'UpgradeTeleport', 'Upgrade', 'GarageTeleport', 'IndexOpen', 'RebirthOpen', 'SellOpen', 'InventoryOpen'] },
  { Id: 'Rebirths', Title: 'Rebirths', Kind: 'Once', Description: 'How far new players get in rebirths.', Steps: ['Rebirth1', 'Rebirth2', 'Rebirth3', 'Rebirth5', 'Rebirth10', 'Rebirth20'] },
  { Id: 'Comeback', Title: 'Coming back', Kind: 'Once', Description: 'How far new players come back: their 2nd, 3rd and 5th sessions, and their 2nd, 3rd and 7th day played.', Steps: ['Session2', 'Session3', 'Day2', 'Session5', 'Day3', 'Day7'] },
  { Id: 'Spending', Title: 'First Robux', Kind: 'Once', Description: 'From the first purchase prompt to the first, second and fifth purchases.', Steps: ['PurchasePrompted', 'Purchased1', 'Purchased2', 'Purchased5'] },
  ...Object.keys(REPEAT).sort().map((id) => ({ Id: id, Title: labelOf(id), Kind: 'Repeat', Description: 'Every attempt is counted, and each player once a day at each step.', Steps: REPEAT[id] })),
];

// The same store as parity-data.lua (Park-Miller generator, same order of draws)
function buildStore() {
  let seed = 42;
  const int = (a, b) => {
    seed = (seed * 16807) % 2147483647;
    return a + (seed % (b - a + 1));
  };
  const data = {};
  const hour = Math.floor(AT / 3600), day = Math.floor(AT / 86400);
  const names = ['dau', 'dau_gap#new', 'dau_gap#1', 'dau_gap#2', 'dau_gap#5', 'dau_gap#old', 'hau', 'hau_gap#new', 'hau_gap#1', 'hau_gap#3', 'hau_gap#old', 'new_users', 'session_sum', 'sessions_ended', 'playtime', 'robux', 'payers', 'dau|platform=PC', 'fu#Shop:Opened', 'fu#Shop:Purchased', 'funnel#Shop:01:Opened', 'funnel#Shop:03:Purchased', 'onb#01:Joined'];
  const bucket = () => {
    const c = {};
    for (const name of names) c[name] = int(0, 90);
    c.session_sum = int(100, 90000);
    return { c, m: { ccu: int(1, 40) } };
  };
  for (let h = hour - 47; h <= hour; h++) data[`H${h}_0`] = bucket();
  for (let d = day - 59; d <= day; d++) data[`D${d}_0`] = bucket();
  for (let d = day - 30; d <= day; d++) {
    const counts = { size: int(5, 60), d1: int(0, 20), d7: int(0, 8) };
    let reach = counts.size;
    ONBOARDING.forEach((step, index) => {
      const i = index + 1;
      reach = Math.max(reach - int(0, 4), 0);
      counts[`f#Onboarding:${step}`] = reach;
      counts[`fpt#Onboarding:${step}`] = reach * 30 * i;
      counts[`ffar#Onboarding:${step}`] = int(0, 3);
      if (i % 3 === 0) counts[`fq1#Onboarding:${step}`] = int(1, 3);
    });
    counts['f#Comeback:Session2'] = int(0, 9);
    counts['f#Onboarding:OldStep'] = 2;
    data[`C${d}`] = counts;
  }
  const defs = { Version: 7, At: AT, Since: {}, Funnels: [] };
  for (const funnel of FUNNELS) {
    for (const step of funnel.Steps) defs.Since[`${funnel.Id}:${step}`] = AT - 3 * 86400;
    defs.Funnels.push({ ...funnel, Steps: funnel.Steps.map((id) => ({ Id: id, Label: labelOf(id) })) });
  }
  data.FunnelDefs = defs;
  data.Journeys = [
    { U: 1, N: 'Alpha', T: AT - 3600, L: 1500, P: 'PC', C: 'SE', S: 1, F: 'Roll5', D: false, E: ['Onboarding:Joined', 'Shop:Opened'], R: 0 },
    { U: 2, N: 'Beta', T: AT - 7200, L: 40, P: 'Mobile', C: 'US', S: 3, F: 'Roll10', D: true, E: ['Onboarding:Roll10'], R: 99 },
    { U: 3, N: 'Gamma', T: AT - 9000, L: 4000, P: 'Tablet', C: 'DE', S: 2, F: '', D: false, E: [], R: 0 },
  ];
  data.Markers = { Version: 7, List: [{ T: AT - 5 * 3600, Kind: 'Update', Text: 'Version 7' }, { T: AT - 3 * 86400, Kind: 'Note', Text: 'Sale' }] };
  return data;
}

// Same canonical text as the Luau side: sorted keys, numbers to 4 decimals, empty tables as []
function canon(value) {
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : value.toFixed(4);
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined && value[key] !== null).sort();
    if (!keys.length) return '[]';
    return `{${keys.map((key) => `${key}:${canon(value[key])}`).join(',')}}`;
  }
  return 'null';
}
function hash(text) {
  let h = 2166136261;
  for (const byte of Buffer.from(text, 'utf8')) {
    h = (h ^ byte) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The dashboard's intended differences from the panel, undone so the rest must match exactly
function normalize(widget) {
  const copy = structuredClone(widget);
  delete copy.Partial; // the dashboard draws the slot still in progress differently
  if (copy.Type === "Bars") copy.Items.sort((a, b) => (a.Value !== b.Value ? b.Value - a.Value : a.Label < b.Label ? -1 : a.Label > b.Label ? 1 : 0)); // ties: any order in Luau
  if (copy.Type === 'Tiles') {
    for (const item of copy.Items) if (item.Label === 'D1 retention' && item.Value === null) item.Value = 0; // shown "—" instead of 0%
  }
  if (copy.Type === 'Text' && /^The last \d+ sessions/.test(copy.Text)) copy.Text += ' Look one up on the Lookup tab for all their steps.'; // no Lookup tab here
  return copy;
}

const game = { id: 'test', shards: 1, journeyFunnel: 'Onboarding' };
const store = buildStore();
const read = (key) => store[key];

for (const [name, expected] of Object.entries(fixture.hashes)) {
  test(`${name} matches the package's Luau`, () => {
    const [tab, range] = name.split(':');
    const widgets = tab === 'Overview' ? overviewTab(game, read, range, AT).widgets : funnelsTab(game, read, range, AT).widgets;
    const got = widgets.map((widget) => hash(canon(normalize(widget))));
    assert.equal(got.length, expected.length, `widget count (${widgets.map((w) => w.Type).join(',')})`);
    got.forEach((value, index) => {
      assert.equal(value, expected[index], `widget ${index + 1} (${widgets[index].Type} ${widgets[index].Title || ''}) differs:\n${canon(normalize(widgets[index])).slice(0, 600)}`);
    });
  });
}
