import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeDeck, makeLegacyDeck, svg, zip } from "../test/fixtures/make-deck.mjs";
import { inSlide, openDeckFile, waitForSlide } from "./helpers.mjs";

const words = (id, text) => `<g id="${id}"><text x="100" y="360" font-size="80">${text}</text></g>`;
const slideText = (page) => inSlide(page, () => document.querySelector("text")?.textContent);

test("formatVersion 6 and the legacy decks (5 in SQLite, 1-4 in ZIP) all open and play", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  const legacyZip = zip([
    ["project.json", JSON.stringify({ formatVersion: 4, name: "Four", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }), true],
    ["slides/001.svg", svg(words("el-four0000000", "a formatVersion 4 deck")), true],
  ]);
  /** @type {[string, Uint8Array, string][]} */
  const decks = [
    ["six", makeDeck({ slides: [svg(words("el-six00000000", "a formatVersion 6 deck"))] }), "a formatVersion 6 deck"],
    ["five", makeLegacyDeck({ slides: [svg(words("el-five0000000", "a formatVersion 5 deck"))] }), "a formatVersion 5 deck"],
    ["four", legacyZip, "a formatVersion 4 deck"],
  ];
  for (const [name, bytes, text] of decks) {
    await openDeckFile(page, bytes, `${name}.slidra`);
    await waitForSlide(page, 1, 1);
    expect(await slideText(page)).toBe(text);
  }
  expect(errors).toEqual([]);
});

test("a formatVersion this format does not define ends in a message", async ({ page }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-e2e-v7-"));
  const file = path.join(dir, "seven.slidra");
  let bytes;
  try {
    writeFileSync(file, makeDeck({ slides: [svg(words("el-seven000000", "seven"))] }));
    const db = new DatabaseSync(file);
    const row = /** @type {{ data: Uint8Array }} */ (db.prepare("SELECT data FROM content WHERE path = 'project.json'").get());
    db.prepare("UPDATE content SET data = ? WHERE path = 'project.json'").run(Buffer.from(Buffer.from(row.data).toString("utf8").replace('"formatVersion": 6', '"formatVersion": 7'), "utf8"));
    db.exec("PRAGMA user_version = 7");
    db.close();
    bytes = readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await page.goto("/");
  await expect(page.locator("#home")).toBeVisible();
  await page.locator("#file-input").setInputFiles({ name: "seven.slidra", mimeType: "application/vnd.slidra", buffer: bytes });
  await expect(page.locator(".toast").first()).toContainText("must be formatVersion 6");
  await expect(page.locator("#viewer")).toBeHidden();
});
