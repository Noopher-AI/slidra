import { test, expect } from "@playwright/test";
import { MINIMAL, SHOWCASE, expectCounter, waitForSlide } from "./helpers.mjs";

test("B blacks out the screen; the next key restores it without moving", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  const blank = page.locator("#blank");
  await page.keyboard.press("b");
  await expect(blank).toBeVisible();
  await expect(blank).toHaveClass(/is-black/);
  await page.keyboard.press("ArrowRight");
  await expect(blank).toBeHidden();
  await expectCounter(page, "1 / 7");
  await expect(page.locator("#step-dots i.on")).toHaveCount(0);

  await page.keyboard.press(",");
  await expect(blank).toHaveClass(/is-white/);
  await blank.click();
  await expect(blank).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#step-dots i.on")).toHaveCount(1, { timeout: 5000 });
});

test("typing a slide number and Enter jumps there, from the slide or from the controls", async ({ page }) => {
  await page.goto(MINIMAL);
  await waitForSlide(page, 1, 10);
  await page.keyboard.type("7");
  await expect(page.locator("#goto")).toContainText("Go to slide 7");
  await page.keyboard.press("Enter");
  await waitForSlide(page, 7, 10);
  await expect(page.locator("#goto")).toBeHidden();

  // Focus on the host (a control) rather than the slide frame.
  await page.locator("#overview-button").focus();
  await page.keyboard.type("12");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await waitForSlide(page, 1, 10);

  await page.keyboard.type("99");
  await page.keyboard.press("Enter");
  await waitForSlide(page, 10, 10);

  await page.keyboard.type("3");
  await page.keyboard.press("Escape");
  await expect(page.locator("#goto")).toBeHidden();
  await expect(page.locator("#viewer")).toBeVisible();
  await expectCounter(page, "10 / 10");
});

test("? lists the keys; Esc closes the list, not the deck", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await page.keyboard.press("?");
  const help = page.locator("#key-help");
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(help).toContainText("Black screen");
  await page.keyboard.press("ArrowRight");
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(page.locator("#viewer")).toBeVisible();
  await expectCounter(page, "1 / 7");
});
