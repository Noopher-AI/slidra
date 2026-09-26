import { test } from "node:test";
import assert from "node:assert/strict";
import { PER_PAGE, hiddenAfterStep, printEntries } from "../lib/viewer/print.js";

const plan = {
  hidden: ["a", "b"],
  steps: [
    {
      effects: [
        { target: "a", family: "enter" },
        { target: "c", family: "emphasis" },
      ],
    },
    {
      effects: [
        { target: "b", family: "enter" },
        { target: "a", family: "exit" },
      ],
    },
    { effects: [{ target: "d", family: "path" }] },
  ],
};

test("hidden elements after each step: entrances show, exits hide, the rest stay at rest (playback §8)", () => {
  assert.deepEqual([...hiddenAfterStep(plan, -1)], ["a", "b"]);
  assert.deepEqual([...hiddenAfterStep(plan, 0)], ["b"]);
  assert.deepEqual([...hiddenAfterStep(plan, 1)].sort(), ["a"]);
  assert.deepEqual([...hiddenAfterStep(plan, 2)], ["a"]);
  assert.deepEqual([...hiddenAfterStep(plan, 99)], ["a"]);
});

test("pages: one per slide, or one per step (a slide without steps still prints once)", () => {
  const slides = [{ plan }, { plan: { hidden: [], steps: [] } }, { plan: null }];
  assert.deepEqual(printEntries(slides, { steps: false }), [
    { index: 0, step: null },
    { index: 1, step: null },
    { index: 2, step: null },
  ]);
  assert.deepEqual(printEntries(slides, { steps: true }), [
    { index: 0, step: 0 },
    { index: 0, step: 1 },
    { index: 0, step: 2 },
    { index: 1, step: null },
    { index: 2, step: null },
  ]);
  assert.deepEqual(PER_PAGE, { slides: 1, "handout-2": 2, "handout-3": 3, "handout-6": 6 });
});
