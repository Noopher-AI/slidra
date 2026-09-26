// Builds small .slidra decks for tests through the reference writer
// (lib/writer/), so every test deck follows RFC 0001 exactly.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
