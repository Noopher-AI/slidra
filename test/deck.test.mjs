import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { DeckError, isSafeEntryPath, openDeck, readProject } from "../lib/viewer/deck.js";

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

/** A minimal ZIP writer (stored and deflated entries), enough to build a legacy deck. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const size = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

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
  const good = { formatVersion: 5, name: "x", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] };
  assert.equal(readProject(entries(good), "sqlite").name, "x");
  assert.throws(() => readProject(entries({ ...good, formatVersion: 4 }), "sqlite"), /formatVersion 5/);
  assert.throws(() => readProject(entries({ ...good, formatVersion: 5 }), "zip"), /formatVersion 1-4/);
  assert.throws(() => readProject(entries({ ...good, canvas: { width: 0, height: 1 } }), "sqlite"), /canvas/);
  assert.throws(() => readProject(entries({ ...good, slides: ["slides/002.svg"] }), "sqlite"), /no such file/);
  assert.throws(() => readProject(entries({ ...good, slides: ["../etc/passwd"] }), "sqlite"), /invalid slide path/);
  assert.deepEqual(readProject(entries({ ...good, futureField: { a: 1 } }), "sqlite").futureField, { a: 1 }, "unknown fields are kept");
});

test("entry paths may not escape the deck", () => {
  for (const bad of ["/abs", "../x", "a/../b", "a//b", "a\\b", "", "./a"]) assert.equal(isSafeEntryPath(bad), false, bad);
  for (const good of ["project.json", "slides/001.svg", "assets/data/sales-1.csv"]) assert.equal(isSafeEntryPath(good), true, good);
});
