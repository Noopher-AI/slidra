import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { DEFAULT_LIMITS, DeckError, openDeck } from "../lib/viewer/deck.js";
import { SqliteFormatError, SqliteReader, readVarint } from "../lib/viewer/sqlite-reader.js";
import { ZipFormatError, readZip } from "../lib/viewer/zip-reader.js";
import { makeDeck, svg } from "./fixtures/make-deck.mjs";

/** A one-entry ZIP whose local and central headers declare `declared` bytes for `data` (deflated). */
function zipOne(name, data, declared = data.length) {
  const nameBytes = Buffer.from(name);
  const body = deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + body.length, 16);
  return new Uint8Array(Buffer.concat([local, nameBytes, body, central, nameBytes, end]));
}

test("a zip bomb stops at its declared size instead of inflating", async () => {
  const bomb = zipOne("project.json", Buffer.alloc(8 * 1024 * 1024), 1024);
  await assert.rejects(readZip(bomb), (error) => error instanceof ZipFormatError && /beyond its declared size of 1024/.test(error.message));
  await assert.rejects(openDeck(bomb), DeckError);
});

test("a ZIP entry is checked against the limits by its declared size, before inflating", async () => {
  const big = zipOne("assets/huge.bin", Buffer.alloc(64), 64);
  await assert.rejects(readZip(big, { maxEntries: 10, maxEntryBytes: 32, maxTotalBytes: 1000 }), /more than the limit of 32/);
  await assert.rejects(readZip(big, { maxEntries: 0, maxEntryBytes: 1000, maxTotalBytes: 1000 }), /more than the limit of 0/);
});

test("corrupt deflate data is a ZipFormatError, not a TypeError", async () => {
  const bytes = zipOne("project.json", Buffer.from("{}"));
  bytes[30 + "project.json".length] ^= 0xff;
  bytes[31 + "project.json".length] ^= 0xff;
  await assert.rejects(readZip(bytes), ZipFormatError);
});

test("openDeck enforces the deck size, entry count and entry size limits", async () => {
  const deck = makeDeck({ slides: [svg("<g/>")], files: { "assets/blob.bin": new Uint8Array(4096) } });
  await assert.rejects(openDeck(deck, { limits: { maxDeckBytes: 1000 } }), /more than the 1 KB this viewer opens/);
  await assert.rejects(openDeck(deck, { limits: { maxEntries: 3 } }), /entries, more than the limit of 3/);
  await assert.rejects(openDeck(deck, { limits: { maxEntryBytes: 1024 } }), /assets\/blob\.bin is 4 KB, more than the limit of 1 KB/);
  assert.ok(await openDeck(deck));
  assert.equal(DEFAULT_LIMITS.maxDeckBytes, 1024 * 1024 * 1024);
});

test("the SQLite reader turns out-of-range reads into format errors", () => {
  assert.throws(() => readVarint(Uint8Array.of(0x81, 0x81), 0), /runs past the end/);
  assert.throws(() => readVarint(Uint8Array.of(1), 5), /starts outside/);
  const deck = makeDeck({ slides: [svg("<g/>")] });
  const reserved = new Uint8Array(deck);
  reserved[20] = 255;
  reserved[16] = 0x02;
  reserved[17] = 0x00;
  assert.throws(
    () => new SqliteReader(reserved),
    (error) => error instanceof SqliteFormatError && /reserved space/.test(error.message),
  );
  const pointerOut = new Uint8Array(deck);
  const view = new DataView(pointerOut.buffer);
  // The first cell pointer on page 1 now points past the end of the page.
  view.setUint16(108, 0xfff0);
  assert.throws(() => new SqliteReader(pointerOut).readTable("content"), SqliteFormatError);
});
