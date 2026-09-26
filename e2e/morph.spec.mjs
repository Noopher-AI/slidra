import { test, expect } from "@playwright/test";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { inSlide, openDeckFile, waitForSlide } from "./helpers.mjs";

const morphIn = (duration) => `<slidra:transition xmlns:slidra="${NS}" enter="morph" enter-duration="${duration}"/>`;
const rect = (id, x, y, w, h, fill) => `<g id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/></g>`;

const deck = (duration) =>
  makeDeck({
    slides: [
      svg(
        rect("el-box000000000", 100, 100, 100, 100, "#c8233b") +
          rect("el-gone00000000", 100, 400, 200, 50, "#246") +
          '<g id="el-moved00000000" transform="translate(600 100)"><rect width="50" height="50"/></g>',
        {
          attrs: ' style="background-color:#ffffff"',
        },
      ),
      svg(
        rect("el-box000000000", 800, 300, 200, 200, "#c8233b") +
          rect("el-new000000000", 100, 600, 300, 50, "#393") +
          '<g id="el-moved00000000" transform="translate(100 500)"><rect width="50" height="50"/></g>',
        {
          attrs: ' style="background-color:#101418"',
          metadata: morphIn(duration),
        },
      ),
    ],
  });

/** The element's box in slide units, read from the running frame. */
const boxOf = (page, id) =>
  inSlide(
    page,
    (elementId) => {
      const root = document.querySelector("body > svg");
      const scale = root.getBoundingClientRect().width / 1280;
      const r = document.getElementById(elementId).getBoundingClientRect();
      return { x: Math.round(r.x / scale), y: Math.round(r.y / scale), width: Math.round(r.width / scale) };
    },
    id,
  );

test("paired elements travel from their old box, new ones fade in, departed ones fade out", async ({ page }) => {
  await openDeckFile(page, deck(2));
  await waitForSlide(page, 1, 2);
  await page.keyboard.press("ArrowRight");
  await waitForSlide(page, 2, 2);

  const early = await boxOf(page, "el-box000000000");
  expect(early.x).toBeLessThan(400);
  expect(early.width).toBeLessThan(170);
  expect(await boxOf(page, "el-moved00000000")).toMatchObject({ x: expect.any(Number) });
  expect((await boxOf(page, "el-moved00000000")).x).toBeGreaterThan(300);
  expect(await inSlide(page, () => document.querySelectorAll("[data-slidra-ghost]").length)).toBe(1);
  expect(Number(await inSlide(page, () => getComputedStyle(document.getElementById("el-new000000000")).opacity))).toBeLessThan(0.9);
  expect(await inSlide(page, () => document.getElementById("slidra-morph-hold"))).toBeNull();

  await expect.poll(() => boxOf(page, "el-box000000000"), { timeout: 5000 }).toEqual({ x: 800, y: 300, width: 200 });
  await expect.poll(() => inSlide(page, () => document.querySelectorAll("[data-slidra-ghost]").length), { timeout: 5000 }).toBe(0);
  expect(await boxOf(page, "el-moved00000000")).toEqual({ x: 100, y: 500, width: 50 });
  expect(await inSlide(page, () => getComputedStyle(document.querySelector("body > svg")).backgroundColor)).toBe("rgb(16, 20, 24)");
});

test("pressing a key during a morph finishes it at once", async ({ page }) => {
  await openDeckFile(page, deck(10));
  await waitForSlide(page, 1, 2);
  await page.keyboard.press("ArrowRight");
  await waitForSlide(page, 2, 2);
  expect((await boxOf(page, "el-box000000000")).x).toBeLessThan(400);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => boxOf(page, "el-box000000000")).toEqual({ x: 800, y: 300, width: 200 });
  expect(await inSlide(page, () => document.querySelectorAll("[data-slidra-ghost]").length)).toBe(0);
});

test("a morph on the first slide shown plays as a fade; an overview jump shows the slide at rest", async ({ page }) => {
  const first = makeDeck({
    slides: [svg(rect("el-box000000000", 800, 300, 200, 200, "#c8233b"), { metadata: morphIn(0.3) }), svg(rect("el-box000000000", 100, 100, 100, 100, "#c8233b"), { metadata: morphIn(5) })],
  });
  await openDeckFile(page, first);
  await waitForSlide(page, 1, 2);
  expect(await boxOf(page, "el-box000000000")).toEqual({ x: 800, y: 300, width: 200 });
  expect(await inSlide(page, () => document.querySelectorAll("[data-slidra-ghost]").length)).toBe(0);
  await page.keyboard.press("g");
  await page.locator(".overview-item").nth(1).locator("button").click();
  await waitForSlide(page, 2, 2);
  expect(await boxOf(page, "el-box000000000")).toEqual({ x: 100, y: 100, width: 100 });
});
