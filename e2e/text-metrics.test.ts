import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { measurePresentationText } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Ticket #71, AC "同一段文字在 Node 與瀏覽器量出的寬度一致（e2e 驗證）".
 *
 * Proves two things a unit test cannot:
 *
 * - A2/A4: the browser actually loads the container's embedded font (not a
 *   system font) via `@font-face` + `/api/raw/`, and Node's
 *   `measurePresentationText` and the browser's `window.coMotionMeasureText`
 *   — same font bytes, same `text-metrics.ts` module — return the exact
 *   same number for the same input (`toBe`, not `toBeCloseTo`).
 * - A5: that number is not merely "the same code ran twice" — it also
 *   matches what Chromium itself renders, via a real `<svg><text>`'s
 *   `getComputedTextLength()`, within a small tolerance (font hinting/
 *   rounding differences between the sfnt-table math here and the
 *   browser's own text layout engine are expected; a large mismatch would
 *   mean the measurement is wrong even though it agrees with itself).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const webDistEntry = path.join(rootDir, "packages/web/dist/text-metrics-entry.js");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const FAMILY = "Noto Sans TC";
const FONT_URL = "/api/raw/fonts/NotoSansTC-Presentation.ttf";

const SAMPLES: Array<{ label: string; text: string; fontSizePx: number }> = [
  { label: "純 ASCII", text: "Hello, CoMotion!", fontSizePx: 48 },
  { label: "純中文", text: "投影片文字量測", fontSizePx: 36 },
  { label: "中英混排", text: "CoMotion 是一個簡報工具", fontSizePx: 24 },
  { label: "含空白", text: "a b  c   d", fontSizePx: 60 },
  { label: "含 cmap 未涵蓋字元（emoji）", text: "標題😀結尾", fontSizePx: 40 },
];

let browser: Browser;
let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let server: RunningServer;
let presentationId: string;
let page: Page;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(webDistEntry, "packages/web/dist/text-metrics-entry.js 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-text-metrics-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-text-metrics-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  registry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "字型量測煙霧測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "unused",
    },
  };

  server = await startServe({ registry, presentationId, port: 0, agent });

  page = await browser.newPage();
  await page.goto(server.url);
  await page.addScriptTag({ url: "/text-metrics-entry.js" });
  await page.waitForFunction(() => typeof (window as unknown as { coMotionMeasureText?: unknown }).coMotionMeasureText === "function");
}, 60_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await server?.close();
  delete process.env.CO_MOTION_HOME;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

describe("Node vs 瀏覽器的文字寬度量測", () => {
  it.each(SAMPLES)("$label 在兩端量出完全相同的寬度", async ({ text, fontSizePx }) => {
    const nodeWidth = await measurePresentationText(presentationId, { family: FAMILY, text, fontSizePx });
    const browserWidth = await page.evaluate(
      ([url, sampleText, size]) =>
        (window as unknown as { coMotionMeasureText: (u: string, t: string, s: number) => Promise<number> }).coMotionMeasureText(
          url,
          sampleText,
          size,
        ),
      [FONT_URL, text, fontSizePx] as const,
    );

    expect(browserWidth).toBe(nodeWidth);
  });

  it("量出的寬度與 Chromium 實際渲染的 getComputedTextLength() 相對誤差 ≤ 0.5%（A5）", async () => {
    const text = "投影片 CoMotion 文字量測";
    const fontSizePx = 48;

    const measuredWidth = await measurePresentationText(presentationId, { family: FAMILY, text, fontSizePx });

    const renderedWidth = await page.evaluate(
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
      [FONT_URL, FAMILY, text, fontSizePx] as const,
    );

    const relativeError = Math.abs(renderedWidth - measuredWidth) / measuredWidth;
    expect(relativeError).toBeLessThanOrEqual(0.005);
  });
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
