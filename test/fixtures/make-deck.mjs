// Builds small .slidra decks for tests through the reference writer
// (lib/writer/), so every test deck follows RFC 0001 exactly.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync } from "node:zlib";
import { DeckWriter } from "../../lib/writer/index.js";

export const NS = "https://slidra.app/ns/2026";

/** A slide SVG on the default 1280×720 canvas. `metadata` is inner XML for one `<metadata>` block. */
export function svg(body, { metadata = "", width = 1280, height = 720, attrs = "" } = {}) {
  const meta = metadata ? `<metadata>${metadata}</metadata>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:slidra="${NS}" viewBox="0 0 ${width} ${height}"${attrs}>${meta}${body}</svg>`;
}

/**
 * @param {{ name?: string, canvas?: {width: number, height: number}, slides: string[], files?: Record<string, string | Uint8Array>, project?: object, validate?: boolean }} deck
 *   `slides` are SVG sources; they are stored as slides/001.svg, 002.svg, …
 *   `validate: false` lets a test build a deck that breaks the writer rules on purpose.
 * @returns {Uint8Array} the deck file's bytes
 */
export function makeDeck({ name = "Test deck", canvas = { width: 1280, height: 720 }, slides, files = {}, project = {}, validate = true }) {
  const writer = new DeckWriter({ name, canvas, ...project });
  for (const source of slides) writer.addSlide(source);
  for (const [entry, data] of Object.entries(files)) writer.addFile(entry, data);
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-deck-"));
  const file = path.join(dir, "deck.slidra");
  try {
    writer.write(file, { validate });
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A legacy formatVersion 5 deck (spec §1.2): what makeDeck builds, with
 * project.json and user_version moved back to 5. Writers never produce one.
 * @param {Parameters<typeof makeDeck>[0]} deck
 * @returns {Uint8Array}
 */
export function makeLegacyDeck(deck) {
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-legacy-"));
  const file = path.join(dir, "deck.slidra");
  try {
    writeFileSync(file, makeDeck(deck));
    const db = new DatabaseSync(file);
    const row = /** @type {{ data: Uint8Array }} */ (db.prepare("SELECT data FROM content WHERE path = 'project.json'").get());
    const project = JSON.parse(Buffer.from(row.data).toString("utf8"));
    db.prepare("UPDATE content SET data = ? WHERE path = 'project.json'").run(Buffer.from(`${JSON.stringify({ ...project, formatVersion: 5 }, null, 2)}\n`, "utf8"));
    db.exec("PRAGMA user_version = 5");
    db.close();
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A minimal ZIP writer (stored and deflated entries), enough to build a legacy
 * formatVersion 1-4 deck.
 * @param {[name: string, text: string | Uint8Array, deflate?: boolean][]} entries
 * @returns {Uint8Array}
 */
export function zip(entries) {
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
