import { test, expect } from "@playwright/test";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { SHOWCASE, openDeckFile, waitForSlide } from "./helpers.mjs";

/** Counts the pages of a PDF by its page objects. */
const pdfPages = (pdf) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

test.beforeEach(async ({ page }) => {
  // The real print dialog would block the test; count calls instead.
  await page.addInitScript(() => {
    window.print = () => {
      window["__printCalls"] = (window["__printCalls"] ?? 0) + 1;
    };
  });
});

async function printWith(page, choose) {
  await page.keyboard.press("Control+p");
  const dialog = page.locator("#print-dialog");
  await expect(dialog).toBeVisible();
  await choose(dialog);
  await dialog.getByRole("button", { name: "Print…" }).click();
  await expect.poll(() => page.evaluate(() => window["__printCalls"] ?? 0)).toBe(1);
}

test("Ctrl+P prints one slide per page, on pages the shape of the canvas", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await printWith(page, async () => {});
  await expect(page.locator("#print-root .print-page")).toHaveCount(7);
  await expect(page.locator("#print-root img")).toHaveCount(7);
  expect(await page.locator("#print-root img").evaluateAll((images) => images.every((img) => /** @type {HTMLImageElement} */ (img).naturalWidth > 0))).toBe(true);
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  expect(pdfPages(pdf)).toBe(7);
});

test("handouts, notes and animation steps change the pages", async ({ page }) => {
  const deck = makeDeck({
    slides: [
      svg('<g id="el-AAAAAAAAAAAA"><text x="100" y="100">one</text></g><g id="el-BBBBBBBBBBBB"><text x="100" y="200">two</text></g>', {
        metadata: `<slidra:effects xmlns:slidra="${NS}"><slidra:effect target="el-AAAAAAAAAAAA" family="enter" effect="fade" start="on-click"/><slidra:effect target="el-BBBBBBBBBBBB" family="enter" effect="fade" start="on-click"/></slidra:effects><slidra:notes xmlns:slidra="${NS}">Say hello.</slidra:notes>`,
      }),
      ...Array.from({ length: 6 }, (_, i) => svg(`<g id="el-CCCCCCCCCC${String(i).padStart(2, "0")}"><text x="100" y="100">slide ${i + 2}</text></g>`)),
    ],
  });
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 7);
  await printWith(page, async (dialog) => {
    await dialog.getByLabel("Handout, 6 per page").check();
    await dialog.getByLabel("Speaker notes").check();
    await dialog.getByLabel("Every animation step as its own slide").check();
  });
  // Slide 1 prints once per step (2), the other six once: 8 slides, 6 per page → 2 pages.
  await expect(page.locator("#print-root .print-slide")).toHaveCount(8);
  await expect(page.locator("#print-root .print-page")).toHaveCount(2);
  await expect(page.locator("#print-root figcaption").first()).toHaveText("1 · step 1");
  await expect(page.locator("#print-root .print-notes")).toHaveCount(1);
  await expect(page.locator("#print-root .print-notes")).toHaveText("Say hello.");
  // Step 1 shows the first element and still hides the second.
  const firstStepSvg = await page
    .locator("#print-root img")
    .first()
    .evaluate(async (img) => (await fetch(/** @type {HTMLImageElement} */ (img).src)).text());
  expect(firstStepSvg).toContain("#el-BBBBBBBBBBBB{opacity:0 !important}");
  expect(firstStepSvg).not.toContain("#el-AAAAAAAAAAAA{opacity:0");

  // After printing, the layout goes away.
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator("#print-root")).toHaveCount(0);
});

test("Esc cancels the print dialog without closing the deck", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await page.keyboard.press("Control+p");
  await expect(page.locator("#print-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#print-dialog")).toBeHidden();
  await expect(page.locator("#viewer")).toBeVisible();
});

test("handouts with notes fit their slides per page in the PDF", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  /** @type {[string, number][]} */
  const layouts = [
    ["Handout, 2 per page", 4],
    ["Handout, 3 per page", 3],
    ["Handout, 6 per page", 2],
  ];
  for (const [label, expected] of layouts) {
    await page.evaluate(() => (window["__printCalls"] = 0));
    await printWith(page, async (dialog) => {
      await dialog.getByLabel(label).check();
      await dialog.getByLabel("Speaker notes").setChecked(true);
    });
    await expect(page.locator("#print-root .print-notes")).toHaveCount(7);
    await page.emulateMedia({ media: "print" });
    expect(pdfPages(await page.pdf({ preferCSSPageSize: true, printBackground: true })), label).toBe(expected);
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator("#print-root")).toHaveCount(0);
  }
});
