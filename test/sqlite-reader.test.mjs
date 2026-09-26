import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteReader, isSqlite, parseColumns, readVarint } from "../lib/viewer/sqlite-reader.js";

const sqlite = await import("node:sqlite").catch(() => null);

test("readVarint decodes 1-, 2- and 9-byte values", () => {
  assert.deepEqual(readVarint(Uint8Array.of(0x05), 0), [5, 1]);
  assert.deepEqual(readVarint(Uint8Array.of(0x81, 0x00), 0), [128, 2]);
  assert.deepEqual(readVarint(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01), 0)[1], 9);
});

test("parseColumns finds names and the rowid alias", () => {
  const columns = parseColumns('CREATE TABLE content (\n  id INTEGER PRIMARY KEY,\n  "path" TEXT NOT NULL UNIQUE,\n  kind INTEGER NOT NULL, -- 0 = file\n  data BLOB\n)');
  assert.deepEqual(
    columns.map((c) => c.name),
    ["id", "path", "kind", "data"],
  );
  assert.deepEqual(
    columns.map((c) => c.rowidAlias),
    [true, false, false, false],
  );
});

test("rejects bytes that are not SQLite", () => {
  assert.equal(isSqlite(new TextEncoder().encode("PK\u0003\u0004 not sqlite at all")), false);
  assert.throws(() => new SqliteReader(new Uint8Array(200)), /not a SQLite 3 database/);
});

test("reads the showcase deck's content table", () => {
  const bytes = new Uint8Array(readFileSync(new URL("../examples/showcase.slidra", import.meta.url)));
  const db = new SqliteReader(bytes);
  assert.equal(db.userVersion, 6);
  assert.equal(db.applicationId, 0x536c6472);
  const rows = db.readTable("content");
  const byPath = new Map(rows.map((row) => [row.path, row]));
  assert.equal(byPath.get("slides").kind, 1);
  assert.equal(byPath.get("slides").data, null);
  const project = JSON.parse(new TextDecoder().decode(byPath.get("project.json").data));
  assert.equal(project.formatVersion, 6);
  for (const slide of project.slides) assert.ok(byPath.get(slide).data instanceof Uint8Array);
});

test("matches node:sqlite byte-for-byte, including overflow pages and deep b-trees", { skip: !sqlite && "node:sqlite unavailable" }, () => {
  const { DatabaseSync } = sqlite;
  for (const pageSize of [512, 4096, 65536]) {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "slidra-")), "deck.slidra");
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA page_size = ${pageSize}`);
    db.exec("CREATE TABLE content (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind INTEGER NOT NULL, data BLOB)");
    const insert = db.prepare("INSERT INTO content (path, kind, data) VALUES (?, ?, ?)");
    const expected = new Map();
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 400; i++) {
      const size = i % 50 === 0 ? 300000 + (random() % 5000) : random() % 3000;
      const data = new Uint8Array(size);
      for (let j = 0; j < size; j++) data[j] = random() & 0xff;
      const p = `assets/file-${i}-${"x".repeat(i % 40)}.bin`;
      insert.run(p, 0, data);
      expected.set(p, data);
    }
    insert.run("assets", 1, null);
    // Deletions and re-inserts leave free pages and rebalanced interior pages behind.
    const doomed = [...expected.keys()].filter((_, i) => i % 7 === 0);
    for (const p of doomed) {
      db.prepare("DELETE FROM content WHERE path = ?").run(p);
      expected.delete(p);
    }
    db.close();

    const reader = new SqliteReader(new Uint8Array(readFileSync(file)));
    assert.equal(reader.pageSize, pageSize);
    const rows = reader.readTable("content");
    assert.equal(rows.length, expected.size + 1);
    for (const row of rows) {
      if (row.kind === 1) continue;
      assert.deepEqual(row.data, expected.get(row.path), `${row.path} at page size ${pageSize}`);
    }
    const ids = rows.map((row) => row.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
      "rows come back in rowid order",
    );
  }
});
