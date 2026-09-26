import { test } from "node:test";
import assert from "node:assert/strict";
import { FORWARDED_KEYS, catchUp, formatElapsed, isSessionId, newSessionId, nextPosition, readPosition } from "../lib/viewer/presenter-link.js";

test("session ids are 24 hex characters and unguessable", () => {
  const ids = new Set(Array.from({ length: 100 }, newSessionId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.ok(isSessionId(id), id);
  for (const bad of ["", "abc", "../x", "Z".repeat(24), null]) assert.equal(isSessionId(bad), false);
});

test("position messages are read for shape only", () => {
  assert.deepEqual(readPosition({ type: "position", index: 2, step: -1, total: 5, extra: "x" }), { index: 2, step: -1, total: 5 });
  for (const bad of [
    null,
    {},
    { type: "position", index: "2", step: 0, total: 5 },
    { type: "position", index: 5, step: 0, total: 5 },
    { type: "position", index: 0, step: -2, total: 5 },
    { type: "key", index: 0, step: 0, total: 1 },
  ]) {
    assert.equal(readPosition(bad), null, JSON.stringify(bad));
  }
});

test("the presenter's copy plays a single step forward and jumps otherwise", () => {
  assert.deepEqual(catchUp({ index: 3, step: 1 }, { index: 3, step: 1 }), { kind: "none" });
  assert.deepEqual(catchUp({ index: 3, step: 1 }, { index: 3, step: 2 }), { kind: "advance" });
  assert.deepEqual(catchUp({ index: 3, step: 1 }, { index: 3, step: 0 }), { kind: "show", index: 3, step: 0 });
  assert.deepEqual(catchUp({ index: 3, step: 1 }, { index: 4, step: -1 }), { kind: "show", index: 4, step: -1 });
  assert.deepEqual(catchUp({ index: 3, step: 1 }, { index: 3, step: 3 }), { kind: "show", index: 3, step: 3 });
});

test("next is the rest of the slide, then the next slide, then the end", () => {
  assert.deepEqual(nextPosition({ index: 0, step: -1, stepCount: 2, total: 3 }), { kind: "step", index: 0, step: 0, steps: 2 });
  assert.deepEqual(nextPosition({ index: 0, step: 1, stepCount: 2, total: 3 }), { kind: "slide", index: 1 });
  assert.deepEqual(nextPosition({ index: 2, step: -1, stepCount: 0, total: 3 }), { kind: "end" });
});

test("elapsed time reads like a stopwatch", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(65_400), "01:05");
  assert.equal(formatElapsed(3_725_000), "1:02:05");
  assert.equal(formatElapsed(-5), "00:00");
});

test("the presenter view cannot open panels on the audience screen", () => {
  for (const key of ["g", "G", "n", "N", "?", "f", "F", "o"]) assert.equal(FORWARDED_KEYS.includes(key), false, key);
});
