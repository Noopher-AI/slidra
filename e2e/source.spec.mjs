// <slidra-player> given a deck source instead of a file: a server that hands
// out project.json, one slide at a time, and a URL for each packaged file,
// the way a product that must never give the browser the whole deck would.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openDeck } from "../lib/viewer/deck.js";
import { makeDeck, svg } from "../test/fixtures/make-deck.mjs";

const CDN = "https://cdn.example.test";
const API = "https://api.example.test";
const FILES = "https://files.example.test";
const TOTAL = 30;
const cors = { "Access-Control-Allow-Origin": "*" };
const bundle = () => readFileSync(new URL("../packages/slidra-player/dist/slidra-player.js", import.meta.url));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A 30-slide deck whose first slide sets text in an embedded font, shows a packaged image, and names a tracker on the network. */
async function servedDeck() {
  const showcase = await openDeck(new Uint8Array(readFileSync(new URL("../examples/showcase.slidra", import.meta.url))));
  const slides = Array.from({ length: TOTAL }, (_, i) => svg(`<g id="el-${String(i).padStart(12, "0")}"><text x="100" y="360" font-size="80" font-family="Brand">Slide ${i + 1}</text></g>`));
  slides[0] = svg(
    '<g id="el-AAAAAAAAAAAA"><text x="100" y="200" font-size="80" font-family="Brand">Brand text</text></g>' +
      '<g id="el-BBBBBBBBBBBB"><image href="../assets/logo.png" width="10" height="10"/><image href="https://tracker.example.test/pixel.png" width="10" height="10"/></g>',
  );
  const bytes = makeDeck({
    slides,
    files: {
      "fonts/Brand.ttf": showcase.readBytes("fonts/NotoSansTC-Presentation.ttf"),
      "fonts/LICENSE.txt": showcase.readBytes("fonts/LICENSE-NotoSansTC.txt"),
      "assets/logo.png": new Uint8Array(PNG),
    },
    project: {
      fonts: [{ file: "fonts/Brand.ttf", family: "Brand", license: "SIL Open Font License 1.1", licenseFile: "fonts/LICENSE.txt", source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC" }],
    },
  });
  return openDeck(bytes);
}

/** Serves the deck piecewise and records every request for it. */
async function serve(context, deck) {
  const requests = { project: 0, slides: [], files: [], whole: [], beacons: [] };
  const files = deck.list().filter((path) => deck.hasFile(path) && path !== "project.json" && !deck.slides.includes(path));
  await context.route(`${CDN}/slidra-player.js`, (route) => route.fulfill({ body: bundle(), contentType: "text/javascript", headers: cors }));
  await context.route("**/*.slidra", (route) => {
    requests.whole.push(route.request().url());
    return route.fulfill({ status: 404, body: "" });
  });
  await context.route(`${API}/deck/project.json`, (route) => {
    requests.project++;
    return route.fulfill({ body: JSON.stringify(deck.project), contentType: "application/json", headers: cors });
  });
  await context.route(`${API}/deck/slides/*`, (route) => {
    const path = new URL(route.request().url()).pathname.replace("/deck/", "");
    requests.slides.push(path);
    return route.fulfill({ body: deck.readText(path), contentType: "image/svg+xml", headers: cors });
  });
  await context.route(`${FILES}/f/**`, (route) => {
    const path = new URL(route.request().url()).pathname.replace("/f/", "");
    requests.files.push(path);
    // Fonts load in CORS mode, and a sandboxed slide frame's origin is opaque.
    return route.fulfill({ body: Buffer.from(deck.readBytes(path)), contentType: path.endsWith(".png") ? "image/png" : "font/ttf", headers: cors });
  });
  await context.route("https://tracker.example.test/**", (route) => {
    requests.beacons.push(route.request().url());
    return route.fulfill({ body: "" });
  });
  await context.route(`${CDN}/page.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Product page</title><slidra-player id="talk" controls style="width:800px"></slidra-player>
<script type="module">
import "${CDN}/slidra-player.js";
const files = ${JSON.stringify(files)};
const get = async (url, as) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response[as]();
};
document.getElementById("talk").source = {
  project: () => get("${API}/deck/project.json", "json"),
  slide: (path) => get("${API}/deck/" + path, "text"),
  fileUrl: (path) => (files.includes(path) ? "${FILES}/f/" + path + "?sig=t0k3n" : null),
};
</script>`,
    }),
  );
  return requests;
}

const slideFrame = (page) => page.frames().find((frame) => frame !== page.mainFrame());

test("a deck source plays slide by slide, with its fonts and images loaded from their URLs", async ({ page, context }) => {
  const requests = await serve(context, await servedDeck());
  await page.goto(`${CDN}/page.html`);
  const player = page.locator("#talk");
  await expect(player.locator(".counter")).toHaveText(`1 / ${TOTAL}`);
  await expect(player.locator("iframe.slide")).toHaveAttribute("sandbox", "allow-scripts");

  // The font and the image came from the source's URLs, admitted by the frame's CSP one by one.
  const frame = slideFrame(page);
  await expect.poll(() => frame.evaluate(() => document.fonts.ready.then(() => [...document.fonts].map((font) => `${font.family.replace(/"/g, "")}:${font.status}`)))).toContain("Brand:loaded");
  expect(await frame.evaluate(() => document.querySelector("image").getAttribute("href"))).toBe(`${FILES}/f/assets/logo.png?sig=t0k3n`);
  await expect.poll(() => [...new Set(requests.files)].sort()).toEqual(["assets/logo.png", "fonts/Brand.ttf"]);
  const html = await player.locator("iframe.slide").getAttribute("srcdoc");
  expect(html).not.toContain("data:font");
  expect(html).toContain(`src:url("${FILES}/f/fonts/Brand.ttf?sig=t0k3n")`);

  // Moving on reads only the slides it shows and the next one.
  await page.evaluate(() => /** @type {any} */ (document.getElementById("talk")).goTo(12));
  await expect(player.locator(".counter")).toHaveText(`12 / ${TOTAL}`);
  await player.locator(".next").click();
  await expect(player.locator(".counter")).toHaveText(`13 / ${TOTAL}`);
  await page.waitForTimeout(800);
  expect([...new Set(requests.slides)].sort()).toEqual(["slides/001.svg", "slides/002.svg", "slides/012.svg", "slides/013.svg", "slides/014.svg"]);
  expect(requests.project).toBe(1);
  expect(requests.whole).toEqual([]);

  // What the slide itself names from the network still waits for consent.
  await page.evaluate(() => /** @type {any} */ (document.getElementById("talk")).goTo(1));
  await expect(player.locator(".counter")).toHaveText(`1 / ${TOTAL}`);
  await page.waitForTimeout(300);
  expect(requests.beacons).toEqual([]);
  await page.evaluate(() => document.getElementById("talk").setAttribute("allow-remote", ""));
  await expect.poll(() => requests.beacons.length).toBe(1);
});

test("a source's slide that cannot be read is reported, and the deck keeps playing", async ({ page, context }) => {
  const deck = await servedDeck();
  const requests = await serve(context, deck);
  await context.route(`${API}/deck/slides/002.svg`, (route) => route.fulfill({ status: 500, body: "no", headers: cors }));
  await page.goto(`${CDN}/page.html`);
  const player = page.locator("#talk");
  await expect(player.locator(".counter")).toHaveText(`1 / ${TOTAL}`);
  const error = page.evaluate(() => new Promise((resolve) => document.getElementById("talk").addEventListener("error", (event) => resolve(/** @type {any} */ (event).detail.message), { once: true })));
  await page.evaluate(() => /** @type {any} */ (document.getElementById("talk")).goTo(2));
  expect(await error).toBe("Slide 2 could not be read: HTTP 500");
  await page.evaluate(() => /** @type {any} */ (document.getElementById("talk")).goTo(3));
  await expect(player.locator(".counter")).toHaveText(`3 / ${TOTAL}`);
  expect(requests.whole).toEqual([]);
});
