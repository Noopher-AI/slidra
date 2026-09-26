import { test, expect } from "@playwright/test";
import { MINIMAL, SHOWCASE, expectCounter, opacityOf, waitForSlide } from "./helpers.mjs";

test("the home page lists the example decks by their real names", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator(".deck-card");
  await expect(cards).toHaveCount(2);
  await expect(page.locator(".deck-card strong")).toContainText(["Slides with Coordinates", "Slidra Showcase"]);
});

test("pre-hidden elements start hidden and enter on the first step", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  expect(await opacityOf(page, "el-kicker000000")).toBe(0);
  expect(await opacityOf(page, "el-glow00000000")).toBe(1);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => opacityOf(page, "el-kicker000000")).toBe(1);
  await expect.poll(() => opacityOf(page, "el-subtitle0000")).toBe(1);
});

test("advancing past the last step moves to the next slide, retreating lands on the previous slide's last step", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await waitForSlide(page, 2, 7);
  expect(await opacityOf(page, "el-row000000000")).toBe(0);
  await page.keyboard.press("ArrowLeft");
  await waitForSlide(page, 1, 7);
  await expect.poll(() => opacityOf(page, "el-kicker000000")).toBe(1);
  await expect.poll(() => opacityOf(page, "el-rule00000000")).toBe(1);
});

test("a deep link opens the deck at that slide and the hash follows navigation", async ({ page }) => {
  await page.goto(MINIMAL + "#4");
  await waitForSlide(page, 4, 10);
  await page.keyboard.press("End");
  await waitForSlide(page, 10, 10);
  await expect(page).toHaveURL(/#10$/);
  await page.keyboard.press("Home");
  await waitForSlide(page, 1, 10);
});

test("the overview jumps to a slide", async ({ page }) => {
  await page.goto(MINIMAL);
  await waitForSlide(page, 1, 10);
  await page.keyboard.press("g");
  const overview = page.locator("#overview");
  await expect(overview).toBeVisible();
  await expect(overview.locator(".overview-item")).toHaveCount(10);
  await overview.locator(".overview-item").nth(4).locator("button").click();
  await expect(overview).toBeHidden();
  await expectCounter(page, "5 / 10");
});

test("speaker notes toggle with N and follow the slide", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await page.keyboard.press("n");
  await expect(page.locator("#notes-panel")).toBeVisible();
  await expect(page.locator("#notes-text")).toContainText("Welcome.");
  await page.locator("#next-button").click();
  await page.locator("#next-button").click();
  await waitForSlide(page, 2, 7);
  await expect(page.locator("#notes-text")).toContainText("The container is one SQLite table");
});
