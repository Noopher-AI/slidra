import { test, expect } from "@playwright/test";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { expectCounter, inSlide, jumpTo, openDeckFile, opacityOf, waitForSlide } from "./helpers.mjs";

const effects = (...list) => `<slidra:effects xmlns:slidra="${NS}">${list.join("")}</slidra:effects>`;
const fx = (attrs) =>
  `<slidra:effect ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}/>`;
const words = (id, y, content, extra = "") => `<g id="${id}"${extra}><text x="100" y="${y}" font-size="48">${content}</text></g>`;

const SENTENCE = "Every word enters on its own beat";

const deck = makeDeck({
  slides: [
    // 1 · easing, repeat and the new fly directions
    svg(`${words("el-down00000000", 150, "down")}${words("el-pulse0000000", 300, "pulse")}${words("el-out000000000", 450, "out")}`, {
      metadata: effects(
        fx({ target: "el-down00000000", family: "enter", effect: "fly-down", start: "on-click", duration: "0.4", easing: "overshoot" }),
        fx({ target: "el-pulse0000000", family: "emphasis", effect: "pulse", start: "on-click", duration: "0.3", repeat: "3" }),
        fx({ target: "el-out000000000", family: "exit", effect: "fly-out-right", start: "on-click", duration: "0.3", easing: "ease-in" }),
      ),
    }),
    // 2 · a word build next to the same text without one
    svg(
      `${words("el-plain0000000", 200, SENTENCE)}${words("el-build0000000", 400, SENTENCE, ' data-slidra-name="Build"')}<g id="el-box000000000"><rect x="90" y="420" width="20" height="20"/><text x="130" y="440" font-size="20">caption</text></g>`,
      {
        metadata: effects(
          fx({ target: "el-build0000000", family: "enter", effect: "fade", start: "on-click", duration: "0.2", by: "word", stagger: "0.25" }),
          fx({ target: "el-box000000000", family: "enter", effect: "fade", start: "after-previous", duration: "0.2" }),
        ),
      },
    ),
    // 3 · triggers
    svg(
      `<g id="el-button0000000"><rect x="100" y="100" width="300" height="100" fill="#246"/><text x="120" y="160" fill="#fff" font-size="32">Reveal</text></g>${words("el-secret0000000", 400, "secret")}${words("el-more00000000", 550, "more")}`,
      {
        metadata: effects(
          fx({ target: "el-secret0000000", family: "enter", effect: "fade", start: "on-click", duration: "0.2", trigger: "el-button0000000" }),
          fx({ target: "el-more00000000", family: "enter", effect: "fade", start: "on-click", duration: "0.2", trigger: "el-button0000000" }),
        ),
      },
    ),
  ],
});

const timing = (page, id) =>
  inSlide(
    page,
    (elementId) => {
      const animation = document.getElementById(elementId).getAnimations()[0];
      return animation ? { easing: animation.effect.getTiming().easing, iterations: animation.effect.getTiming().iterations } : null;
    },
    id,
  );

test("easing, repeat and the new directions reach the animations", async ({ page }) => {
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 3);
  await page.keyboard.press("ArrowRight");
  expect(await timing(page, "el-down00000000")).toEqual({ easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", iterations: 1 });
  await page.keyboard.press("ArrowRight");
  expect(await timing(page, "el-pulse0000000")).toEqual({ easing: "cubic-bezier(0.25, 0.1, 0.25, 1)", iterations: 3 });
  await page.keyboard.press("ArrowRight");
  expect((await timing(page, "el-out000000000")).easing).toBe("cubic-bezier(0.42, 0, 1, 1)");
  await expect.poll(() => opacityOf(page, "el-out000000000")).toBe(0);
});

test("a word build reveals one word at a time without moving any glyph", async ({ page }) => {
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 3);
  await jumpTo(page, 2, 3);
  // Every character starts where it does in the identical text that has no build.
  const starts = (id) =>
    inSlide(
      page,
      (elementId) => {
        const text = /** @type {SVGTextElement} */ (document.querySelector(`#${elementId} text`));
        return Array.from({ length: text.getNumberOfChars() }, (_, i) => text.getStartPositionOfChar(i).x);
      },
      id,
    );
  const plain = await starts("el-plain0000000");
  const built = await starts("el-build0000000");
  expect(built.length).toBe(plain.length);
  expect(Math.max(...built.map((x, i) => Math.abs(x - plain[i])))).toBeLessThan(0.5);
  expect(await inSlide(page, () => document.querySelectorAll("#el-build0000000 tspan").length)).toBe(7);

  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const unitOpacity = () => inSlide(page, () => [...document.querySelectorAll("#el-build0000000 tspan")].map((t) => Number(getComputedStyle(t).fillOpacity)));
  const early = await unitOpacity();
  expect(early[0]).toBeGreaterThan(0.9);
  expect(early[6]).toBe(0);
  // after-previous waits for the whole build (0.2 + 6 × 0.25 s), not just its duration.
  expect(await opacityOf(page, "el-box000000000")).toBe(0);
  await expect.poll(async () => (await unitOpacity()).every((o) => o === 1), { timeout: 5000 }).toBe(true);
  await expect.poll(() => opacityOf(page, "el-box000000000"), { timeout: 5000 }).toBe(1);
});

test("a trigger runs its own steps without advancing, and retreat resets it", async ({ page }) => {
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 3);
  await jumpTo(page, 3, 3);
  expect(await opacityOf(page, "el-secret0000000")).toBe(0);
  const frame = page.locator("#slide-frame");
  const size = await frame.boundingBox();
  const clickButton = () => frame.click({ position: { x: (200 / 1280) * size.width, y: (150 / 720) * size.height } });
  await clickButton();
  await expect.poll(() => opacityOf(page, "el-secret0000000")).toBe(1);
  expect(await opacityOf(page, "el-more00000000")).toBe(0);
  await expectCounter(page, "3 / 3");
  await clickButton();
  await expect.poll(() => opacityOf(page, "el-more00000000")).toBe(1);
  await clickButton();
  await expectCounter(page, "3 / 3");

  // Keyboard: the trigger is focusable and Enter runs it.
  await page.keyboard.press("ArrowLeft");
  await waitForSlide(page, 2, 3);
  await page.keyboard.press("ArrowRight");
  await waitForSlide(page, 3, 3);
  expect(await opacityOf(page, "el-secret0000000")).toBe(0);
  await frame.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => opacityOf(page, "el-secret0000000")).toBe(1);
});
