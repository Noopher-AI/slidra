import { test } from "node:test";
import assert from "node:assert/strict";
import { deckInfo } from "../lib/viewer/deck.js";

const base = { formatVersion: 6, name: "Deck", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg", "slides/002.svg"] };

test("reads every metadata field", () => {
  const info = deckInfo({
    ...base,
    author: " Alice Chen ",
    created: "2026-09-01T09:00:00Z",
    modified: "2026-09-20T17:45:00.5+08:00",
    description: "Numbers.",
    keywords: ["review", " Q3 ", ""],
    cover: "slides/002.svg",
  });
  assert.equal(info.author, "Alice Chen");
  assert.equal(info.created.toISOString(), "2026-09-01T09:00:00.000Z");
  assert.equal(info.modified.toISOString(), "2026-09-20T09:45:00.500Z");
  assert.equal(info.description, "Numbers.");
  assert.deepEqual(info.keywords, ["review", "Q3"]);
  assert.equal(info.cover, 1);
  assert.deepEqual(info.problems, []);
});

test("defaults when the fields are absent", () => {
  assert.deepEqual(deckInfo(base), { author: null, created: null, modified: null, description: null, keywords: [], cover: 0, problems: [] });
});

test("ignores ill-typed values and reports them, never throwing", () => {
  const info = deckInfo({ ...base, author: 42, created: "yesterday", modified: "2026-09-20", keywords: "review", cover: "slides/009.svg", description: ["x"] });
  assert.equal(info.author, null);
  assert.equal(info.created, null);
  assert.equal(info.modified, null, "a date without a time is not an RFC 3339 date-time");
  assert.deepEqual(info.keywords, []);
  assert.equal(info.cover, 0);
  assert.equal(info.description, null);
  assert.equal(info.problems.length, 6);
});
