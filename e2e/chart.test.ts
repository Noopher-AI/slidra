import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Chart end to end, against a real Chromium — same `startServerFor`/`openApp`
 * shape as `object-animation.test.ts`. The insert panel, the data window
 * (open/drag/close/edit), dual axis, stacked, CSV import, GUI↔CLI
 * equivalence, and the standalone-SVG check all live here rather than one
 * file each.
 *
 * Each test opens its own server against a fresh copy of the fixture deck
 * (`chart-deck`) — no test depends on another's mutations.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const deckDir = path.join(e2eDir, "fixtures/chart-deck");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist does not exist, please run npm run build first");
  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
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
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-chart-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-chart-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test never sends a message",
    },
  };

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  throw new Error("could not find the main canvas's iframe.slide-frame");
}

/**
 * The first shape inside a chart's embedded `<svg>` is the full-viewport
 * transparent hit-area rect `renderChartSvg` opens every chart with, so
 * this resolves to a point anywhere on the chart — padding included. Click
 * resolution (`resolveClickTargetAtEvent`) climbs from ANY descendant
 * up to the nearest id-carrying ancestor, exactly as for every other
 * element type. The "padding is selectable" guarantee itself is guarded by
 * the test below that clicks the chart's blank padding.
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

/** The `<slidra:chart …>…</slidra:chart>` substring for `elementId`, independent of its container `<g id>` (which legitimately differs between two elements) — the unit the GUI/CLI parity test compares. */
function extractChartData(svg: string, elementId: string): string {
  const containerStart = svg.indexOf(`id="${elementId}"`);
  if (containerStart === -1) throw new Error(`could not find element: ${elementId}`);
  const dataStart = svg.indexOf("<slidra:chart", containerStart);
  const dataEnd = svg.indexOf("</slidra:chart>", dataStart) + "</slidra:chart>".length;
  return svg.slice(dataStart, dataEnd);
}

async function openInsertPanel(page: Page): Promise<void> {
  await page.locator('button[aria-label="Chart"]').click();
}

it("insert panel: choose type/series count/category count/palette then insert, and a chart container appears on the slide", async () => {
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

    await expect.poll(async () => (await readSlide(registry, presentationId)).includes('data-slidra-type="chart"')).toBe(true);
    const svg = await readSlide(registry, presentationId);
    expect(svg).toContain('type="line"');
    expect(svg).toContain('palette="cool"');
    expect((svg.match(/<slidra:series/g) ?? []).length).toBe(2);
    expect(svg).toMatch(/<slidra:categories values="C1,C2,C3,C4,C5,C6,C7"\/>/);
  } finally {
    await cleanup();
  }
});

it("clicking on the chart's blank padding (the embedded svg's top-left corner) also selects the chart, and the selection box equals the whole chart viewport", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const elementId = await createChartViaCli(registry, presentationId);
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    // The W×H viewport in page coordinates, via getScreenCTM() — NOT
    // boundingBox(), which for an embedded <svg> is the union of painted
    // content and would shrink onto the tick labels without the hit-area rect.
    const frameBox = (await page.locator("iframe.slide-frame").boundingBox())!;
    const viewport = await slideFrame.locator(`#${elementId} svg`).evaluate((el) => {
      const svg = el as SVGSVGElement;
      const ctm = svg.getScreenCTM()!;
      return {
        x: ctm.e,
        y: ctm.f,
        width: Number(svg.getAttribute("width")) * ctm.a,
        height: Number(svg.getAttribute("height")) * ctm.d,
      };
    });
    // 4px in from the viewport's top-left corner: nothing but the hit-area rect is painted there.
    await page.mouse.click(frameBox.x + viewport.x + 4, frameBox.y + viewport.y + 4);

    await expect.poll(() => page.locator(".status-selection-chip").textContent().then((t) => t?.trim())).toMatch(/^Selected: /);
    // The outer <g>'s outline must be the W×H viewport, not the union of painted content.
    const outer = (await slideFrame.locator(`#${elementId}`).boundingBox())!;
    expect(Math.abs(outer.x - (frameBox.x + viewport.x))).toBeLessThan(1);
    expect(Math.abs(outer.y - (frameBox.y + viewport.y))).toBeLessThan(1);
    expect(Math.abs(outer.width - viewport.width)).toBeLessThan(1);
    expect(Math.abs(outer.height - viewport.height)).toBeLessThan(1);
  } finally {
    await cleanup();
  }
});

it("data window: double-click to open, drag the titlebar to move, Esc to close", async () => {
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

it("changing a value in the data window: on blur it sends chart data set, and the SVG and slidra:chart update in sync", async () => {
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

it("each display option in the data window maps to its own CLI command", async () => {
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

it("the dual-axis toggle and the stacked toggle each send chart axis set / chart stack set", async () => {
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

// A CSV import test (--csv-asset and --csv both produce the same
// slidra:chart) was removed here: it never opened a browser (only
// `registry.dispatch` calls, same as `packages/cli/test/chart.test.ts`), so
// it belonged at the cheaper CLI-layer, not in `e2e/`. Its one assertion
// beyond what that file's existing `--csv`/`--csv-asset` tests already cover
// — that the two input paths produce byte-identical `<slidra:chart>` data —
// now lives at `packages/cli/test/chart.test.ts`'s test verifying that
// `--csv` and `--csv-asset` produce byte-identical `<slidra:chart>` content.

it("GUI and CLI parity: the same set of operations done via GUI vs. CLI produce identical slidra:chart bytes", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    // CLI side: chart create -> chart type set -> chart data set -> chart palette set.
    const cliId = await createChartViaCli(registry, presentationId);
    await registry.dispatch("chart type set", { id: presentationId, slidePath: "slides/001.svg", elementId: cliId, type: "line" });
    await registry.dispatch("chart data set", {
      id: presentationId, slidePath: "slides/001.svg", elementId: cliId,
      categories: ["A", "B"], series: [{ name: "Series 1", values: [10, 20] }],
    });
    await registry.dispatch("chart palette set", { id: presentationId, slidePath: "slides/001.svg", elementId: cliId, palette: "warm", colors: [] });

    // GUI side: the same set of operations, done via the insert panel + data window.
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);
    await openInsertPanel(page);
    await page.locator(".chart-panel-insert").click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/data-slidra-type="chart"/g)?.length).toBe(2);
    const svgAfterInsert = await readSlide(registry, presentationId);
    const guiId = [...svgAfterInsert.matchAll(/<g id="([^"]+)" data-slidra-type="chart"/g)].map((m) => m[1]).find((id) => id !== cliId)!;

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
    await expect.poll(async () => extractChartData(await readSlide(registry, presentationId), guiId)).toMatch(/<slidra:categories values="A,B"\/>/);

    await win.locator('.chart-window-palette-swatch[data-palette="warm"]').click();
    await expect.poll(async () => extractChartData(await readSlide(registry, presentationId), guiId)).toMatch(/palette="warm"/);

    const finalSvg = await readSlide(registry, presentationId);
    expect(extractChartData(finalSvg, guiId)).toBe(extractChartData(finalSvg, cliId));

    // --- Serialization regression check: delay the first `chart data set`
    // response by 800ms before letting it through; the rest are not delayed.
    // Without serialization, a later command lands first and the delayed
    // stale payload overwrites it when it finally lands; with serialization,
    // the second command is never even sent until the first completes.
    // Wait for all in-flight requests to land before reading final state
    // (see the waitForTimeout below): without the serialization queue this
    // reliably fails on the toContain assertion below; with it, it passes.
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".chart-window").count()).toBe(0);
    const raceId = await createChartViaCli(registry, presentationId);
    let delayedFirstDataSet = false;
    await page.route("**/api/command", async (route) => {
      const body = route.request().postDataJSON() as { name?: string } | null;
      if (body?.name === "chart data set" && !delayedFirstDataSet) {
        delayedFirstDataSet = true;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      await route.continue();
    });
    await chartShape(slideFrame, raceId).dblclick();
    const raceWin = page.locator(".chart-window");
    const wantValues = ["11", "22", "33", "44", "55", "66"];
    for (let i = 0; i < wantValues.length; i++) {
      const input = raceWin.locator(".chart-window-table tbody tr").nth(i).locator('input[type="number"]');
      await input.fill(wantValues[i]);
      await input.blur();
    }
    // Let all in-flight requests land before reading final state: `expect.poll`
    // would otherwise pass as soon as it sees a correct intermediate value,
    // while without serialization the first command (delayed 800ms) is the
    // one that lands last and overwrites the payload with a stale value.
    await page.waitForTimeout(3000);
    await expect
      .poll(async () => extractChartData(await readSlide(registry, presentationId), raceId), { timeout: 5_000 })
      .toContain(`values="${wantValues.join(",")}"`);
    await page.unroute("**/api/command");
  } finally {
    await cleanup();
  }
});

it("the embedded svg cut out and opened standalone renders identically to the chart area inside the slide", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  const tmpDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-chart-standalone-"));
  try {
    await createChartViaCli(registry, presentationId, { width: 400, height: 250 });
    const svg = await readSlide(registry, presentationId);
    const dataEnd = svg.indexOf("</slidra:chart>") + "</slidra:chart>".length;
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

it("chart panel / data window / single-axis / dual-axis / stacked: their respective structure and data assertions", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = await canvasFrame(page);

    await openInsertPanel(page);
    // `chart-panel-insert [data-field=palette]` — that selector does not
    // exist in the code; the assertions below use the panel's real nodes and classes instead.
    const insertPanel = page.locator(".chart-panel");
    expect(await insertPanel.isVisible()).toBe(true);
    expect(await insertPanel.locator(".chart-panel-type").count()).toBe(6);
    expect(await insertPanel.locator(".chart-panel-palette").count()).toBe(3);
    const increaseSeries = insertPanel.locator('[aria-label="Increase series count"]');
    const increaseCategories = insertPanel.locator('[aria-label="Increase category count"]');
    expect(await increaseSeries.count()).toBe(1);
    expect(await increaseCategories.count()).toBe(1);
    expect(await increaseSeries.isEnabled()).toBe(true);
    expect(await increaseCategories.isEnabled()).toBe(true);
    expect(await insertPanel.locator(".chart-panel-insert").isEnabled()).toBe(true);
    await page.keyboard.press("Escape");

    const singleAxisId = await createChartViaCli(registry, presentationId, { type: "bar", seriesCount: 1 });
    await page.waitForTimeout(300);
    await chartShape(slideFrame, singleAxisId).dblclick();
    // Guard on the double-click wiring itself — if double-click isn't wired up, `.chart-window` never opens and the next two assertions fail.
    expect(await page.locator(".chart-window").count()).toBe(1);
    expect(await page.locator(".chart-window-table tbody tr").count()).toBe(6);
    // Single-axis slidra:chart attribute, plus the embedded svg's tick node count (5 on the left axis, 0 on the right).
    const singleAxisData = extractChartData(await readSlide(registry, presentationId), singleAxisId);
    expect(singleAxisData).toMatch(/axes="single"/);
    expect(await slideFrame.locator(`#${singleAxisId} svg text[text-anchor="end"]`).count()).toBe(5);
    expect(await slideFrame.locator(`#${singleAxisId} svg text[text-anchor="start"]`).count()).toBe(0);
    await page.keyboard.press("Escape");

    const dualAxisId = await createChartViaCli(registry, presentationId, { type: "bar", seriesCount: 2, x: 0, y: 400, width: 480, height: 300 });
    await registry.dispatch("chart axis set", { id: presentationId, slidePath: "slides/001.svg", elementId: dualAxisId, axes: "dual", right: ["Series 2"] });
    await page.waitForTimeout(300);
    // Dual-axis slidra:chart attribute (at least one series marked axis="right") and the right axis's tick node count (5).
    const dualAxisData = extractChartData(await readSlide(registry, presentationId), dualAxisId);
    expect(dualAxisData).toMatch(/axes="dual"/);
    expect(dualAxisData).toMatch(/<slidra:series[^>]*axis="right"/);
    expect(await slideFrame.locator(`#${dualAxisId} svg text[text-anchor="start"]`).count()).toBe(5);

    const stackedId = await createChartViaCli(registry, presentationId, { type: "bar", seriesCount: 2, x: 500, y: 400, width: 480, height: 300 });
    await registry.dispatch("chart stack set", { id: presentationId, slidePath: "slides/001.svg", elementId: stackedId, stacked: true });
    await page.waitForTimeout(300);
    // Stacked slidra:chart attribute, plus: 12 bars grouped by x into 6 groups,
    // where each group's top bar's y+height exactly equals its bottom bar's y
    // (not recomputing the geometry — just asserting the bars meet edge to edge).
    const stackedData = extractChartData(await readSlide(registry, presentationId), stackedId);
    expect(stackedData).toMatch(/stacked="true"/);
    // `fill="transparent"` excludes the full-viewport hit-area rect every chart opens with.
    const stackedBars = slideFrame.locator(`#${stackedId} svg rect:not([rx]):not([fill="transparent"])`);
    expect(await stackedBars.count()).toBe(12);
    const barRects = await stackedBars.evaluateAll((elements) =>
      elements.map((el) => ({
        x: Number(el.getAttribute("x")),
        y: Number(el.getAttribute("y")),
        height: Number(el.getAttribute("height")),
      })),
    );
    const barGroups = new Map<number, typeof barRects>();
    for (const rect of barRects) barGroups.set(rect.x, [...(barGroups.get(rect.x) ?? []), rect]);
    expect(barGroups.size).toBe(6);
    for (const group of barGroups.values()) {
      expect(group).toHaveLength(2);
      const [top, bottom] = [...group].sort((a, b) => a.y - b.y);
      expect(top.y + top.height).toBeCloseTo(bottom.y, 3);
    }
  } finally {
    await cleanup();
  }
});
