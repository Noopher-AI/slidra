import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeckWriter, WriterError, convertLegacyDeck, editDeck, newElementId, newSlideId, serializeProject } from "../lib/writer/index.js";
import { openDeck } from "../lib/viewer/deck.js";
import { checkProject } from "../lib/schema.js";
import { makeLegacyDeck, svg, zip } from "./fixtures/make-deck.mjs";

const scratch = () => mkdtempSync(path.join(tmpdir(), "slidra-writer-"));
const pragma = (file, name) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare(`PRAGMA ${name}`).get();
  db.close();
  return Object.values(row)[0];
};

test("ids have the spec's shape and are random", () => {
  const ids = new Set(Array.from({ length: 200 }, newElementId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^el-[A-Za-z0-9_-]{12}$/);
  assert.match(newSlideId(), /^s-[A-Za-z0-9_-]{12}$/);
});

test("writes a deck the viewer opens, with the RFC 0001 header and explicit directories", async () => {
  const dir = scratch();
  const file = path.join(dir, "talk.slidra");
  const writer = new DeckWriter({ name: "Talk", author: "Alice", lang: "en" });
  writer.addSlide(svg('<g id="el-AAAAAAAAAAAA"><text>one</text></g>'));
  writer.addSlide(svg("<g/>"));
  writer.addFile("assets/data/sales.csv", "a,b\n1,2\n");
  writer.addDirectory("plan");
  writer.addFont({ file: "fonts/A.ttf", family: "A", license: "OFL-1.1", licenseFile: "fonts/OFL.txt", source: "https://example.com" }, new Uint8Array([1, 2, 3]), "licence text");
  writer.write(file);

  assert.equal(pragma(file, "application_id"), 0x536c6472);
  assert.equal(pragma(file, "user_version"), 6);
  assert.equal(pragma(file, "journal_mode"), "delete");
  const deck = await openDeck(new Uint8Array(readFileSync(file)));
  assert.deepEqual(deck.slides, ["slides/001.svg", "slides/002.svg"]);
  assert.equal(deck.project.author, "Alice");
  assert.deepEqual(checkProject(deck.project), []);
  for (const dir of ["slides", "assets", "assets/data", "fonts", "plan"]) assert.equal(deck.entries.get(dir), null, dir);
  assert.equal(deck.readText("assets/data/sales.csv"), "a,b\n1,2\n");
  assert.deepEqual(
    deck.fonts.map((f) => f.family),
    ["A"],
  );
  assert.deepEqual(readdirSync(dir), ["talk.slidra"], "no temporary file is left behind");
});

test("project.json keeps key order, unknown fields, 2-space indentation and a trailing newline", async () => {
  const dir = scratch();
  const file = path.join(dir, "d.slidra");
  const writer = new DeckWriter({ name: "D", zeta: { kept: true }, alpha: 1 });
  writer.setProject({ description: "later" });
  writer.write(file);
  const text = (await openDeck(new Uint8Array(readFileSync(file)))).readText("project.json");
  assert.equal(text, serializeProject({ formatVersion: 6, name: "D", canvas: { width: 1280, height: 720 }, slides: [], zeta: { kept: true }, alpha: 1, description: "later" }));
  assert.ok(text.endsWith("}\n"));
  assert.match(text, /\n {2}"formatVersion": 6,/);
});

test("refuses unsafe paths and decks that break the writer rules, leaving the old file untouched", () => {
  const writer = new DeckWriter({ name: "x" });
  for (const bad of ["../x", "/abs", "a//b", "a\\b", "./a"]) assert.throws(() => writer.addFile(bad, "x"), WriterError, bad);
  assert.throws(() => writer.addFile("project.json", "{}"), /setProject/);
  assert.throws(() => writer.setProject({ slides: [] }), /managed by the writer/);

  const dir = scratch();
  const file = path.join(dir, "keep.slidra");
  writeFileSync(file, "previous contents");
  const broken = new DeckWriter({ name: "x", created: "yesterday" });
  assert.throws(() => broken.write(file), /created/);
  assert.equal(readFileSync(file, "utf8"), "previous contents");
  assert.deepEqual(readdirSync(dir), ["keep.slidra"]);
});

test("editDeck changes content in place and preserves tables and fields it does not know", async () => {
  const dir = scratch();
  const file = path.join(dir, "e.slidra");
  const writer = new DeckWriter({ name: "Before", future: [1, 2] });
  writer.addSlide(svg("<g/>"));
  writer.write(file);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE undo_history (id INTEGER PRIMARY KEY, op TEXT)");
  db.exec("INSERT INTO undo_history (op) VALUES ('rename')");
  db.close();

  await editDeck(file, (deck) => {
    deck.writeFile("assets/new/logo.svg", "<svg/>");
    deck.updateProject((project) => ({ ...project, name: "After", modified: "2026-09-26T10:00:00Z" }));
  });

  const reopened = await openDeck(new Uint8Array(readFileSync(file)));
  assert.equal(reopened.name, "After");
  assert.deepEqual(reopened.project.future, [1, 2]);
  assert.equal(reopened.readText("assets/new/logo.svg"), "<svg/>");
  assert.equal(reopened.entries.get("assets/new"), null);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(
    check
      .prepare("SELECT op FROM undo_history")
      .all()
      .map((r) => r.op),
    ["rename"],
  );
  check.close();

  await assert.rejects(
    editDeck(file, (deck) => deck.updateProject((project) => ({ ...project, slides: ["slides/404.svg"] }))),
    /no such file/,
  );
  assert.equal((await openDeck(new Uint8Array(readFileSync(file)))).name, "After", "a failed edit changes nothing");
  assert.deepEqual(readdirSync(dir), ["e.slidra"]);
});

test("converts a legacy ZIP deck to formatVersion 6", async () => {
  const dir = scratch();
  const file = path.join(dir, "old.slidra");
  writeFileSync(
    file,
    zip([
      ["project.json", JSON.stringify({ formatVersion: 4, name: "Old", canvas: { width: 800, height: 600 }, slides: ["slides/001.svg"], extra: true }), true],
      ["slides/001.svg", svg("<g/>", { width: 800, height: 600 }), true],
    ]),
  );

  await convertLegacyDeck(file);
  const deck = await openDeck(new Uint8Array(readFileSync(file)));
  assert.equal(deck.container, "sqlite");
  assert.equal(deck.project.formatVersion, 6);
  assert.equal(deck.legacy, false);
  assert.equal(deck.project.extra, true);
  assert.equal(pragma(file, "user_version"), 6);
  for (const dir of ["slides", "assets", "fonts"]) assert.equal(deck.entries.get(dir), null);
  await assert.rejects(convertLegacyDeck(file), /already formatVersion 6/);
});

/** A legacy formatVersion 5 deck on disk, with a vendor field and a table the writer does not know. */
function legacyFile(dir) {
  const file = path.join(dir, "five.slidra");
  writeFileSync(file, makeLegacyDeck({ name: "Five", project: { lang: "en", vendor: { kept: true } }, slides: [svg("<g/>")] }));
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE undo_history (id INTEGER PRIMARY KEY, op TEXT)");
  db.exec("INSERT INTO undo_history (op) VALUES ('typed')");
  db.close();
  return file;
}

test("editing a legacy formatVersion 5 deck upgrades it to 6 in the same transaction", async () => {
  const dir = scratch();
  const file = legacyFile(dir);
  assert.equal(pragma(file, "user_version"), 5);
  await editDeck(file, (deck) => deck.writeFile("assets/note.txt", "hi"));
  assert.equal(pragma(file, "user_version"), 6);
  const deck = await openDeck(new Uint8Array(readFileSync(file)));
  assert.equal(deck.project.formatVersion, 6);
  assert.equal(deck.legacy, false);
  assert.equal(deck.readText("assets/note.txt"), "hi");
  assert.deepEqual(Object.keys(deck.project), ["formatVersion", "name", "canvas", "slides", "lang", "vendor"], "key order is kept");
  assert.deepEqual(deck.project.vendor, { kept: true });
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare("SELECT op FROM undo_history").get().op, "typed", "unknown tables survive");
  db.close();
  assert.deepEqual(readdirSync(dir), ["five.slidra"]);
});

test("a failed edit leaves a legacy deck at formatVersion 5", async () => {
  const dir = scratch();
  const file = legacyFile(dir);
  const before = readFileSync(file);
  await assert.rejects(
    editDeck(file, () => {
      throw new Error("nope");
    }),
    /nope/,
  );
  assert.deepEqual(readFileSync(file), before);
  assert.equal(pragma(file, "user_version"), 5);
});

test("converts a legacy formatVersion 5 deck to 6", async () => {
  const dir = scratch();
  const file = legacyFile(dir);
  const out = path.join(dir, "six.slidra");
  await convertLegacyDeck(file, out);
  assert.equal(pragma(file, "user_version"), 5, "the source is untouched when writing elsewhere");
  assert.equal(pragma(out, "user_version"), 6);
  const deck = await openDeck(new Uint8Array(readFileSync(out)));
  assert.equal(deck.project.formatVersion, 6);
  assert.deepEqual(deck.project.vendor, { kept: true });
  await convertLegacyDeck(file);
  assert.equal(pragma(file, "user_version"), 6, "in place");
  await assert.rejects(convertLegacyDeck(file), /already formatVersion 6/);
  assert.deepEqual(readdirSync(dir).sort(), ["five.slidra", "six.slidra"]);
});
