#!/usr/bin/env node
// Builds assets/fonts/NotoSansTC-Presentation.ttf — the single font every
// new presentation embeds (ticket #71). Deliberately a
// separate script from build-font-subset.mjs (which builds the *UI's* own
// woff2, ticket #49): different charset, different output format, different
// rerun trigger. Sharing the fetch logic between them would couple two
// things that change for unrelated reasons.
//
// Output format is sfnt (.ttf), not woff2: the container's text-metrics.ts
// reader only understands sfnt tables, and @font-face can load a .ttf
// directly, so one format serves both consumers (see the ticket's plan,
// decision #3).
//
// Run manually (network access required; the resulting .ttf is a committed
// artifact, not a build step):
//
//   node scripts/build-presentation-font.mjs

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "assets/fonts");
const outputPath = path.join(outputDir, "NotoSansTC-Presentation.ttf");

// Fixed subset range (ticket #71's plan, decision #5): printable ASCII,
// Latin-1 supplement, general punctuation, CJK symbols/punctuation,
// halfwidth/fullwidth forms, and the full CJK Unified Ideographs block.
// Fixed, not derived from any presentation's current text — the whole
// point is that adding a new character to a slide never changes the
// glyphs (and therefore never changes measured widths) of characters
// already in use.
const RANGES = [
  [0x0020, 0x007e],
  [0x00a0, 0x00ff],
  [0x2000, 0x206f],
  [0x3000, 0x303f],
  [0xff00, 0xffef],
  [0x4e00, 0x9fff],
];

function buildCharacterSet() {
  let text = "";
  for (const [start, end] of RANGES) {
    for (let code = start; code <= end; code++) {
      text += String.fromCodePoint(code);
    }
  }
  return text;
}

async function fetchNotoSansTCRegular() {
  const cssResponse = await fetch("https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400&display=swap", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!cssResponse.ok) throw new Error(`無法取得 Noto Sans TC 的 CSS：HTTP ${cssResponse.status}`);
  const css = await cssResponse.text();
  const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/);
  if (!match) throw new Error("在 Google Fonts 的 CSS 回應裡找不到 .ttf 來源網址");
  const fontResponse = await fetch(match[1]);
  if (!fontResponse.ok) throw new Error(`無法下載 Noto Sans TC：HTTP ${fontResponse.status}`);
  return Buffer.from(await fontResponse.arrayBuffer());
}

async function main() {
  console.log("下載 Noto Sans TC（wght 400，regular）…");
  const fullFont = await fetchNotoSansTCRegular();
  console.log(`原始字體大小：${fullFont.length} bytes`);

  const text = buildCharacterSet();
  console.log(`字集大小（不重複字元數）：${[...text].length}`);

  console.log("子集化為 sfnt (TTF)…");
  const subsetBuffer = await subsetFont(fullFont, text, { targetFormat: "sfnt" });
  console.log(`子集後大小：${subsetBuffer.length} bytes`);

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, subsetBuffer);
  console.log(`已寫入：${path.relative(rootDir, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
