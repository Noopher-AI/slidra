import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { makeDeck, svg } from "../test/fixtures/make-deck.mjs";
import { openDeckFile, waitForSlide } from "./helpers.mjs";

const SLIDES = 60;

test(`a ${SLIDES}-slide deck with a large shared image keeps the overview light`, async ({ page }) => {
  test.setTimeout(150_000);
  const slides = Array.from({ length: SLIDES }, (_, i) => {
    const n = String(i).padStart(9, "0");
    return svg(`<g id="el-IMG${n}"><image href="../assets/photo.bin" width="640" height="360"/></g><g id="el-TXT${n}"><text x="700" y="200" font-size="60">Slide ${i + 1}</text></g>`);
  });
  const deck = makeDeck({ slides, files: { "assets/photo.bin": randomBytes(800_000) } });
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  const heapMb = async () => (await client.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize").value / 1e6;

  await openDeckFile(page, deck);
  await waitForSlide(page, 1, SLIDES);
  await page.keyboard.press("g");
  const grid = page.locator("#overview-grid");
  const loaded = () =>
    page.evaluate(
      () => [...document.querySelectorAll("#overview-grid img")].filter((img) => /** @type {HTMLImageElement} */ (img).complete && /** @type {HTMLImageElement} */ (img).naturalWidth > 0).length,
    );
  // Scroll in small steps so every item passes through view (thumbnails start when they near it) and wait for them all.
  const started = Date.now();
  while ((await loaded()) < SLIDES && Date.now() - started < 90_000) {
    await grid.evaluate((el) => el.scrollBy(0, 300));
    await page.waitForTimeout(300);
  }
  expect(await loaded()).toBe(SLIDES);

  // Thumbnails are PNG images, not frames holding every inlined asset.
  expect(await page.locator("#overview-grid iframe").count()).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll("#overview-grid img")].every((img) => /** @type {HTMLImageElement} */ (img).src.startsWith("blob:")))).toBe(true);
  await client.send("HeapProfiler.collectGarbage");
  expect(await heapMb()).toBeLessThan(80);

  // Jumping from the overview still plays the slide.
  await grid
    .locator(".overview-item")
    .nth(SLIDES - 1)
    .locator("button")
    .click();
  await waitForSlide(page, SLIDES, SLIDES);
});
