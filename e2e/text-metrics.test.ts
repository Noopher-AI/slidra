// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { zipSync } from "fflate";
import { createDeckServerRegistry, type CommandRegistry } from "./helpers/cli.js";
import { startDeckServer, type DeckServerClient } from "../packages/server/src/deck-server-client.js";
import { requireBuilt } from "./helpers/launch.js";

/**
 * The original acceptance criterion here ("the same text measures the
 * same width in Node and in the browser") no longer applies: a later
 * change deletes the browser's own font-metrics engine (`text-metrics.ts`,
 * `window.slidraMeasureText`) entirely — the browser never measures text
 * at all any more, it only displays what the CLI already wrapped. This
 * file now verifies the CLI's OUTPUT instead: write a text box with the
 * CLI (`textbox add`), read back the `<tspan>` lines it actually wrote,
 * and confirm each line's real Chromium-rendered width
 * (`getComputedTextLength()`, the same external ground truth an earlier
 * version of this test already used) fits inside the declared
 * `data-slidra-text-width` — proving the server-side wrap decision agrees
 * with what a real browser draws, not just with another run of the same
 * code.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const fontPath = path.join(rootDir, "assets/fonts/NotoSansTC-Presentation.ttf");

const FAMILY = "Noto Sans TC";
const SLIDE_PATH = "slides/001.svg";

interface Sample {
  label: string;
  text: string;
  width: number;
  fontSizePx: number;
}

const SAMPLES: Sample[] = [
  { label: "pure ASCII, narrow width forces wrapping", text: "Hello Slidra this text should wrap across several lines", width: 220, fontSizePx: 28 },
  { label: "pure Chinese, narrow width forces wrapping", text: "投影片文字量測與換行行為驗證", width: 200, fontSizePx: 32 },
  { label: "mixed Chinese/English", text: "Slidra 是一個簡報工具，支援 agent 協作", width: 260, fontSizePx: 24 },
  { label: "width is generous, stays one line", text: "Hi", width: 400, fontSizePx: 40 },
];

let browser: Browser;
let page: Page;
let slidraHome: string;
let slidraDir: string;
let registry: CommandRegistry;
let presentationId: string;
let fontDataUrl: string;
let deckServer: DeckServerClient;

beforeAll(async () => {
  await requireBuilt(rootDir);

  const fontBytes = await readFile(fontPath);
  fontDataUrl = `data:font/ttf;base64,${fontBytes.toString("base64")}`;

  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-text-metrics-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-text-metrics-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const slidraPath = path.join(slidraDir, "deck.slidra");
  await writeFile(slidraPath, zipSync({
    "project.json": new TextEncoder().encode(JSON.stringify({
      formatVersion: 1,
      name: "font metrics smoke test",
      canvas: { width: 1280, height: 720 },
      slides: [],
    })),
  }));
  deckServer = await startDeckServer({ fileEntry: { uploadBytes: false, remoteUrl: false }, initialDeckPath: slidraPath });
  presentationId = deckServer.initialWorkbenchId!;
  registry = createDeckServerRegistry(deckServer.baseUrl, presentationId);
  // Keep creation and every subsequent mutation in this one runtime.
  const addedSlide = await registry.dispatch("slide add", { id: presentationId });
  if (!addedSlide.ok) throw new Error(addedSlide.message);
}, 60_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await deckServer?.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  if (slidraHome) await rm(slidraHome, { recursive: true, force: true });
  if (slidraDir) await rm(slidraDir, { recursive: true, force: true });
});

/** `<tspan>` line texts and `data-slidra-text-width`, read straight off the CLI-written file — this verifies the CLI's own output, not a second parser. */
async function readTextboxLines(elementId: string): Promise<{ lines: string[]; width: number }> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: SLIDE_PATH });
  const svg = result.data!.content;
  const openTagMatch = new RegExp(`<g id="${elementId}"[^>]*data-slidra-text-width="([^"]+)"[^>]*>`).exec(svg);
  if (!openTagMatch) throw new Error(`could not find text box container: ${elementId}`);
  const width = Number(openTagMatch[1]);
  // Scoped to elementId's own container body (up to the next sibling <g id=
  // or this container's own </g>) — an unscoped scan would also pick up
  // the default template's own title placeholder and any previous
  // sample's leftover markup.
  const bodyStart = openTagMatch.index! + openTagMatch[0].length;
  const nextSiblingOpen = svg.indexOf("<g id=", bodyStart);
  const containerEnd = svg.indexOf("</g>", bodyStart);
  const bodyEnd = nextSiblingOpen === -1 ? containerEnd : Math.min(nextSiblingOpen, containerEnd);
  const body = svg.slice(bodyStart, bodyEnd);
  const lines = [...body.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
  return { lines, width };
}

/** Chromium's own `getComputedTextLength()` for `text` at `fontSizePx` in the container's embedded font — the external ground truth, not a second implementation of measurement. */
async function renderedWidthInChromium(text: string, fontSizePx: number): Promise<number> {
  return page.evaluate(
    async ([url, family, sampleText, size]) => {
      const style = document.createElement("style");
      style.textContent = `@font-face{font-family:"${family}";src:url("${url}") format("truetype");}`;
      document.head.appendChild(style);

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("font-family", family);
      textEl.setAttribute("font-size", String(size));
      textEl.textContent = sampleText;
      svg.appendChild(textEl);
      document.body.appendChild(svg);

      await document.fonts.load(`${size}px "${family}"`);
      await document.fonts.ready;

      const length = textEl.getComputedTextLength();
      svg.remove();
      style.remove();
      return length;
    },
    [fontDataUrl, FAMILY, text, fontSizePx] as const,
  );
}

describe("CLI's text box wrap output vs actual Chromium rendering", () => {
  it.each(SAMPLES)("$label: every line the CLI writes renders in Chromium no wider than the declared data-slidra-text-width (0.5% tolerance)", async ({ text, width, fontSizePx }) => {
    const added = await registry.dispatch<{ elementId: string; lines: number }>("textbox add", {
      id: presentationId,
      slidePath: SLIDE_PATH,
      x: 0,
      y: 0,
      width,
      text,
      fontSize: fontSizePx,
      fontFamily: FAMILY,
    });
    expect(added.ok).toBe(true);
    const elementId = added.data!.elementId;

    const { lines, width: declaredWidth } = await readTextboxLines(elementId);
    expect(lines.length).toBe(added.data!.lines);
    expect(declaredWidth).toBeCloseTo(width, 3);

    for (const line of lines) {
      if (line === "") continue; // A trailing empty wrapped line (rare, width barely fits a whole word) has nothing to measure.
      const renderedWidth = await renderedWidthInChromium(line, fontSizePx);
      expect(renderedWidth, `rendered width of line "${line}"`).toBeLessThanOrEqual(declaredWidth * 1.005);
    }

    await registry.dispatch("element delete", { id: presentationId, slidePath: SLIDE_PATH, elementIds: [elementId] });
  });
});
