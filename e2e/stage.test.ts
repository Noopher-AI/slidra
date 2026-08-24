import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot } from "./helpers/screenshot.js";

/**
 * Geometry + baseline coverage for the stage (#50): the slide sits centred
 * inside `.canvas-area` at `demo/project.json`'s own canvas ratio
 * (1280×720), auto-scaled to fit with no scrollbar, and recomputes on
 * resize. Modeled on e2e/shell.test.ts's startServerFor/openApp shape —
 * real server, real built dist, real Chromium, `demo/` as fixture.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/stage");

const VIEWPORT = { width: 1440, height: 900 };
// demo/project.json's real canvas — the ratio the stage must match.
const CANVAS_RATIO = 1280 / 720;

let browser: Browser;
let openPages: Page[] = [];
let server: RunningServer;
let coMotionHome: string;
let comotDir: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-stage-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-stage-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "demo.comot");
  await packDirectory(demoDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "此測試不會送出訊息",
    },
  };

  server = await startServe({ registry, presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.CO_MOTION_HOME;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

/** Loads the app and waits for the first slide to actually be painted before returning the page. */
async function openApp(viewport = VIEWPORT, targetServer: RunningServer = server): Promise<Page> {
  const page = await browser.newPage({ viewport });
  openPages.push(page);
  await page.goto(targetServer.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * Builds a copy of `demo/` whose `project.json`'s canvas is deliberately
 * NOT 16:9 (4:3), then serves it on its own server. `demo/`'s own canvas is
 * 1280×720 — exactly 16:9, the same ratio as stage.css's CSS fallback — so
 * a stage measured against `demo/` alone can't tell "reads canvasSize" apart
 * from "silently uses the CSS fallback". A 4:3 canvas can.
 */
async function startNonWidescreenServer(): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const deckDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-stage-4x3-deck-"));
  await cp(demoDir, deckDir, { recursive: true });
  const projectPath = path.join(deckDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf-8"));
  project.canvas = { width: 4, height: 3 };
  await writeFile(projectPath, JSON.stringify(project, null, 2));

  const savedHome = process.env.CO_MOTION_HOME;
  const altHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-stage-4x3-home-"));
  const altFilesDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-stage-4x3-files-"));
  process.env.CO_MOTION_HOME = altHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(altFilesDir, "deck.comot");
  await packDirectory(deckDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "此測試不會送出訊息",
    },
  };

  const altServer = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server: altServer,
    cleanup: async () => {
      await altServer.close();
      process.env.CO_MOTION_HOME = savedHome;
      await rm(deckDir, { recursive: true, force: true });
      await rm(altHome, { recursive: true, force: true });
      await rm(altFilesDir, { recursive: true, force: true });
    },
  };
}

/** Measures the rendered `.stage` box and the `.canvas-area` (well) it sits in. */
async function measureStage(page: Page): Promise<{
  stage: { x: number; y: number; width: number; height: number };
  well: { x: number; y: number; width: number; height: number; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
}> {
  const stageBox = await page.locator(".stage").boundingBox();
  if (!stageBox) throw new Error("找不到 .stage");
  const wellBox = await page.locator(".canvas-area").boundingBox();
  if (!wellBox) throw new Error("找不到 .canvas-area");
  const wellScroll = await page.locator(".canvas-area").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }));
  return {
    stage: stageBox,
    well: { ...wellBox, ...wellScroll },
  };
}

it("舞台的實測寬高比等於 project.json 的 canvas.width/height", async () => {
  const page = await openApp();
  const { stage } = await measureStage(page);
  const ratio = stage.width / stage.height;
  expect(Math.abs(ratio - CANVAS_RATIO)).toBeLessThan(0.02);
});

it("非 16:9 畫布：舞台的實測寬高比仍等於 project.json 的 canvas.width/height，而非 CSS 的 16/9 fallback", async () => {
  const { server: altServer, cleanup } = await startNonWidescreenServer();
  try {
    const page = await openApp(VIEWPORT, altServer);
    const { stage } = await measureStage(page);
    const ratio = stage.width / stage.height;
    expect(Math.abs(ratio - 4 / 3)).toBeLessThan(0.02);
  } finally {
    await cleanup();
  }
});

it("投影片永遠完整可見：舞台不超出留白區，留白區不出現捲軸", async () => {
  const page = await openApp();
  const { stage, well } = await measureStage(page);

  // No scrollbar anywhere in the well, at this viewport size.
  expect(well.scrollWidth).toBe(well.clientWidth);
  expect(well.scrollHeight).toBe(well.clientHeight);

  // The stage box sits entirely inside the well's own box (margin, never overflow).
  expect(stage.x).toBeGreaterThanOrEqual(well.x - 0.5);
  expect(stage.y).toBeGreaterThanOrEqual(well.y - 0.5);
  expect(stage.x + stage.width).toBeLessThanOrEqual(well.x + well.width + 0.5);
  expect(stage.y + stage.height).toBeLessThanOrEqual(well.y + well.height + 0.5);
});

it("視窗大小改變時舞台重新計算，仍然置中且完整可見、不出捲軸", async () => {
  const page = await openApp();
  const before = await measureStage(page);

  // Resize to a visibly different window shape and re-measure.
  await page.setViewportSize({ width: 1024, height: 720 });
  // Let layout settle: no explicit resize hook to await, so poll until the
  // stage box has actually moved/resized from its previous measurement.
  await expect
    .poll(async () => (await page.locator(".stage").boundingBox())?.width)
    .not.toBe(before.stage.width);
  const after = await measureStage(page);

  const ratio = after.stage.width / after.stage.height;
  expect(Math.abs(ratio - CANVAS_RATIO)).toBeLessThan(0.02);
  expect(after.well.scrollWidth).toBe(after.well.clientWidth);
  expect(after.well.scrollHeight).toBe(after.well.clientHeight);

  // Still centred inside the well (equal margins left/right, top/bottom
  // within a small tolerance for rounding).
  const leftMargin = after.stage.x - after.well.x;
  const rightMargin = after.well.x + after.well.width - (after.stage.x + after.stage.width);
  expect(Math.abs(leftMargin - rightMargin)).toBeLessThan(1.5);
  const topMargin = after.stage.y - after.well.y;
  const bottomMargin = after.well.y + after.well.height - (after.stage.y + after.stage.height);
  expect(Math.abs(topMargin - bottomMargin)).toBeLessThan(1.5);
});

it("基準截圖：標準檢視的舞台（深色投影片、可辨的邊界）", async () => {
  const page = await openApp();
  const wellBox = await page.locator(".canvas-area").boundingBox();
  if (!wellBox) throw new Error("找不到 .canvas-area");
  await compareScreenshot(page, {
    name: "standard-stage",
    baselineDir,
    clip: wellBox,
  });
});
