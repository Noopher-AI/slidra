import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { SHOWCASE, MINIMAL, openDeckFile, waitForSlide, opacityOf } from "./helpers.mjs";

/** Serious and critical axe findings on the viewer page (slide content inside the frame is the deck's own). */
async function seriousViolations(page) {
  const results = await new AxeBuilder({ page }).exclude("#slide-frame").exclude("#p-frame").analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("the home page, the player, the overview and the dialogs pass axe", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#home")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press("g");
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+p");
  expect(await seriousViolations(page)).toEqual([]);
});

test("slide changes and what a step reveals are announced (playback §9)", async ({ page }) => {
  const deck = makeDeck({
    slides: [
      svg(
        `<title>Agenda</title><g id="el-AAAAAAAAAAAA"><text x="100" y="100">Why open formats</text></g><g id="el-GROUPGROUP01"><g id="el-BBBBBBBBBBBB"><text x="100" y="200">Two</text></g><g id="el-CCCCCCCCCCCC"><title>A diagram</title><rect width="10" height="10"/></g></g>`,
        {
          metadata: `<slidra:effects xmlns:slidra="${NS}"><slidra:effect target="el-AAAAAAAAAAAA" family="enter" effect="fade" start="on-click"/><slidra:effect target="el-GROUPGROUP01" family="enter" effect="fade" start="on-click"/></slidra:effects>`,
        },
      ),
      svg('<g id="el-DDDDDDDDDDDD"><text x="100" y="100">second</text></g>'),
    ],
  });
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 2);
  const announcer = page.locator("#announcer");
  await expect(announcer).toHaveAttribute("aria-live", "polite");
  await expect(announcer).toHaveText("Slide 1 of 2: Agenda");
  await page.keyboard.press("ArrowRight");
  await expect(announcer).toHaveText("Why open formats");
  await page.keyboard.press("ArrowRight");
  await expect(announcer).toHaveText("Two. A diagram");
  await page.keyboard.press("ArrowRight");
  await expect(announcer).toHaveText("Slide 2 of 2");
});

test("the overview moves with the arrow keys and dialogs keep Tab inside", async ({ page }) => {
  await page.goto(MINIMAL);
  await waitForSlide(page, 1, 10);
  await page.keyboard.press("g");
  const focusedLabel = () => page.evaluate(() => document.activeElement.getAttribute("aria-label"));
  await expect.poll(focusedLabel).toMatch(/^Slide 1\b/);
  await page.keyboard.press("ArrowRight");
  await expect.poll(focusedLabel).toMatch(/^Slide 2\b/);
  await page.keyboard.press("ArrowDown");
  const afterDown = await focusedLabel();
  expect(Number(/Slide (\d+)/.exec(afterDown)[1])).toBeGreaterThan(2);
  await page.keyboard.press("End");
  await expect.poll(focusedLabel).toMatch(/^Slide 10\b/);
  await page.keyboard.press("Enter");
  await waitForSlide(page, 10, 10);

  await page.keyboard.press("?");
  const inside = () => page.evaluate(() => Boolean(document.activeElement.closest("#key-help")));
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await inside()).toBe(true);
  }
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("effects apply at once and transitions are instant (playback §9)", async ({ page }) => {
    await page.goto(SHOWCASE + "#3");
    await waitForSlide(page, 3, 7);
    await page.keyboard.press("ArrowRight");
    // The fifth entrance normally waits ~1.8 s; with reduced motion it is there at once.
    await expect.poll(() => opacityOf(page, "el-en4000000000"), { timeout: 400 }).toBe(1);
    const durations = await page.evaluate(() => {
      const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("slide-frame"));
      return JSON.parse(frame.srcdoc.match(/JSON\.parse\((".*?")\);/s)[1].replace(/\\u003C/g, "<")).includes('"reducedMotion":true');
    });
    expect(durations).toBe(true);
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await waitForSlide(page, 4, 7);
    expect(await page.locator("#surface").evaluate((el) => el.style.opacity)).toBe("");
  });
});
