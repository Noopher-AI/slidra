// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Geometry + baseline coverage for the stage (#50): the slide sits centred
 * inside `.canvas-area` at `demo/project.json`'s own canvas ratio
 * (1280×720), auto-scaled to fit with no scrollbar, and recomputes on
 * resize. Modeled on e2e/shell.test.ts's startServerFor/openApp shape —
 * real server, real built dist, real Chromium, `demo/` as fixture.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "docs/demo");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };
// demo/project.json's real canvas — the ratio the stage must match.
const CANVAS_RATIO = 1280 / 720;
// New v3 shell rebuild: `.canvas-area`'s padding is no longer uniform on
// every side. `--space-gutter` (28px top-bottom/left-right) is overridden on
// the bottom edge by `--space-gutter-bottom` (76px) to reserve room for the
// floating Dock (packages/web/src/styles/shell.css's `.canvas-area` rule) —
// 01-DESIGN_TOKENS.md's own token, not a value invented here. The stage is
// therefore centred left/right but pushed 76-28=48px above true vertical
// centre; the "still centred" assertions below check for exactly that
// offset instead of a symmetric margin.
const DOCK_RESERVATION = 76 - 28;

let browser: Browser;
let openPages: Page[] = [];
let server: RunningServer;
let slidraHome: string;
let slidraDir: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, run npm run build first");
  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-stage-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-stage-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "demo.slidra");
  await packDirectory(demoDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test does not send a message",
    },
  };

  server = await startServe({ policy: openPolicy, presentationId: slidraPath, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  if (slidraHome) await rm(slidraHome, { recursive: true, force: true });
  if (slidraDir) await rm(slidraDir, { recursive: true, force: true });
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
  const deckDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-stage-4x3-deck-"));
  await cp(demoDir, deckDir, { recursive: true });
  const projectPath = path.join(deckDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf-8"));
  project.canvas = { width: 4, height: 3 };
  await writeFile(projectPath, JSON.stringify(project, null, 2));

  const savedHome = process.env.SLIDRA_HOME;
  const altHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-stage-4x3-home-"));
  const altFilesDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-stage-4x3-files-"));
  process.env.SLIDRA_HOME = altHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(altFilesDir, "deck.slidra");
  await packDirectory(deckDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test does not send a message",
    },
  };

  const altServer = await startServe({ policy: openPolicy, presentationId: slidraPath, port: 0, agent });

  return {
    server: altServer,
    cleanup: async () => {
      await altServer.close();
      process.env.SLIDRA_HOME = savedHome;
      // slidra serve now spawns the Rust binary for every read/write.
      process.env.SLIDRA_BIN = slidraBin;
      await rm(deckDir, { recursive: true, force: true });
      await rm(altHome, { recursive: true, force: true });
      await rm(altFilesDir, { recursive: true, force: true });
    },
  };
}

/** Measures the rendered `.stage` box and the `.canvas-area` (well) it sits in. */
async function measureStage(page: Page): Promise<{
  stage: { x: number; y: number; width: number; height: number; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
  well: { x: number; y: number; width: number; height: number; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
}> {
  const stageBox = await page.locator(".stage").boundingBox();
  if (!stageBox) throw new Error("could not find .stage");
  const stageScroll = await page.locator(".stage").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }));
  const wellBox = await page.locator(".canvas-area").boundingBox();
  if (!wellBox) throw new Error("could not find .canvas-area");
  const wellScroll = await page.locator(".canvas-area").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }));
  return {
    stage: { ...stageBox, ...stageScroll },
    well: { ...wellBox, ...wellScroll },
  };
}

/** Enters play mode and waits for its own iframe (torn down/rebuilt on
 * entry) to be ready — same wait as play-appearance.test.ts's enterPlay(). */
async function enterPlay(page: Page): Promise<void> {
  await page.locator(".play-button").click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
}

/** Measures the srcdoc document's own `<html>` — separately from
 * `.stage`/`.canvas-area` (both host-document elements) because the
 * scrollbar this guards against is painted *inside* the iframe, on its own
 * documentElement, not on either host box. */
async function measureSrcdocDocument(page: Page): Promise<{
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}> {
  return page.frameLocator("iframe.slide-frame").locator("html").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }));
}

it("the stage's measured aspect ratio matches project.json's canvas.width/height", async () => {
  const page = await openApp();
  const { stage } = await measureStage(page);
  const ratio = stage.width / stage.height;
  expect(Math.abs(ratio - CANVAS_RATIO)).toBeLessThan(0.02);
});

it("non-16:9 canvas: the stage's measured aspect ratio still matches project.json's canvas.width/height, not the CSS 16/9 fallback", async () => {
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

it("the slide is always fully visible: the stage never overflows its gutter area, and the gutter never scrolls", async () => {
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

  // `.stage` itself must not need to clip an
  // overflow — `well`/`stage` above only measured the *host* document's
  // boxes, which said nothing about whether `.stage` (overflow:hidden) or
  // the srcdoc iframe's own document had scroll content to hide in the
  // first place. Edit mode first, then play mode (same iframe class, same
  // .stage/.canvas-area host elements — play.css only re-themes them,
  // shell.css's DOM stays the same).
  expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth);
  expect(stage.scrollHeight).toBeLessThanOrEqual(stage.clientHeight);
  const editSrcdoc = await measureSrcdocDocument(page);
  expect(editSrcdoc.scrollWidth).toBeLessThanOrEqual(editSrcdoc.clientWidth);
  expect(editSrcdoc.scrollHeight).toBeLessThanOrEqual(editSrcdoc.clientHeight);

  await enterPlay(page);
  const playStage = await measureStage(page);
  expect(playStage.stage.scrollWidth).toBeLessThanOrEqual(playStage.stage.clientWidth);
  expect(playStage.stage.scrollHeight).toBeLessThanOrEqual(playStage.stage.clientHeight);
  const playSrcdoc = await measureSrcdocDocument(page);
  expect(playSrcdoc.scrollWidth).toBeLessThanOrEqual(playSrcdoc.clientWidth);
  expect(playSrcdoc.scrollHeight).toBeLessThanOrEqual(playSrcdoc.clientHeight);
});

it("the stage recomputes on window resize, staying centred, fully visible, and scroll-free", async () => {
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

  // Still centred left/right (equal margins within a small tolerance for
  // rounding). Top/bottom is intentionally *not* symmetric any more — see
  // the next assertion's comment (New v3 shell rebuild).
  const leftMargin = after.stage.x - after.well.x;
  const rightMargin = after.well.x + after.well.width - (after.stage.x + after.stage.width);
  expect(Math.abs(leftMargin - rightMargin)).toBeLessThan(1.5);
  const topMargin = after.stage.y - after.well.y;
  const bottomMargin = after.well.y + after.well.height - (after.stage.y + after.stage.height);
  expect(Math.abs(bottomMargin - topMargin - DOCK_RESERVATION)).toBeLessThan(1.5);
});

it("short window (1440x600, height constrains the stage): the ratio holds, no document scrollbar, the stage fully fits the viewport, still centred", async () => {
  const page = await openApp({ width: 1440, height: 600 });
  const { stage, well } = await measureStage(page);

  // The ratio still matches project.json's 16:9 rather than distorting
  // when height is the constraining dimension (a prior bug pinned width to
  // full-width and let only height be constrained, which threw off the ratio).
  const ratio = stage.width / stage.height;
  expect(Math.abs(ratio - CANVAS_RATIO)).toBeLessThan(0.02);

  // No document-level scrollbar (a prior bug had `.main` locked to its
  // content height, overflowing the available space and giving
  // `document.documentElement` a scrollbar as a result).
  const docScroll = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(docScroll.scrollHeight).toBe(docScroll.clientHeight);

  // The stage fits entirely inside the viewport (not just scrollbar-free —
  // its bottom edge really doesn't fall outside the viewport either).
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(stage.y).toBeGreaterThanOrEqual(0);
  expect(stage.y + stage.height).toBeLessThanOrEqual(viewportHeight + 0.5);

  // Still centred left/right; top/bottom is intentionally asymmetric, see
  // the DOCK_RESERVATION comment above (New v3 shell rebuild).
  const leftMargin = stage.x - well.x;
  const rightMargin = well.x + well.width - (stage.x + stage.width);
  expect(Math.abs(leftMargin - rightMargin)).toBeLessThan(1.5);
  const topMargin = stage.y - well.y;
  const bottomMargin = well.y + well.height - (stage.y + stage.height);
  expect(Math.abs(bottomMargin - topMargin - DOCK_RESERVATION)).toBeLessThan(1.5);
});
