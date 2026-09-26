import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readZip } from "../lib/viewer/zip-reader.js";
import { SHOWCASE, waitForSlide } from "./helpers.mjs";

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

async function openExport(page) {
  await page.keyboard.press("Control+p");
  await expect(page.locator("#print-dialog")).toBeVisible();
}

test("the current slide exports as a PNG at twice the canvas size", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await openExport(page);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-slide").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Slidra Showcase-slide-01.png");
  const bytes = readFileSync(await download.path());
  expect([...bytes.subarray(0, 8)]).toEqual(PNG);
  expect(pngSize(bytes)).toEqual([2560, 1440]);
});

test("all slides export as PNGs in a ZIP archive", async ({ page }) => {
  await page.goto(SHOWCASE);
  await waitForSlide(page, 1, 7);
  await openExport(page);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-all").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Slidra Showcase-slides.zip");
  const entries = await readZip(new Uint8Array(readFileSync(await download.path())));
  expect([...entries.keys()]).toEqual(Array.from({ length: 7 }, (_, i) => `Slidra Showcase-slide-0${i + 1}.png`));
  for (const data of entries.values()) expect([...data.subarray(0, 8)]).toEqual(PNG);
});

test("a deck link previews as the deck: title, description and a cover image", async ({ request }) => {
  const deck = "/decks/0/showcase.slidra";
  const html = await (await request.get(`/?deck=${encodeURIComponent(deck)}`)).text();
  expect(html).toContain('<meta property="og:title" content="Slidra Showcase — Slidra"/>');
  expect(html).toMatch(/<meta property="og:image" content="http:\/\/localhost:\d+\/api\/og\?deck=%2Fdecks%2F0%2Fshowcase\.slidra"\/>/);
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  const image = await request.get(`/api/og?deck=${encodeURIComponent(deck)}`);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/png");
  expect(pngSize(Buffer.from(await image.body()))).toEqual([1200, 630]);
  expect((await request.get("/api/og?deck=/decks/0/../../package.json")).status()).toBe(404);
  expect((await request.get("/api/og?deck=/etc/passwd")).status()).toBe(404);
});
