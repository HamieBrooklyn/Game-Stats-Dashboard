// Makes the Funnels tab easier to read, on top of funnels.js (which stays an exact port of the in-game panel, so
// its numbers are checked by the parity test). Nothing here changes a number; it only explains and arranges:
// - every funnel card says what the funnel is for (the game's description, else games.json funnelNotes),
// - each step gets what was lost since the step before, and the biggest drop is marked,
// - steps players skip (a later step has more players) are marked optional and never count as a drop,
// - a "Where players leave" summary at the top ranks the biggest drops across all funnels,
// - each funnel's table folds into its card, with plain column names.

import { labelOf } from './stats.js';

const COLUMN_NAMES = {
  'Of start': '% of start',
  Kept: '% of step before',
  Stuck: 'Stopped here',
  'Quit S1': 'Left 1st session here',
  Played: 'Avg playtime to reach',
  Since: 'Tracked since',
  'Player-days': 'Player-days',
};
const REPEAT_NOTE = 'Every attempt counts, and each player is counted once a day at each step.';
const EVENTS_NOTE = "Every time a player reaches an onboarding step, counted the way Roblox's own funnels count it: a player who repeats a step counts again.";
const MIN_PLAYERS = 20; // a funnel that started with fewer is flagged as a small sample
const TOP_DROPS = 5;

// "LoadingScreenDone" -> "Loading screen done"; labels that already read as words stay as they are
const readable = (label) => (/^[A-Za-z0-9_]+$/.test(label) && /[a-z][A-Z0-9]|_/.test(label) ? labelOf(label) : label);

// A step is in the main path when no later step has more players. A step that fewer players reach than a later
// one is one players skip (they can do the later one without it), so a dip there isn't players leaving.
export function analyseSteps(steps) {
  const list = steps.map((step) => ({ ...step, Label: readable(String(step.Label)) }));
  let maxAfter = -Infinity;
  for (let index = list.length - 1; index >= 0; index--) {
    list[index].Optional = list[index].Value < maxAfter;
    maxAfter = Math.max(maxAfter, list[index].Value);
  }
  let previous = null, biggest = null;
  list.forEach((step, index) => {
    if (step.Optional) return;
    if (previous !== null) {
      const from = list[previous];
      step.From = previous;
      step.Lost = Math.max(0, from.Value - step.Value);
      step.Rate = from.Value > 0 ? step.Lost / from.Value : 0;
      if (step.Lost > 0 && (biggest === null || step.Lost > list[biggest].Lost)) biggest = index;
    }
    previous = index;
  });
  if (biggest !== null) list[biggest].Biggest = true;
  const main = list.filter((step) => !step.Optional);
  const start = main.length ? main[0].Value : 0;
  const end = main.length ? main[main.length - 1].Value : 0;
  return {
    steps: list,
    summary: { Start: start, End: end, Overall: start > 0 ? end / start : null, Small: start > 0 && start < MIN_PLAYERS, Biggest: biggest },
  };
}

export function presentFunnels(widgets, { funnels = [], notes = {}, rangeLabel = '' } = {}) {
  const describe = (funnel) => (typeof funnel.Description === 'string' && funnel.Description.trim()) || notes[funnel.Id] || (funnel.Kind === 'Repeat' ? REPEAT_NOTE : '');
  // Funnel widget titles start with "<funnel title>: "; the longest match wins
  const titled = [...funnels].sort((a, b) => b.Title.length - a.Title.length);
  const funnelOf = (title) => titled.find((funnel) => String(title).startsWith(`${funnel.Title}: `));

  const out = [];
  const cards = [];
  let shownOnce = false;
  for (let index = 0; index < widgets.length; index++) {
    const widget = widgets[index];
    const next = widgets[index + 1];
    // The long legend at the top: replaced by a short one that opens on demand
    if (index === 0 && widget.Type === 'Text') continue;
    // A funnel's own Section + description: the card carries both now
    if (widget.Type === 'Section' && next?.Type === 'Text' && widgets[index + 2]?.Type === 'Funnel' && funnelOf(widgets[index + 2].Title)) {
      if (!shownOnce) {
        shownOnce = true;
        out.push({ Type: 'Section', Title: 'New players' }, { Type: 'Text', Text: `Players who first joined in the ${rangeLabel}, each counted once per step.`, Tone: 'muted' });
      }
      index++;
      continue;
    }
    if (widget.Type === 'Section' && widget.Title === 'Repeat funnels') {
      out.push({ Type: 'Section', Title: 'Things players do again and again' }, { Type: 'Text', Text: `${REPEAT_NOTE} Added up over the ${rangeLabel}.`, Tone: 'muted' });
      continue;
    }
    if (widget.Type === 'Section' && /^Step events/.test(widget.Title)) {
      out.push({ Type: 'Section', Title: 'Onboarding, every time (like Roblox)' });
      continue;
    }
    if (widget.Type === 'Funnel') {
      const funnel = funnelOf(widget.Title);
      const { steps, summary } = analyseSteps(widget.Steps || []);
      const card = {
        Type: 'Funnel',
        Title: funnel ? funnel.Title : widget.Title,
        Description: funnel ? describe(funnel) : notes.StepEvents || EVENTS_NOTE,
        Kind: funnel ? funnel.Kind : 'Events',
        Unit: funnel?.Kind === 'Repeat' ? 'player-days' : funnel ? 'players' : 'times',
        Steps: steps,
        Summary: summary,
      };
      // The table right after it is its numbers: fold it into the card
      if (next?.Type === 'Table' && next.Columns?.[0]?.Name === 'Step') {
        card.Table = { ...next, Title: 'Every step in numbers', Columns: next.Columns.map((column) => ({ ...column, Name: COLUMN_NAMES[column.Name] || column.Name })) };
        index++;
      }
      cards.push(card);
      out.push(card);
      continue;
    }
    out.push(widget);
  }

  // The biggest drops across every funnel, by players lost
  const drops = [];
  for (const card of cards) {
    for (const step of card.Steps) {
      if (step.Lost > 0) drops.push({ Funnel: card.Title, Unit: card.Unit, From: card.Steps[step.From].Label, To: step.Label, Lost: step.Lost, Rate: step.Rate, Small: card.Summary.Small });
    }
  }
  drops.sort((a, b) => b.Lost - a.Lost);
  const summary = {
    Type: 'Drops',
    Title: 'Where players leave',
    Description: `The biggest losses from one step to the next in the ${rangeLabel}, across every funnel. Optional steps (ones players can skip) never count as a loss.`,
    Items: drops.slice(0, TOP_DROPS),
  };
  const help = {
    Type: 'Help',
    Title: 'How to read these',
    Items: [
      ['Bar', 'How many reached the step. The full width is where the funnel starts.'],
      ['Lost', 'The lighter part: players who reached the step before but not this one. The biggest one is red.'],
      ['Optional', 'Striped: a step players can skip, because a later step has more players. It never counts as a loss.'],
      ['% of start', 'The share of the funnel\'s start that got this far.'],
      ['vs before', 'The share lost since the step before (the last one that isn\'t optional).'],
      ['Stopped here', 'New players whose furthest step this is right now.'],
      ['Left 1st session here', 'New players whose first session ended at this step.'],
    ],
  };
  return [summary, help, ...out];
}
