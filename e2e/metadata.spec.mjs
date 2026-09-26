import { test, expect } from "@playwright/test";
import { expectCounter } from "./helpers.mjs";

test("the library shows a deck's author and description and previews its cover slide", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(".deck-card", { hasText: "Quarterly Review" });
  await expect(card).toContainText("2 slides · Alice Chen");
  await expect(card).toHaveAttribute("title", "Numbers for the platform team.");
  const thumb = card.locator(".deck-thumb img");
  await expect(thumb).toHaveAttribute("data-slide", "2");
  await expect.poll(() => thumb.evaluate((img) => /** @type {HTMLImageElement} */ (img).naturalWidth)).toBeGreaterThan(0);
});

test("the viewer shows the author in the title bar and the full metadata in the overview", async ({ page }) => {
  await page.goto("/");
  await page.locator(".deck-card", { hasText: "Quarterly Review" }).click();
  await expectCounter(page, "1 / 2");
  await expect(page.locator("#deck-meta")).toContainText("Alice Chen");
  await page.keyboard.press("g");
  const about = page.locator("#overview-about");
  await expect(about).toContainText("Numbers for the platform team.");
  await expect(about).toContainText("Alice Chen · updated");
  await expect(about).toContainText("#review #Q3");
});
