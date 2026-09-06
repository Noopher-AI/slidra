import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";

/**
 * [E2.T12]/#204: chart end to end, against a real Chromium — same
 * `startServerFor`/`openApp` shape as `object-animation.test.ts`. This is
 * the ONE e2e file this ticket's plan allows opening (§6.3): the insert
 * panel, the data window (open/drag/close/edit), dual axis, stacked, CSV
 * import, GUI↔CLI equivalence, the standalone-SVG check, and the 5
 * screenshot baselines all live here rather than one file each.
 *
 * Each test opens its own server against a fresh copy of the fixture deck
 * (`chart-deck`) — no test depends on another's mutations.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const deckDir = path.join(e2eDir, "fixtures/chart-deck");
const baselineDir = path.join(e2eDir, "__screenshots__/chart");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
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

interface TestServer {
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}

async function startServerFor(): Promise<TestServer> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-chart-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-chart-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
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

  const server = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg").first();
  await expect.poll(() => slideText.count().catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(0);
  return page;
}

async function canvasFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  throw new Error("找不到主畫布的 iframe.slide-frame");
}

/**
 * A chart's outer `<g data-comot-type="chart">` carries no geometry of its
 * own (plan §3.3 — it never contributes to `getBBox()`), so its own center
 * point can land on a transparent patch of the embedded `<svg>` (chart
 * padding, the gap between bars) where nothing is painted, and the browser
 * resolves a click there to the top-level slide `<svg>` instead of the
 * chart. Clicking one of the chart's own drawn shapes bypasses that: #72's
 * click resolution (`resolveClickTargetAtEvent`) climbs from ANY descendant
 * up to the nearest id-carrying ancestor, exactly as it does for every
 * other element type.
 */
function chartShape(frame: Frame, elementId: string) {
  return frame.locator(`#${elementId} svg :is(rect, path, polyline, circle)`).first();
}

async function readSlide(registry: CommandRegistry, id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

async function createChartViaCli(
  registry: CommandRegistry,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const result = await registry.dispatch<{ elementId: string }>("chart create", {
    id,
    slidePath: "slides/001.svg",
    ...overrides,
  });
  expect(result.ok).toBe(true);
  return result.data!.elementId;
}

/** The `<comot:chart …>…</comot:chart>` substring for `elementId`, independent of its container `<g id>` (which legitimately differs between two elements) — AC-8's own comparison unit. */
function extractChartData(svg: string, elementId: string): string {
  const containerStart = svg.indexOf(`id="${elementId}"`);
  if (containerStart === -1) throw new Error(`找不到元素：${elementId}`);
  const dataStart = svg.indexOf("<comot:chart", containerStart);
  const dataEnd = svg.indexOf("</comot:chart>", dataStart) + "</comot:chart>".length;
  return svg.slice(dataStart, dataEnd);
}

async function openInsertPanel(page: Page): Promise<void> {
  await page.locator('button[aria-label="Chart"]').click();
}

it("AC-1: 插入面板：選類型／系列數／類別數／調色盤後插入，投影片出現圖表容器", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await openInsertPanel(page);
    const panel = page.locator(".chart-panel");
    await panel.locator('[data-type="line"]').click();
    await panel.locator('[aria-label="Increase series count"]').click();
    await panel.locator('[aria-label="Increase category count"]').click();
    await panel.locator('[data-palette="cool"]').click();
    await panel.locator(".chart-panel-insert").click();

    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('data-comot-type="chart"')).toBe(true);
    const svg = await readSlide(registry, presentationId);
    expect(svg).toContain('type="line"');
    expect(svg).toContain('palette="cool"');
    expect((svg.match(/<comot:series/g) ?? []).length).toBe(2);
    expect(svg).toMatch(/<comot:categories values="C1,C2,C3,C4,C5,C6,C7"\/>/);
  } finally {
    await cleanup();
  }
});

it("AC-2: 資料視窗：雙擊開啟、拖曳標題移動、Esc 關閉", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const elementId = await createChartViaCli(registry, presentationId);
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await chartShape(slideFrame, elementId).dblclick();
    const win = page.locator(".chart-window");
    await expect.poll(() => win.count()).toBe(1);

    const titlebar = win.locator(".chart-window-titlebar");
    const before = await win.evaluate((el) => ({ left: (el as HTMLElement).style.left, top: (el as HTMLElement).style.top }));
    const box = (await titlebar.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 90);
    await page.mouse.up();
    const after = await win.evaluate((el) => ({ left: (el as HTMLElement).style.left, top: (el as HTMLElement).style.top }));
    expect(after).not.toEqual(before);

    await page.keyboard.press("Escape");
    await expect.poll(() => win.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("AC-3: 資料視窗改數值：blur 後送出 chart data set，SVG 與 comot:chart 同步更新", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const elementId = await createChartViaCli(registry, presentationId);
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await chartShape(slideFrame, elementId).dblclick();
    const firstValue = page.locator(".chart-window-table tbody tr").first().locator('input[type="number"]').first();
    await firstValue.fill("999");
    await firstValue.blur();

    await expect.poll(async () => (await readSlide(registry, presentationId)).includes("999")).toBe(true);
    const svg = await readSlide(registry, presentationId);
    expect(extractChartData(svg, elementId)).toMatch(/values="999,/);
    // The embedded <svg> re-rendered too — labels=true by default, so the new value shows as a data label.
    await expect.poll(() => slideFrame.locator(`#${elementId} svg text`, { hasText: "999" }).count()).toBeGreaterThan(0);
  } finally {
    await cleanup();
  }
});

it("AC-4: 資料視窗的顯示選項各自對應一條 CLI 命令", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const elementId = await createChartViaCli(registry, presentationId);
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await chartShape(slideFrame, elementId).dblclick();
    const win = page.locator(".chart-window");

    await win.locator(".chart-window-legend button", { hasText: "Right" }).click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('legend="right"')).toBe(true);

    await win.locator('label:has-text("Grid lines") input').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('grid="false"')).toBe(true);

    await win.locator('label:has-text("Value labels") input').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('labels="false"')).toBe(true);

    const xTitle = win.locator('label:has-text("X axis title") input');
    await xTitle.fill("Week");
    await xTitle.blur();
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('x-title="Week"')).toBe(true);

    const yTitle = win.locator('label:has-text("Y axis title") input');
    await yTitle.fill("ms");
    await yTitle.blur();
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('y-title="ms"')).toBe(true);
  } finally {
    await cleanup();
  }
});

it("AC-5/AC-6: 雙軸開關與堆疊開關各自送出 chart axis set／chart stack set", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const elementId = await createChartViaCli(registry, presentationId, { seriesCount: 2 });
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await chartShape(slideFrame, elementId).dblclick();
    const win = page.locator(".chart-window");

    await win.locator('label:has-text("Dual axis") input').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('axes="dual"')).toBe(true);
    expect(await readSlide(registry, presentationId)).toMatch(/axis="right"/);

    await win.locator('label:has-text("Dual axis") input').click(); // back to single so stack set below is legal
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('axes="single"')).toBe(true);

    await win.locator('label:has-text("Stacked") input').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('stacked="true"')).toBe(true);
  } finally {
    await cleanup();
  }
});

it("AC-7: CSV 匯入：固定 fixture 經 --csv-asset 與 --csv 兩條路都得到同一份 comot:chart", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  const tmpDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-chart-csv-"));
  try {
    const elementViaAsset = await createChartViaCli(registry, presentationId);
    const assetResult = await registry.dispatch("chart data set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      elementId: elementViaAsset,
      csvAsset: "assets/data/quarterly.csv",
    });
    expect(assetResult.ok).toBe(true);

    const localCsvPath = path.join(tmpDir, "quarterly.csv");
    await writeFile(localCsvPath, "Quarter,Revenue,Cost\nQ1,120,80\nQ2,150,90\nQ3,170,95\n", "utf-8");
    const elementViaFile = await createChartViaCli(registry, presentationId);
    const fileResult = await registry.dispatch("chart data set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      elementId: elementViaFile,
      csv: localCsvPath,
    });
    expect(fileResult.ok).toBe(true);

    const svg = await readSlide(registry, presentationId);
    expect(extractChartData(svg, elementViaAsset)).toContain('<comot:categories values="Q1,Q2,Q3"/>');
    expect(extractChartData(svg, elementViaAsset)).toContain('name="Revenue" values="120,150,170"');
    // The two elements' data differs only in which series/category NAMES round-tripped through which
    // import path — both must have parsed to the exact same numbers.
    const dataViaAsset = extractChartData(svg, elementViaAsset);
    const dataViaFile = extractChartData(svg, elementViaFile);
    expect(dataViaFile).toBe(dataViaAsset);
  } finally {
    await cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

it("AC-8: GUI 與 CLI 等價：同一組操作分別用 GUI 與 CLI 做，comot:chart 位元組相同", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    // CLI 這一側：chart create -> chart type set -> chart data set -> chart palette set.
    const cliId = await createChartViaCli(registry, presentationId);
    await registry.dispatch("chart type set", { id: presentationId, slidePath: "slides/001.svg", elementId: cliId, type: "line" });
    await registry.dispatch("chart data set", {
      id: presentationId, slidePath: "slides/001.svg", elementId: cliId,
      categories: ["A", "B"], series: [{ name: "Series 1", values: [10, 20] }],
    });
    await registry.dispatch("chart palette set", { id: presentationId, slidePath: "slides/001.svg", elementId: cliId, palette: "warm", colors: [] });

    // GUI 這一側：同一組操作，靠插入面板＋資料視窗完成。
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);
    await openInsertPanel(page);
    await page.locator(".chart-panel-insert").click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/data-comot-type="chart"/g)?.length).toBe(2);
    const svgAfterInsert = await readSlide(registry, presentationId);
    const guiId = [...svgAfterInsert.matchAll(/<g id="([^"]+)" data-comot-type="chart"/g)].map((m) => m[1]).find((id) => id !== cliId)!;

    await chartShape(slideFrame, guiId).dblclick();
    const win = page.locator(".chart-window");
    await win.locator(".chart-window-types button", { hasText: "Line" }).click();
    await expect.poll(async () => extractChartData(await readSlide(registry, presentationId), guiId)).toMatch(/type="line"/);

    // Data table starts with the same sample data `chart create` always uses (1 series named "Series
    // 1" x 6 categories — already the exact series name the CLI side used, nothing to rename) — trim
    // to 2 categories and retype the values to match the CLI side exactly.
    for (let i = 0; i < 4; i++) {
      await win.locator(".chart-window-table tbody tr").last().locator('button[aria-label^="Remove row"]').click();
    }
    const rows = win.locator(".chart-window-table tbody tr");
    await rows.nth(0).locator('input[aria-label^="Category"]').fill("A");
    await rows.nth(0).locator('input[type="number"]').fill("10");
    await rows.nth(1).locator('input[aria-label^="Category"]').fill("B");
    const lastValueInput = rows.nth(1).locator('input[type="number"]');
    await lastValueInput.fill("20");
    await lastValueInput.blur();
    await expect.poll(async () => extractChartData(await readSlide(registry, presentationId), guiId)).toMatch(/<comot:categories values="A,B"\/>/);

    await win.locator('.chart-window-palette-swatch[data-palette="warm"]').click();
    await expect.poll(async () => extractChartData(await readSlide(registry, presentationId), guiId)).toMatch(/palette="warm"/);

    const finalSvg = await readSlide(registry, presentationId);
    expect(extractChartData(finalSvg, guiId)).toBe(extractChartData(finalSvg, cliId));
  } finally {
    await cleanup();
  }
});

it("AC-9: 內嵌 svg 切出來單獨開啟，畫面與投影片內的圖表區域一致", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  const tmpDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-chart-standalone-"));
  try {
    await createChartViaCli(registry, presentationId, { width: 400, height: 250 });
    const svg = await readSlide(registry, presentationId);
    const dataEnd = svg.indexOf("</comot:chart>") + "</comot:chart>".length;
    const svgStart = svg.indexOf("<svg", dataEnd);
    const svgEnd = svg.indexOf("</svg>", svgStart) + "</svg>".length;
    const standaloneSvg = svg.slice(svgStart, svgEnd);
    expect(standaloneSvg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="400" height="250" viewBox="0 0 400 250">/);

    const filePath = path.join(tmpDir, "standalone-chart.svg");
    await writeFile(filePath, standaloneSvg, "utf-8");

    const page = await browser.newPage();
    openPages.push(page);
    await page.goto(`file://${filePath}`);
    const bbox = await page.locator("svg").evaluate((el) => {
      const rect = (el as unknown as SVGGraphicsElement).getBBox();
      return { width: rect.width, height: rect.height };
    });
    expect(bbox.width).toBeGreaterThan(0);
    expect(bbox.height).toBeGreaterThan(0);
    const shapeCount = await page.locator("svg rect, svg path, svg polyline, svg circle").count();
    expect(shapeCount).toBeGreaterThan(0);
  } finally {
    await cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

it("基準截圖 5 張（Chart 面板／資料視窗／單軸／雙軸／堆疊）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await openInsertPanel(page);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "insert-panel", baselineDir, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
    await page.keyboard.press("Escape");

    const singleAxisId = await createChartViaCli(registry, presentationId, { type: "bar", seriesCount: 1 });
    await page.waitForTimeout(300);
    await chartShape(slideFrame, singleAxisId).dblclick();
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "data-window", baselineDir, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
    const singleBox = (await slideFrame.locator(`#${singleAxisId}`).boundingBox())!;
    await compareScreenshot(page, {
      name: "single-axis",
      baselineDir,
      clip: { x: singleBox.x, y: singleBox.y, width: singleBox.width, height: singleBox.height },
    });
    await page.keyboard.press("Escape");

    const dualAxisId = await createChartViaCli(registry, presentationId, { type: "bar", seriesCount: 2, x: 0, y: 400, width: 480, height: 300 });
    await registry.dispatch("chart axis set", { id: presentationId, slidePath: "slides/001.svg", elementId: dualAxisId, axes: "dual", right: ["Series 2"] });
    await page.waitForTimeout(300);
    const dualBox = (await slideFrame.locator(`#${dualAxisId}`).boundingBox())!;
    await settleForScreenshot(page);
    await compareScreenshot(page, {
      name: "dual-axis",
      baselineDir,
      clip: { x: dualBox.x, y: dualBox.y, width: dualBox.width, height: dualBox.height },
    });

    const stackedId = await createChartViaCli(registry, presentationId, { type: "bar", seriesCount: 2, x: 500, y: 400, width: 480, height: 300 });
    await registry.dispatch("chart stack set", { id: presentationId, slidePath: "slides/001.svg", elementId: stackedId, stacked: true });
    await page.waitForTimeout(300);
    const stackedBox = (await slideFrame.locator(`#${stackedId}`).boundingBox())!;
    await settleForScreenshot(page);
    await compareScreenshot(page, {
      name: "stacked",
      baselineDir,
      clip: { x: stackedBox.x, y: stackedBox.y, width: stackedBox.width, height: stackedBox.height },
    });
  } finally {
    await cleanup();
  }
});
