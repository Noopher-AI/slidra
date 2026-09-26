// <slidra-player> as a third-party site would use it: the built bundle and a
// deck served from a CDN origin, on a page of another origin.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { makeDeck, svg } from "../test/fixtures/make-deck.mjs";

const CDN = "https://cdn.example.test";
const bundle = () => readFileSync(new URL("../packages/slidra-player/dist/slidra-player.js", import.meta.url));
const showcase = readFileSync(new URL("../examples/showcase.slidra", import.meta.url));
const remote = makeDeck({ slides: [svg('<g id="el-AAAAAAAAAAAA"><image href="https://tracker.example.test/pixel.png" width="10" height="10"/></g>')] });

test.beforeEach(async ({ context }) => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  await context.route(`${CDN}/slidra-player.js`, (route) => route.fulfill({ body: bundle(), contentType: "text/javascript", headers: cors }));
  await context.route(`${CDN}/showcase.slidra`, (route) => route.fulfill({ body: showcase, contentType: "application/vnd.slidra", headers: cors }));
  await context.route(`${CDN}/remote.slidra`, (route) => route.fulfill({ body: Buffer.from(remote), contentType: "application/vnd.slidra", headers: cors }));
  await context.route(`${CDN}/page.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Blog post</title><script type="module" src="${CDN}/slidra-player.js"></script><p>My talk:</p><slidra-player id="talk" src="${CDN}/showcase.slidra" controls slide="2" style="width:800px"></slidra-player>`,
    }),
  );
});

test("the bundle plays a deck on any page, with controls, keys, methods and events", async ({ page }) => {
  await page.goto(`${CDN}/page.html`);
  const player = page.locator("#talk");
  await expect(player.locator(".counter")).toHaveText("2 / 7");
  // The element keeps the deck's aspect ratio.
  const box = await player.boundingBox();
  expect(Math.round(box.width / (box.height - 40))).toBe(2); // 800 wide; 16:9 stage (450) + 40 px bar
  const events = page.evaluate(() => new Promise((resolve) => document.getElementById("talk").addEventListener("slidechange", (event) => resolve(/** @type {any} */ (event).detail), { once: true })));
  await page.evaluate(() => /** @type {any} */ (document.getElementById("talk")).goTo(5));
  expect(await events).toEqual({ slide: 5, step: -1, slideCount: 7 });
  await expect(player.locator(".counter")).toHaveText("5 / 7");
  expect(await page.evaluate(() => /** @type {any} */ (document.getElementById("talk")).slideCount)).toBe(7);
  await page.evaluate(() => {
    /** @type {any} */ (document.getElementById("talk")).slide = 6;
  });
  await expect(player.locator(".counter")).toHaveText("6 / 7");
  await page.evaluate(() => /** @type {any} */ (document.getElementById("talk")).goTo(5));
  await expect(player.locator(".counter")).toHaveText("5 / 7");
  await player.locator(".prev").click();
  await expect(player.locator(".counter")).toHaveText("4 / 7");
  await player.focus();
  await page.keyboard.press("Home");
  await expect(player.locator(".counter")).toHaveText("1 / 7");
});

test("slides stay sandboxed and network resources stay off unless allowed", async ({ page, context }) => {
  const beacons = [];
  await context.route("https://tracker.example.test/**", (route) => {
    beacons.push(route.request().url());
    return route.fulfill({ body: "" });
  });
  await page.goto(`${CDN}/page.html`);
  await expect(page.locator("#talk .counter")).toHaveText("2 / 7");
  await expect(page.locator("#talk iframe.slide")).toHaveAttribute("sandbox", "allow-scripts");
  await page.evaluate((src) => document.getElementById("talk").setAttribute("src", src), `${CDN}/remote.slidra`);
  await expect(page.locator("#talk .counter")).toHaveText("1 / 1");
  await page.waitForTimeout(500);
  expect(beacons).toEqual([]);
  await page.evaluate(() => document.getElementById("talk").setAttribute("allow-remote", ""));
  await expect.poll(() => beacons.length).toBe(1);
});

test("a deck that cannot load says so and fires an error event", async ({ page, context }) => {
  await context.route(`${CDN}/missing.slidra`, (route) => route.fulfill({ status: 404, body: "no", headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.goto(`${CDN}/page.html`);
  await expect(page.locator("#talk .counter")).toHaveText("2 / 7");
  const error = page.evaluate(() => new Promise((resolve) => document.getElementById("talk").addEventListener("error", (event) => resolve(/** @type {any} */ (event).detail.message), { once: true })));
  await page.evaluate((src) => document.getElementById("talk").setAttribute("src", src), `${CDN}/missing.slidra`);
  expect(await error).toContain("HTTP 404");
  await expect(page.locator("#talk .status")).toContainText("cannot be shown");
});
