import { test, expect } from "@playwright/test";
import { SHOWCASE, expectCounter, waitForSlide } from "./helpers.mjs";

/** The dot's centre as fractions of the slide surface. */
const dotAt = (page) =>
  page.evaluate(() => {
    const dot = document.getElementById("laser-dot");
    return dot.hidden ? null : { x: parseFloat(dot.style.left) / 100, y: parseFloat(dot.style.top) / 100 };
  });

test("L shows a laser dot that follows the pointer; a click still advances", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await page.keyboard.press("l");
  const layer = page.locator("#laser-layer");
  await expect(layer).toBeVisible();
  const box = await page.locator("#surface").boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75);
  await expect.poll(() => dotAt(page)).toEqual({ x: 0.25, y: 0.75 });
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.locator("#step-dots i.on")).toHaveCount(1);
  await page.keyboard.press("l");
  await expect(layer).toBeHidden();
  expect(await dotAt(page)).toBeNull();
});

test("Z magnifies around the pointer until Z, Esc or a slide change", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  const zoom = page.locator("#zoom");
  const box = await page.locator("#surface").boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.2);
  await page.waitForTimeout(200);
  await page.keyboard.press("z");
  await expect(zoom).toHaveClass(/is-zoomed/);
  const origin = await zoom.evaluate((el) => el.style.transformOrigin);
  const [ox, oy] = origin.split(" ").map((v) => parseFloat(v));
  expect(Math.abs(ox - 80)).toBeLessThan(3);
  expect(Math.abs(oy - 20)).toBeLessThan(3);
  await page.keyboard.press("Escape");
  await expect(zoom).not.toHaveClass(/is-zoomed/);
  await expect(page.locator("#viewer")).toBeVisible();

  await page.keyboard.press("z");
  await expect(zoom).toHaveClass(/is-zoomed/);
  await page.keyboard.press("End");
  await waitForSlide(page, 7, 7);
  await expect(zoom).not.toHaveClass(/is-zoomed/);
});

test("the presenter view's laser shows only on the audience surface", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  const popupPromise = page.waitForEvent("popup");
  await page.keyboard.press("p");
  const presenter = await popupPromise;
  await expect(presenter.locator("#p-status")).toBeHidden();
  // Wait for the first sync: a key pressed while the copy's frame is still loading is lost.
  await expect(presenter.locator("#p-counter")).toHaveText(/^Slide 1 of 7/);
  await presenter.waitForTimeout(300);
  await presenter.keyboard.press("l");
  await expect(presenter.locator("#p-laser")).toBeVisible();
  const area = await presenter.locator("#p-surface").boundingBox();
  await presenter.mouse.move(area.x + area.width * 0.6, area.y + area.height * 0.4);
  await expect.poll(() => dotAt(page)).not.toBeNull();
  const dot = await dotAt(page);
  expect(Math.abs(dot.x - 0.6)).toBeLessThan(0.02);
  expect(Math.abs(dot.y - 0.4)).toBeLessThan(0.02);
  await presenter.mouse.move(area.x - 20, area.y - 20);
  await expect.poll(() => dotAt(page)).toBeNull();
  await presenter.mouse.click(area.x + area.width * 0.5, area.y + area.height * 0.5);
  await expect(page.locator("#step-dots i.on")).toHaveCount(1);
  await presenter.keyboard.press("z");
  await expect(page.locator("#zoom")).toHaveClass(/is-zoomed/);
  await expectCounter(page, "1 / 7");
});
