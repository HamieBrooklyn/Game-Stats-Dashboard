// The Funnels tab's presentation (src/present.js): drops, optional steps and the summary. It never changes a
// number from funnels.js, which the parity test checks against the in-game panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseSteps, presentFunnels } from '../src/present.js';

const steps = (...values) => values.map((Value, index) => ({ Order: index + 1, Label: `Step${index + 1}`, Value }));

test('drops are measured between steps in the main path, and the biggest is marked', () => {
  const { steps: list, summary } = analyseSteps(steps(100, 90, 40, 35));
  assert.deepEqual(list.map((step) => step.Lost), [undefined, 10, 50, 5]);
  assert.equal(list[2].Rate, 50 / 90);
  assert.deepEqual(list.map((step) => Boolean(step.Biggest)), [false, false, true, false]);
  assert.deepEqual({ Start: summary.Start, End: summary.End, Overall: summary.Overall, Small: summary.Small }, { Start: 100, End: 35, Overall: 0.35, Small: false });
  assert.equal(list[0].Label, 'Step 1');
});

test('a step that a later step beats is optional, and is never a drop', () => {
  // Real Roll a Car Show onboarding events: after the tutorial, steps can be done in any order
  const { steps: list } = analyseSteps(steps(1775, 1689, 1580, 1537, 1448, 1353, 1353, 152, 423, 551, 528, 486, 488, 248));
  assert.deepEqual(list.filter((step) => step.Optional).map((step) => step.Order), [8, 9, 12]);
  const biggest = list.find((step) => step.Biggest);
  assert.equal(biggest.Order, 10); // tutorial complete -> achievements open, not the daily reward dip
  assert.equal(list[biggest.From].Order, 7);
  assert.equal(biggest.Lost, 1353 - 551);
});

test('empty and tiny funnels', () => {
  assert.equal(analyseSteps(steps(0, 0, 0)).summary.Biggest, null);
  assert.equal(analyseSteps(steps(8, 3)).summary.Small, true);
  assert.equal(analyseSteps([]).summary.Overall, null);
});

test('funnel cards get their description and table, and the summary ranks drops', () => {
  const funnels = [
    { Id: 'Onboarding', Title: 'Onboarding', Kind: 'Once', Description: '', Steps: [] },
    { Id: 'Shop', Title: 'Shop', Kind: 'Repeat', Steps: [] },
  ];
  const widgets = [
    { Type: 'Text', Text: 'legend' },
    { Type: 'Section', Title: 'Onboarding' },
    { Type: 'Text', Text: '' },
    { Type: 'Funnel', Title: 'Onboarding: players who reached each step', Steps: steps(100, 20) },
    { Type: 'Table', Title: 'Onboarding: every step', Columns: [{ Name: 'Step' }, { Name: 'Of start' }], Rows: [] },
    { Type: 'Section', Title: 'Repeat funnels' },
    { Type: 'Funnel', Title: 'Shop: players a day at each step (added up)', Steps: steps(50, 45) },
  ];
  const out = presentFunnels(widgets, { funnels, notes: { Onboarding: 'First minutes.' }, rangeLabel: 'last 7 days' });
  assert.equal(out[0].Type, 'Drops');
  assert.deepEqual(out[0].Items.map((item) => [item.Funnel, item.Lost]), [['Onboarding', 80], ['Shop', 5]]);
  const cards = out.filter((widget) => widget.Type === 'Funnel');
  assert.deepEqual(cards.map((card) => [card.Title, card.Description, card.Unit]), [
    ['Onboarding', 'First minutes.', 'players'],
    ['Shop', 'Every attempt counts, and each player is counted once a day at each step.', 'player-days'],
  ]);
  assert.deepEqual(cards[0].Table.Columns.map((column) => column.Name), ['Step', '% of start']);
  assert.ok(!out.some((widget) => widget.Type === 'Table'));
  assert.ok(!out.some((widget) => widget.Text === 'legend'));
  // the numbers are the ones funnels.js built
  assert.deepEqual(cards[0].Steps.map((step) => step.Value), [100, 20]);
});
