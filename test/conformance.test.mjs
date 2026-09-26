import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CASES, manifest } from "../conformance/cases.mjs";
import { compareVerdict, evaluateDeck } from "../lib/conformance.js";
import { isSqlite } from "../lib/viewer/sqlite-reader.js";

const committed = JSON.parse(readFileSync(new URL("../conformance/manifest.json", import.meta.url), "utf8"));
const deckBytes = (file) => new Uint8Array(readFileSync(new URL(`../conformance/${file}`, import.meta.url)));

test("manifest.json is what conformance/cases.mjs describes", () => {
  assert.deepEqual(committed, manifest(), "run: node --no-warnings tools/build-conformance.mjs");
});

/** A container's meaningful content: the header pragmas and every table's rows (SQLite), or the bytes themselves. */
function contentOf(bytes) {
  if (!isSqlite(bytes)) return { raw: Buffer.from(bytes).toString("base64") };
  const file = path.join(mkdtempSync(path.join(tmpdir(), "slidra-conf-")), "d.slidra");
  writeFileSync(file, bytes);
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  const content = {
    applicationId: Object.values(db.prepare("PRAGMA application_id").get())[0],
    userVersion: Object.values(db.prepare("PRAGMA user_version").get())[0],
    tables: Object.fromEntries(
      tables.map((name) => [
        name,
        db
          .prepare(`SELECT * FROM "${name}" ORDER BY 1`)
          .all()
          .map((row) => JSON.stringify(row, (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))),
      ]),
    ),
  };
  db.close();
  return content;
}

test("every committed deck matches its case's builder", () => {
  for (const item of CASES) assert.deepEqual(contentOf(deckBytes(`decks/${item.id}.slidra`)), contentOf(item.build()), item.id);
});

for (const item of committed.cases) {
  test(`reference reader: ${item.id} (${item.rule})`, async () => {
    const problems = compareVerdict(item.expect, await evaluateDeck(deckBytes(item.file), item.file));
    assert.deepEqual(problems, [], item.description);
  });
}

test("compareVerdict reports what differs", () => {
  assert.deepEqual(compareVerdict({ open: "reject" }, { open: "reject", reason: "x" }), []);
  assert.match(compareVerdict({ open: "accept", slides: [] }, { open: "reject", reason: "bad header" })[0], /accepted, but it was rejected \(bad header\)/);
  const verdict = /** @type {any} */ ({ open: "accept", slides: [{ status: "ok", steps: 2, hidden: [], error: null }] });
  assert.deepEqual(compareVerdict({ open: "accept", slides: [{ steps: 3 }] }, verdict), ["slide 1: expected steps 3, got 2"]);
  assert.deepEqual(compareVerdict({ open: "accept", slides: [{}, {}] }, verdict), ["expected 2 slides, found 1"]);
});
