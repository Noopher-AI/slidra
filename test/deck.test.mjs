import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DeckError, FORMAT_VERSION, isSafeEntryPath, openDeck, readProject } from "../lib/viewer/deck.js";
import { makeDeck, makeLegacyDeck, svg, zip } from "./fixtures/make-deck.mjs";

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

test("opens a legacy ZIP deck (formatVersion 4)", async () => {
  const project = JSON.stringify({ formatVersion: 4, name: "Legacy", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] });
  const deck = await openDeck(
    zip([
      ["project.json", project, false],
      ["slides/001.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text>legacy ZIP deck</text></svg>', true],
    ]),
  );
  assert.equal(deck.container, "zip");
  assert.equal(deck.project.formatVersion, 4);
  assert.match(deck.readText("slides/001.svg"), /legacy ZIP deck/);
  assert.equal(deck.entries.get("slides"), null, "parent directories are implied");
  assert.equal(deck.legacy, true);
});

test("a deck the writer builds is formatVersion 6, not legacy", async () => {
  assert.equal(FORMAT_VERSION, 6);
  const deck = await openDeck(makeDeck({ slides: [svg("<g/>")] }));
  assert.equal(deck.container, "sqlite");
  assert.equal(deck.project.formatVersion, 6);
  assert.equal(deck.legacy, false);
});

test("opens a legacy SQLite deck (formatVersion 5) read-only, as legacy", async () => {
  const deck = await openDeck(makeLegacyDeck({ name: "Five", slides: [svg("<g/>")] }));
  assert.equal(deck.container, "sqlite");
  assert.equal(deck.project.formatVersion, 5);
  assert.equal(deck.legacy, true);
  assert.equal(deck.name, "Five");
});

test("rejects a formatVersion this format does not define", async () => {
  const project = (formatVersion) => new TextEncoder().encode(JSON.stringify({ formatVersion, name: "x", canvas: { width: 1280, height: 720 }, slides: [] }));
  for (const version of [0, 4, 7, 99]) {
    assert.throws(() => readProject(new Map([["project.json", project(version)]]), "sqlite"), /formatVersion 6 \(or legacy 5\)/, String(version));
  }
});

test("rejects a ZIP deck claiming formatVersion 5", async () => {
  const project = JSON.stringify({ formatVersion: 5, name: "x", canvas: { width: 1280, height: 720 }, slides: [] });
  await assert.rejects(openDeck(zip([["project.json", project, true]])), /formatVersion 1-4/);
});

test("the minimal example is a full light-theme deck", async () => {
  const deck = await openDeck(load("minimal.slidra"));
  assert.equal(deck.slides.length, 10);
  assert.equal(deck.fonts[0].family, "Noto Sans TC");
  for (const slide of deck.slides) assert.match(deck.readText(slide), /<slidra:effects/);
});

test("rejects files that are neither container", async () => {
  await assert.rejects(openDeck(new TextEncoder().encode("hello world, not a deck")), DeckError);
});

test("validates project.json", () => {
  const entries = (json) =>
    new Map([
      ["project.json", new TextEncoder().encode(JSON.stringify(json))],
      ["slides/001.svg", new Uint8Array(1)],
    ]);
  const good = { formatVersion: 6, name: "x", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] };
  assert.equal(readProject(entries(good), "sqlite").name, "x");
  assert.equal(readProject(entries({ ...good, formatVersion: 5 }), "sqlite").formatVersion, 5, "legacy SQLite");
  assert.throws(() => readProject(entries({ ...good, formatVersion: 4 }), "sqlite"), /formatVersion 6/);
  assert.throws(() => readProject(entries({ ...good, formatVersion: 7 }), "sqlite"), /formatVersion 6/);
  assert.throws(() => readProject(entries({ ...good, formatVersion: 5 }), "zip"), /formatVersion 1-4/);
  assert.throws(() => readProject(entries({ ...good, formatVersion: 6 }), "zip"), /formatVersion 1-4/);
  assert.throws(() => readProject(entries({ ...good, canvas: { width: 0, height: 1 } }), "sqlite"), /canvas/);
  assert.throws(() => readProject(entries({ ...good, slides: ["slides/002.svg"] }), "sqlite"), /no such file/);
  assert.throws(() => readProject(entries({ ...good, slides: ["../etc/passwd"] }), "sqlite"), /invalid slide path/);
  assert.deepEqual(readProject(entries({ ...good, futureField: { a: 1 } }), "sqlite").futureField, { a: 1 }, "unknown fields are kept");
});

test("entry paths may not escape the deck", () => {
  for (const bad of ["/abs", "../x", "a/../b", "a//b", "a\\b", "", "./a"]) assert.equal(isSafeEntryPath(bad), false, bad);
  for (const good of ["project.json", "slides/001.svg", "assets/data/sales-1.csv"]) assert.equal(isSafeEntryPath(good), true, good);
});
