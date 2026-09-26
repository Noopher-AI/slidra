// The conformance suite, in the browser: the viewer's own DOMParser path
// must reach the same verdicts as the reference reader under Node.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../conformance/manifest.json", import.meta.url), "utf8"));

for (const item of manifest.cases) {
  test(`conformance: ${item.id}`, async ({ page }) => {
    const bytes = readFileSync(new URL(`../conformance/${item.file}`, import.meta.url));
    await page.goto("/");
    await expect(page.locator("#home")).toBeVisible();
    await page.locator("#file-input").setInputFiles({ name: `${item.id}.slidra`, mimeType: "application/vnd.slidra", buffer: bytes });

    if (item.expect.open === "reject") {
      await expect(page.locator(".toast").first()).toBeVisible();
      await expect(page.locator("#viewer")).toBeHidden();
      return;
    }
    await expect(page.locator("#viewer")).toBeVisible();
    const slides = item.expect.slides;
    if (slides.length === 0) {
      await expect(page.locator("#slide-counter")).toHaveText("0 / 0");
      return;
    }
    await expect(page.locator("#slide-counter")).toHaveText(`1 / ${slides.length}`);
    const first = slides[0];
    if (first.status === "corrupt") await expect(page.locator(".toast").first()).toBeVisible();
    if (first.status === "ok" && typeof first.steps === "number") await expect(page.locator("#step-dots i")).toHaveCount(first.steps);
  });
}
