// The Funnels tab (Spotlight Admin src/server/Stats/Funnels.lua buildView @ dd14298), ported so the dashboard
// shows the same numbers as the in-game panel. No dimension filter (the dashboard has none).

import { labelOf, MAX_JOURNEYS } from './stats.js';

const stepKey = (funnelId, stepId) => `${funnelId}:${stepId}`;
const note = (text, tone) => ({ Type: 'Text', Text: text, Tone: tone });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(time) {
  const date = new Date(time * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
function formatDate(time) {
  const date = new Date(time * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${formatDay(time)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
// "45s", "6m", "1h 5m"
function shortDuration(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
const stepIndex = (funnel, stepId) => {
  const index = funnel.Steps.findIndex((step) => step.Id === stepId);
  return index >= 0 ? index + 1 : null;
};

function sumCohorts(cohorts) {
  const totals = {};
  for (const cohort of cohorts) {
    for (const [name, value] of Object.entries(cohort.counts)) totals[name] = (totals[name] || 0) + value;
  }
  return totals;
}

// Every step id with a counter under `prefix#<funnel>:` that the funnel no longer has (removed steps)
function oldSteps(totals, funnel, prefix) {
  const start = `${prefix}#${funnel.Id}:`;
  const list = [];
  for (const name of Object.keys(totals)) {
    if (name.startsWith(start) && !name.includes('|')) {
      const stepId = name.slice(start.length);
      if (!stepIndex(funnel, stepId) && !list.includes(stepId)) list.push(stepId);
    }
  }
  return list.sort();
}

function sinceText(defs, key) {
  const since = defs && typeof defs.Since === 'object' ? defs.Since[key] : undefined;
  return typeof since === 'number' ? formatDay(since) : '-';
}

function onceWidgets(funnel, input, totals) {
  const value = (prefix, stepId) => totals[`${prefix}#${stepKey(funnel.Id, stepId)}${input.suffix}`] || 0;
  const ids = funnel.Steps.map((step) => ({ Id: step.Id, Label: step.Label, Old: false }));
  for (const stepId of oldSteps(totals, funnel, 'f')) ids.push({ Id: stepId, Label: `${labelOf(stepId)} (removed)`, Old: true });
  const steps = [], rows = [], quits = [];
  let first = 0, previous = null;
  ids.forEach((step, index) => {
    const order = index + 1;
    const reached = value('f', step.Id);
    if (order === 1) first = reached;
    if (!step.Old) steps.push({ Order: order, Label: step.Label, Value: reached });
    const quit = value('fq1', step.Id);
    if (quit > 0) quits.push({ Label: step.Label, Value: quit });
    rows.push([
      `${order}. ${step.Label}`,
      reached,
      first > 0 ? reached / first : 0,
      previous && previous > 0 && !step.Old ? reached / previous : '-',
      input.suffix === '' ? value('ffar', step.Id) : '-',
      quit,
      reached > 0 ? value('fpt', step.Id) / reached : '-',
      sinceText(input.defs, stepKey(funnel.Id, step.Id)),
    ]);
    if (!step.Old) previous = reached;
  });
  const widgets = [
    { Type: 'Section', Title: funnel.Title },
    note(funnel.Description || '', 'muted'),
    { Type: 'Funnel', Title: `${funnel.Title}: players who reached each step`, Steps: steps },
    {
      Type: 'Table',
      Title: `${funnel.Title}: every step`,
      Columns: [
        { Name: 'Step', Format: 'text' }, { Name: 'Players', Format: 'int' }, { Name: 'Of start', Format: 'pct' },
        { Name: 'Kept', Format: 'pct' }, { Name: 'Stuck', Format: 'int' }, { Name: 'Quit S1', Format: 'int' },
        { Name: 'Played', Format: 'dur' }, { Name: 'Since', Format: 'text' },
      ],
      Rows: rows,
    },
  ];
  if (quits.length) {
    quits.sort((a, b) => b.Value - a.Value); // stable: equal ones stay in step order
    widgets.push({ Type: 'Bars', Title: `${funnel.Title}: where first sessions ended`, Format: 'int', Items: quits });
  }
  return widgets;
}

function repeatWidgets(funnel, input) {
  const players = input.index.fu || {};
  const attempts = {};
  for (const [label, value] of Object.entries(input.index.funnel || {})) {
    const match = /^([^:]+):\d+:(.*)$/.exec(label);
    if (match && match[1] === funnel.Id) attempts[match[2]] = (attempts[match[2]] || 0) + value;
  }
  let total = 0;
  const steps = [], rows = [];
  funnel.Steps.forEach((step, index) => {
    const count = players[stepKey(funnel.Id, step.Id)] || 0;
    total += count + (attempts[step.Id] || 0);
    steps.push({ Order: index + 1, Label: step.Label, Value: count });
    rows.push([`${index + 1}. ${step.Label}`, count, attempts[step.Id] || 0, sinceText(input.defs, stepKey(funnel.Id, step.Id))]);
  });
  if (total === 0) return [];
  return [
    { Type: 'Funnel', Title: `${funnel.Title}: players a day at each step (added up)`, Steps: steps },
    {
      Type: 'Table',
      Title: `${funnel.Title}: players and attempts`,
      Columns: [{ Name: 'Step', Format: 'text' }, { Name: 'Player-days', Format: 'int' }, { Name: 'Attempts', Format: 'int' }, { Name: 'Since', Format: 'text' }],
      Rows: rows,
    },
  ];
}

function journeyWidgets(input, journeyFunnel) {
  const funnel = input.funnels.find((entry) => entry.Id === journeyFunnel);
  const eventLabel = (event) => {
    const match = /^([^:]+):(.*)$/.exec(event);
    if (!match) return labelOf(event);
    return match[1] === journeyFunnel ? labelOf(match[2]) : `${labelOf(match[1])} › ${labelOf(match[2])}`;
  };
  const rows = input.journeys.map((journey) => {
    let furthest = '-';
    if (journey.F && journey.F !== '') {
      const index = funnel ? stepIndex(funnel, journey.F) : null;
      furthest = (index ? `${index}. ` : '') + labelOf(journey.F) + (journey.D ? ' ✓' : '');
    }
    const events = journey.E || [];
    const last = events[events.length - 1];
    return [`${journey.N} #${journey.S}`, formatDate(journey.T), journey.P, shortDuration(journey.L), furthest, last ? eventLabel(last) : '-', journey.R];
  });
  return [
    { Type: 'Section', Title: "Every player's session" },
    note(`The last ${MAX_JOURNEYS} sessions, newest first: who played, how long, how far they got in ${funnel ? funnel.Title : 'the first funnel'} (✓ = finished) and the last funnel step they reached before leaving.`, 'muted'),
    {
      Type: 'Table',
      Title: 'Recent sessions',
      Columns: [
        { Name: 'Player #session', Format: 'text' }, { Name: 'Joined (UTC)', Format: 'text' }, { Name: 'Device', Format: 'text' },
        { Name: 'Played', Format: 'text' }, { Name: funnel ? funnel.Title : 'Furthest', Format: 'text' },
        { Name: 'Last step', Format: 'text' }, { Name: 'R$', Format: 'int' },
      ],
      Rows: rows,
    },
  ];
}

// input: { funnels, cohorts, index, suffix, journeys, defs, rangeLabel, journeyFunnel }
export function buildFunnelView(input) {
  const totals = sumCohorts(input.cohorts);
  const journeyFunnel = input.journeyFunnel || input.funnels.find((funnel) => funnel.Kind === 'Once')?.Id || '';
  const widgets = [
    note(
      `Each player counts once per step. Once funnels follow the players who first joined in the ${input.rangeLabel} (by UTC day); repeat funnels add up each day's players. Of start: share of step 1. Kept: share of the step before. Stuck: players whose furthest step it is now. Quit S1: players whose first session ended there. Played: their average playtime when they reached it. Since: when the step was added.`,
      'muted',
    ),
  ];
  for (const funnel of input.funnels) if (funnel.Kind === 'Once') widgets.push(...onceWidgets(funnel, input, totals));
  widgets.push(...journeyWidgets(input, journeyFunnel));
  widgets.push({ Type: 'Section', Title: 'Repeat funnels' });
  let any = false;
  for (const funnel of input.funnels) {
    if (funnel.Kind === 'Repeat') {
      const list = repeatWidgets(funnel, input);
      if (list.length) any = true;
      widgets.push(...list);
    }
  }
  if (!any) widgets.push(note('No repeat funnel steps recorded in this range yet.'));
  return widgets;
}
