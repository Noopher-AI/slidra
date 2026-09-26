import { test, expect } from "@playwright/test";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { SHOWCASE, expectCounter, openDeckFile, waitForSlide } from "./helpers.mjs";

async function openPresenter(page) {
  const popupPromise = page.waitForEvent("popup");
  await page.keyboard.press("p");
  const presenter = await popupPromise;
  await presenter.waitForLoadState();
  await expect(presenter.locator("#p-status")).toBeHidden();
  return presenter;
}

test("P opens a presenter view that follows the audience window and drives it", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await page.keyboard.press("n");
  await expect(page.locator("#notes-panel")).toBeVisible();

  const presenter = await openPresenter(page);
  await expect(presenter.locator("#p-title")).toHaveText("Slidra Showcase");
  await expect(presenter.locator("#p-counter")).toHaveText("Slide 1 of 7 · step 0 of 1");
  await expect(presenter.locator("#p-notes")).toContainText("Welcome.");
  await expect(presenter.locator("#p-next-label")).toContainText("Step 1 of 1 on this slide");
  await expect(presenter.locator("#p-elapsed")).toHaveText(/^\d\d:\d\d$/);

  // The audience surface never shows notes while the presenter view is open.
  await expect(page.locator("#notes-panel")).toBeHidden();
  await expect(page.locator("#notes-button")).toBeDisabled();

  // Advancing in the audience window moves the presenter view.
  await page.keyboard.press("ArrowRight");
  await expect(presenter.locator("#p-counter")).toHaveText("Slide 1 of 7 · step 1 of 1");
  await expect(presenter.locator("#p-next-label")).toContainText("Slide 2");
  await expect(presenter.locator("#p-next-image")).toBeVisible();

  // Keys and buttons in the presenter view drive the audience window.
  await presenter.keyboard.press("ArrowRight");
  await expectCounter(page, "2 / 7");
  await expect(presenter.locator("#p-counter")).toHaveText("Slide 2 of 7 · step 0 of 4");
  await expect(presenter.locator("#p-notes")).toContainText("The container is one SQLite table");
  await presenter.locator("#p-previous").click();
  await expectCounter(page, "1 / 7");
  await presenter.keyboard.type("5");
  await presenter.keyboard.press("Enter");
  await expectCounter(page, "5 / 7");
  await expect(presenter.locator("#p-counter")).toHaveText(/^Slide 5 of 7/);

  // G and N in the presenter view do nothing to the audience screen.
  await presenter.keyboard.press("g");
  await expect(page.locator("#overview")).toBeHidden();

  // The timer pauses.
  await presenter.locator("#p-pause").click();
  await expect(presenter.locator("#p-pause")).toHaveText("Resume");
  const paused = await presenter.locator("#p-elapsed").textContent();
  await presenter.waitForTimeout(1200);
  await expect(presenter.locator("#p-elapsed")).toHaveText(paused);

  // Closing the deck tells the presenter view.
  await page.locator("#close-button").click();
  await expect(presenter.locator("#p-status")).toContainText("closed this deck");
});

test("a dropped file reaches the presenter view too, its copy stays silent, and closing it frees the notes", async ({ page }) => {
  const deck = makeDeck({
    slides: [svg('<g id="el-AAAAAAAAAAAA"><text x="100" y="100">local</text></g>', { metadata: `<slidra:notes xmlns:slidra="${NS}">Only on my laptop.</slidra:notes>` })],
  });
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 1);
  const presenter = await openPresenter(page);
  await expect(presenter.locator("#p-notes")).toHaveText("Only on my laptop.");
  await expect(presenter.locator("#p-next-label")).toHaveText("End of the presentation.");
  const frameHandle = await presenter.locator("#p-frame").elementHandle();
  const frame = await frameHandle.contentFrame();
  await expect.poll(() => frame.evaluate(() => document.readyState)).toBe("complete");
  expect(await frame.evaluate(() => window["__SLIDRA_PLAN__"].muted)).toBe(true);
  expect(await page.evaluate(() => document.getElementById("slide-frame").getAttribute("srcdoc").includes('\\"muted\\":false'))).toBe(true);
  await presenter.close();
  await expect(page.locator("#notes-button")).toBeEnabled();
});

test("the presenter page on its own explains how to open it", async ({ page }) => {
  await page.goto("/presenter");
  await expect(page.locator("#p-status")).toContainText("press P in the viewer");
});
