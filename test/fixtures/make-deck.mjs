// Builds small .slidra decks for tests: a formatVersion 5 SQLite container
// written with node:sqlite (Node >= 22.5), exactly as RFC 0001 lays it out.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const NS = "https://slidra.app/ns/2026";

/** A slide SVG on the default 1280×720 canvas. `metadata` is inner XML for one `<metadata>` block. */
export function svg(body, { metadata = "", width = 1280, height = 720, attrs = "" } = {}) {
  const meta = metadata ? `<metadata>${metadata}</metadata>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:slidra="${NS}" viewBox="0 0 ${width} ${height}"${attrs}>${meta}${body}</svg>`;
}

/**
 * @param {{ name?: string, canvas?: {width: number, height: number}, slides: string[], files?: Record<string, string | Uint8Array>, project?: object }} deck
 *   `slides` are SVG sources; they are stored as slides/001.svg, 002.svg, …
 * @returns {Uint8Array} the deck file's bytes
 */
export function makeDeck({ name = "Test deck", canvas = { width: 1280, height: 720 }, slides, files = {}, project = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-deck-"));
  const file = path.join(dir, "deck.slidra");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA application_id = 1399612530");
  db.exec("PRAGMA user_version = 5");
  db.exec("CREATE TABLE content (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind INTEGER NOT NULL, data BLOB)");
  const insert = db.prepare("INSERT INTO content (path, kind, data) VALUES (?, ?, ?)");
  for (const dir of ["slides", "assets", "fonts"]) insert.run(dir, 1, null);
  const slidePaths = slides.map((_, i) => `slides/${String(i + 1).padStart(3, "0")}.svg`);
  const encode = (value) => (typeof value === "string" ? Buffer.from(value, "utf8") : value);
  slides.forEach((source, i) => insert.run(slidePaths[i], 0, encode(source)));
  for (const [entry, data] of Object.entries(files)) insert.run(entry, 0, encode(data));
  const json = { formatVersion: 5, name, canvas, slides: slidePaths, ...project };
  insert.run("project.json", 0, encode(JSON.stringify(json, null, 2) + "\n"));
  db.close();
  const bytes = new Uint8Array(readFileSync(file));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
