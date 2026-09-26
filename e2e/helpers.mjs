// Shared steps for the browser tests.

import { expect } from "@playwright/test";

export const SHOWCASE = "/?deck=" + encodeURIComponent("/decks/0/showcase.slidra");
export const MINIMAL = "/?deck=" + encodeURIComponent("/decks/0/minimal.slidra");

/** The live slide frame (its document is replaced on every slide change). */
export async function slideFrame(page) {
  const handle = await page.locator("#slide-frame").elementHandle();
  return handle.contentFrame();
}

/** Evaluates `fn(arg)` inside the current slide's document. */
export async function inSlide(page, fn, arg) {
  const frame = await slideFrame(page);
  return frame.evaluate(fn, arg);
}

/** Computed opacity of the element with `id` in the current slide, as a number. */
export async function opacityOf(page, id) {
  return Number(await inSlide(page, (elementId) => getComputedStyle(document.getElementById(elementId)).opacity, id));
}

export async function expectCounter(page, text) {
  await expect(page.locator("#slide-counter")).toHaveText(text);
}

/** Opens a deck the way a user drops one in: through the file input, bytes never leaving the page. */
export async function openDeckFile(page, bytes, name = "test.slidra") {
  await page.goto("/");
  // The home page is revealed by the viewer script once it has wired its inputs.
  await expect(page.locator("#home")).toBeVisible();
  await page.locator("#file-input").setInputFiles({ name, mimeType: "application/vnd.slidra", buffer: Buffer.from(bytes) });
  await expect(page.locator("#viewer")).toBeVisible();
}

/** Waits until the slide runtime has reported ready for slide `n` (1-based). */
export async function waitForSlide(page, n, total) {
  await expectCounter(page, `${n} / ${total}`);
  await expect.poll(async () => inSlide(page, () => document.readyState)).toBe("complete");
}
