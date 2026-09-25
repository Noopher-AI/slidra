import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DeckError, isSafeEntryPath, openDeck, readProject } from "../public/js/deck.js";

const load = (name) => new Uint8Array(readFileSync(new URL(`../examples/${name}`, import.meta.url)));

test("opens the SQLite showcase deck", async () => {
  const deck = await openDeck(load("showcase.slidra"), { fileName: "showcase.slidra" });
  assert.equal(deck.container, "sqlite");
  assert.equal(deck.name, "Slidra Showcase");
  assert.deepEqual(deck.canvas, { width: 1280, height: 720 });
  assert.ok(deck.slides.length >= 6);
  assert.equal(deck.fonts[0].family, "Noto Sans TC");
  assert.match(deck.dataUrl("assets/intro.webm"), /^data:video\/webm;base64,/);
  assert.match(deck.readText(deck.slides[0]), /^<svg/);
});

test("opens a legacy ZIP deck", async () => {
  const deck = await openDeck(load("legacy-zip-v4.slidra"));
  assert.equal(deck.container, "zip");
  assert.equal(deck.project.formatVersion, 4);
  assert.match(deck.readText("slides/001.svg"), /legacy ZIP deck/);
});

test("rejects files that are neither container", async () => {
  await assert.rejects(openDeck(new TextEncoder().encode("hello world, not a deck")), DeckError);
});

test("validates project.json", () => {
  const entries = (json) => new Map([["project.json", new TextEncoder().encode(JSON.stringify(json))], ["slides/001.svg", new Uint8Array(1)]]);
  const good = { formatVersion: 5, name: "x", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] };
  assert.equal(readProject(entries(good), "sqlite").name, "x");
  assert.throws(() => readProject(entries({ ...good, formatVersion: 4 }), "sqlite"), /formatVersion 5/);
  assert.throws(() => readProject(entries({ ...good, formatVersion: 5 }), "zip"), /formatVersion 1-4/);
  assert.throws(() => readProject(entries({ ...good, canvas: { width: 0, height: 1 } }), "sqlite"), /canvas/);
  assert.throws(() => readProject(entries({ ...good, slides: ["slides/002.svg"] }), "sqlite"), /no such file/);
  assert.throws(() => readProject(entries({ ...good, slides: ["../etc/passwd"] }), "sqlite"), /invalid slide path/);
  assert.equal(readProject(entries({ ...good, futureField: { a: 1 } }), "sqlite").futureField.a, 1, "unknown fields are kept");
});

test("entry paths may not escape the deck", () => {
  for (const bad of ["/abs", "../x", "a/../b", "a//b", "a\\b", "", "./a"]) assert.equal(isSafeEntryPath(bad), false, bad);
  for (const good of ["project.json", "slides/001.svg", "assets/data/sales-1.csv"]) assert.equal(isSafeEntryPath(good), true, good);
});
