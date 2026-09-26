// Writes the decks the browser tests need served from the library (the
// server lists e2e/.generated/ next to examples/; see playwright.config.mjs).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { makeDeck, svg } from "../test/fixtures/make-deck.mjs";

export const GENERATED = new URL("./.generated/", import.meta.url);

export default function globalSetup() {
  rmSync(GENERATED, { recursive: true, force: true });
  mkdirSync(GENERATED, { recursive: true });
  const text = (id, words, fill = "#111") => `<g id="${id}"><text x="100" y="360" font-size="80" fill="${fill}">${words}</text></g>`;
  writeFileSync(
    new URL("metadata.slidra", GENERATED),
    makeDeck({
      name: "Quarterly Review",
      slides: [svg(text("el-first0000000", "First slide")), svg(text("el-cover0000000", "The cover slide", "#c8233b"))],
      project: {
        author: "Alice Chen",
        created: "2026-09-01T09:00:00Z",
        modified: "2026-09-20T17:45:00+08:00",
        description: "Numbers for the platform team.",
        keywords: ["review", "Q3"],
        cover: "slides/002.svg",
      },
    }),
  );
}
