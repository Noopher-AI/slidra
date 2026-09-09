import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { resolveWorkDir } from "@co-motion/core";
import { requireBuilt } from "./helpers/launch.js";

/**
 * Ticket #71's original AC ("同一段文字在 Node 與瀏覽器量出的寬度一致") no
 * longer applies: F8 (NOOP-289) deletes the browser's own font-metrics
 * engine (`text-metrics.ts`, `window.coMotionMeasureText`) entirely — the
 * browser never measures text at all any more, it only displays what the
 * CLI already wrapped. This file now verifies the CLI's OUTPUT instead
 * (父票 wording): write a text box with the CLI (`textbox add`), read back
 * the `<tspan>` lines it actually wrote, and confirm each line's real
 * Chromium-rendered width (`getComputedTextLength()`, the same external
 * ground truth the old A5 section already used) fits inside the declared
 * `data-comot-text-width` — proving the server-side wrap decision agrees
 * with what a real browser draws, not just with another run of the same
 * code.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/co-motion");
const fontPath = path.join(rootDir, "packages/core/src/assets/fonts/NotoSansTC-Presentation.ttf");

const FAMILY = "Noto Sans TC";
const SLIDE_PATH = "slides/001.svg";

interface Sample {
  label: string;
  text: string;
  width: number;
  fontSizePx: number;
}

const SAMPLES: Sample[] = [
  { label: "純 ASCII，窄寬度強制換行", text: "Hello CoMotion this text should wrap across several lines", width: 220, fontSizePx: 28 },
  { label: "純中文，窄寬度強制換行", text: "投影片文字量測與換行行為驗證", width: 200, fontSizePx: 32 },
  { label: "中英混排", text: "CoMotion 是一個簡報工具，支援 agent 協作", width: 260, fontSizePx: 24 },
  { label: "寬度足夠，單行不換行", text: "Hi", width: 400, fontSizePx: 40 },
];

let browser: Browser;
let page: Page;
let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let presentationId: string;
let fontDataUrl: string;

beforeAll(async () => {
  await requireBuilt(rootDir);

  const fontBytes = await readFile(fontPath);
  fontDataUrl = `data:font/ttf;base64,${fontBytes.toString("base64")}`;

  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-text-metrics-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-text-metrics-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  // [E4.T9]/F7: co-motion serve now spawns the Rust binary for every read/write.
  process.env.CO_MOTION_BIN = coMotionBin;

  registry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "字型量測煙霧測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  presentationId = opened.data!.id;
}, 60_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  delete process.env.CO_MOTION_HOME;
  delete process.env.CO_MOTION_BIN;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

/** `<tspan>` line texts and `data-comot-text-width`, read straight off the CLI-written file — this is "驗證 CLI 輸出", not a second parser. */
async function readTextboxLines(elementId: string): Promise<{ lines: string[]; width: number }> {
  const workDir = await resolveWorkDir(presentationId);
  const svg = await readFile(path.join(workDir, SLIDE_PATH), "utf-8");
  const openTagMatch = new RegExp(`<g id="${elementId}"[^>]*data-comot-text-width="([^"]+)"[^>]*>`).exec(svg);
  if (!openTagMatch) throw new Error(`找不到文字框容器：${elementId}`);
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

describe("CLI 的文字框換行輸出 vs Chromium 實際渲染", () => {
  it.each(SAMPLES)("$label：CLI 寫出的每一行，Chromium 實際渲染寬度都不超過宣告的 data-comot-text-width（容差 0.5%，沿用原 A5 論證）", async ({ text, width, fontSizePx }) => {
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
      expect(renderedWidth, `行 "${line}" 的實際渲染寬度`).toBeLessThanOrEqual(declaredWidth * 1.005);
    }

    await registry.dispatch("element delete", { id: presentationId, slidePath: SLIDE_PATH, elementIds: [elementId] });
  });
});
