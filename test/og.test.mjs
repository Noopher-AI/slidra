import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { OG_HEIGHT, OG_WIDTH, coverImage, withoutExternalReferences } from "../lib/og.js";
import { makeDeck, svg } from "./fixtures/make-deck.mjs";

test("the server renders nothing a slide points at outside itself", () => {
  const markup = withoutExternalReferences(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">',
      "<style>@import url(https://evil.example/x.css); .a{fill:url(file:///etc/passwd)} .b{fill:url(#grad)}</style>",
      '<image href="file:///etc/passwd"/><image xlink:href="https://evil.example/beacon.png"/><image href="../assets/x.png"/>',
      '<image href="data:image/png;base64,AA"/><use href="#grad"/><rect style="fill:url(http://evil.example/p)"/>',
      "</svg>",
    ].join(""),
  );
  assert.doesNotMatch(markup, /passwd|evil\.example|assets\/x\.png/);
  assert.match(markup, /data:image\/png;base64,AA/);
  assert.match(markup, /href="#grad"/);
  assert.match(markup, /url\(#grad\)/);
});

test("the cover slide becomes a 1200×630 PNG", async () => {
  const png = await coverImage(new Uint8Array(readFileSync(new URL("../examples/showcase.slidra", import.meta.url))));
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["png", OG_WIDTH, OG_HEIGHT]);
});

test("the cover is the one project.json names, and a deck without slides has none", async () => {
  const deck = (cover) =>
    makeDeck({
      project: cover ? { cover } : {},
      slides: [svg('<rect width="1280" height="720" fill="#ff0000"/>'), svg('<rect width="1280" height="720" fill="#0000ff"/>')],
    });
  const centre = async (png) => {
    const { data } = await sharp(png).extract({ left: 600, top: 315, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    return [...data.subarray(0, 3)];
  };
  assert.deepEqual(await centre(await coverImage(deck(null))), [255, 0, 0]);
  assert.deepEqual(await centre(await coverImage(deck("slides/002.svg"))), [0, 0, 255]);
  await assert.rejects(coverImage(makeDeck({ slides: [] })), /no slides/);
});

test("the slide's background colour fills the preview, letterbox included", async () => {
  const png = await coverImage(makeDeck({ slides: [svg("<g/>", { attrs: ' style="background-color:#123456"' })] }));
  for (const [left, top] of [
    [600, 315],
    [2, 2],
  ]) {
    const { data } = await sharp(png).extract({ left, top, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [0x12, 0x34, 0x56], `${left},${top}`);
  }
});
