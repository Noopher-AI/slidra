// The feature tour decks in examples/ play from start to end, and their
// interactive parts (triggers, links, morph) work in the viewer.

import { test, expect } from "@playwright/test";
import { expectCounter, opacityOf, waitForSlide } from "./helpers.mjs";

const deckUrl = (name) => `/?deck=${encodeURIComponent(`/decks/0/${name}.slidra`)}`;

for (const [name, total] of [
  ["motion", 10],
  ["sharing", 9],
]) {
  test(`${name}.slidra plays from the first step to the last without an error`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(deckUrl(name));
    await waitForSlide(page, 1, total);
    // Advance until the last slide's last step: the Next button is disabled there.
    for (let presses = 0; presses < 80 && !(await page.locator("#next-button").isDisabled()); presses++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(350);
    }
    await expectCounter(page, `${total} / ${total}`);
    await expect(page.locator(".toast")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("motion: the quiz answers are triggers and the slide stays put", async ({ page }) => {
  await page.goto(`${deckUrl("motion")}#6`);
  await waitForSlide(page, 6, 10);
  expect(await opacityOf(page, "el-qsqlyes00000")).toBe(0);
  const frame = page.locator("#slide-frame");
  const box = await frame.boundingBox();
  // The "SQLite" answer sits at (96, 380)–(396, 470) on the slide.
  await frame.click({ position: { x: (240 / 1280) * box.width, y: (425 / 720) * box.height } });
  await expect.poll(() => opacityOf(page, "el-qsqlyes00000")).toBe(1);
  expect(await opacityOf(page, "el-qzipno000000")).toBe(0);
  await expectCounter(page, "6 / 10");
});

test("sharing: agenda rows link to their slides and back", async ({ page }) => {
  await page.goto(`${deckUrl("sharing")}#2`);
  await waitForSlide(page, 2, 9);
  const frame = page.locator("#slide-frame");
  const box = await frame.boundingBox();
  const at = (x, y) => ({ position: { x: (x / 1280) * box.width, y: (y / 720) * box.height } });
  // Row 04 (the presenter view) is at y 416–474.
  await frame.click(at(640, 445));
  await waitForSlide(page, 6, 9);
  // "← Agenda" sits at the top right of every linked slide.
  await frame.click(at(1070, 84));
  await waitForSlide(page, 2, 9);
});

test("sharing: the remote logo waits for consent", async ({ page, context }) => {
  const requests = [];
  await context.route("https://github.com/**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${deckUrl("sharing")}#7`);
  await waitForSlide(page, 7, 9);
  await expect(page.locator("#remote-notice")).toContainText("1 item from the internet (github.com)");
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
  await page.locator("#remote-allow").click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
});
