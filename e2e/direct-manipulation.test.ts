import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory, resolvePresentationFonts, wrapText } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * NOOP-91's real Chromium acceptance tests, modelled on
 * e2e/selection.test.ts and e2e/stage.test.ts's startServerFor/openApp
 * shape: a real server, a real built `packages/web/dist`, and the
 * `e2e/fixtures/direct-manipulation-deck` fixture (`demo/` has no second
 * element close enough to exercise snapping without bending its layout,
 * per the plan's own assumption note).
 *
 * SCOPE DELIVERED: drag-to-move (live preview, single command, snap,
 * Alt-disables-snap), multi-select drag, marquee select, scale/rotate
 * handles, textbox-width handles, and group-edit entry/exit (double-click
 * in, Esc out). See the PR body for the exact acceptance-list coverage.
 *
 * The fixture's `project.json` declares one embedded font
 * ("Noto Sans TC", for `el-text`'s textbox-width tests) but does not carry
 * the font FILE itself — a 5.4 MB binary has no business living twice in
 * this repo when `packages/core/src/assets/fonts` already ships it for
 * every other font-dependent test. `startServerFor` below copies the
 * fixture into a throwaway temp directory and injects the real font bytes
 * into it before packing, so the checked-in fixture stays tiny.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/direct-manipulation-deck");
const presentationFontDir = path.join(rootDir, "packages/core/src/assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };
const VIEWBOX = { width: 1280, height: 720 };

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

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-dm-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-dm-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-dm-deck-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  // Copy the checked-in fixture into a throwaway staging dir, then inject
  // the real embedded-font bytes (see this file's header comment) — the
  // fixture's own project.json already declares the font entry, it just
  // has no `fonts/` directory checked in for packDirectory to pick up.
  await cp(deckDir, deckStagingDir, { recursive: true });
  await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
  await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckStagingDir, comotPath);
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
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
      await rm(deckStagingDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return page;
}

/** Same disambiguation e2e/selection.test.ts uses: the main canvas iframe, not an overview thumbnail. */
async function canvasFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  throw new Error("找不到主畫布的 iframe.slide-frame");
}

async function readSlide(registry: CommandRegistry, presentationId: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

/** The main-canvas `<svg>`'s bounding box in PAGE (viewport) coordinates — what `page.mouse` expects. */
async function svgBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const svg = page.frameLocator("iframe.slide-frame").locator("svg").first();
  const box = await svg.boundingBox();
  if (!box) throw new Error("量不到主畫布 svg 的邊界框");
  return box;
}

/** Converts a point in the fixture's own user-unit space (viewBox 0 0 1280 720) to a page-viewport point. */
function toPagePoint(box: { x: number; y: number; width: number; height: number }, userX: number, userY: number) {
  return { x: box.x + (userX / VIEWBOX.width) * box.width, y: box.y + (userY / VIEWBOX.height) * box.height };
}

/**
 * The snap threshold in user units, computed the exact way canvas.ts does
 * (8 screen px converted through the measured svg<->viewBox ratio) — so a
 * test can pick an offset that is reliably inside or outside it regardless
 * of how big the stage renders at VIEWPORT's size.
 */
function snapThresholdUser(box: { width: number }): number {
  return 8 * (VIEWBOX.width / box.width);
}

interface DragOptions {
  alt?: boolean;
  /** Called with the page still mid-drag (button down, before mouseup) — for reading the live preview. */
  onMidDrag?: () => Promise<void>;
}

async function dragBy(
  page: Page,
  fromUser: { x: number; y: number },
  deltaUser: { x: number; y: number },
  options: DragOptions = {},
): Promise<void> {
  const box = await svgBox(page);
  const from = toPagePoint(box, fromUser.x, fromUser.y);
  const to = toPagePoint(box, fromUser.x + deltaUser.x, fromUser.y + deltaUser.y);
  if (options.alt) await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  // Let the rAF-throttled gesture-move postMessage land before continuing.
  await page.waitForTimeout(80);
  if (options.onMidDrag) await options.onMidDrag();
  await page.mouse.up();
  if (options.alt) await page.keyboard.up("Alt");
  // POST /api/command round trip + the file write it causes.
  await page.waitForTimeout(150);
}

/** `translate(x y)` -> `{x, y}`. Throws if the element carries no such transform. */
function readTranslate(svg: string, elementId: string): { x: number; y: number } {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  if (!elementMatch) throw new Error(`找不到 ${elementId} 的 transform`);
  const translateMatch = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(elementMatch[1]);
  if (!translateMatch) throw new Error(`${elementId} 的 transform 沒有 translate：${elementMatch[1]}`);
  return { x: Number(translateMatch[1]), y: Number(translateMatch[2]) };
}

/** Raw `transform` attribute string on `elementId`'s own `<g>` (possibly ""), for scale/rotate assertions that need the whole transform-list, not just translate. */
function readTransformAttr(svg: string, elementId: string): string {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  return elementMatch ? elementMatch[1] : "";
}

/** `scale(sx sy)` (or `scale(s)`) -> `{sx, sy}`; identity (1, 1) when absent. */
function readScale(transform: string): { sx: number; sy: number } {
  const match = /scale\(([-\d.]+)(?:\s+([-\d.]+))?\)/.exec(transform);
  if (!match) return { sx: 1, sy: 1 };
  const sx = Number(match[1]);
  return { sx, sy: match[2] !== undefined ? Number(match[2]) : sx };
}

/** `rotate(deg)` -> `deg`; 0 when absent. */
function readRotation(transform: string): number {
  const match = /rotate\(([-\d.]+)\)/.exec(transform);
  return match ? Number(match[1]) : 0;
}

/** Inverse of `toPagePoint`: page-viewport pixel -> the fixture's own user-unit space. Mirrors canvas.ts's own `toUserPoint` (same linear svgRect<->viewBox mapping), so a test can hand-compute the exact user-space point a given mouse position resolves to. */
function toUserPointTest(box: { x: number; y: number; width: number; height: number }, pageX: number, pageY: number) {
  return { x: ((pageX - box.x) / box.width) * VIEWBOX.width, y: ((pageY - box.y) / box.height) * VIEWBOX.height };
}

/** Rotates a 2D vector by `deltaDeg` degrees using SVG's own y-down clockwise-positive convention — the exact inverse of the angle math canvas.ts's rotate gesture uses, so a test can construct a "now" point that is guaranteed to produce a known delta. */
function rotateVector(v: { x: number; y: number }, deltaDeg: number): { x: number; y: number } {
  const rad = (deltaDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

/** The page-viewport bounding box (center point) of one of selection-runtime.js's `data-comot-handle` elements — Playwright's locator pierces the open shadow root and translates the nested-iframe coordinate system automatically. */
async function handleCenter(page: Page, name: string): Promise<{ x: number; y: number }> {
  const handle = page.frameLocator("iframe.slide-frame").locator(`[data-comot-handle="${name}"]`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`量不到把手 ${name} 的邊界框（可能還沒顯示）`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags from one exact page point to another (unlike `dragBy`, which takes fixture user-space coordinates) — for handle-driven gestures, whose start point must land on a small (9px) handle element rather than anywhere inside the target's own bounds. */
async function dragPageTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

it("拖曳單一元素放手後：預覽字串與寫入檔案的字串逐字元相同，整次拖曳只產生一條命令", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    expect(readTranslate(before, "el-a")).toEqual({ x: 100, y: 100 });

    let livePreview: string | null = null;
    await dragBy(
      page,
      { x: 180, y: 150 }, // inside el-a (100..260, 100..200)
      { x: 60, y: 40 },
      {
        onMidDrag: async () => {
          const frame = await canvasFrame(page);
          livePreview = await frame.evaluate(() => document.getElementById("el-a")?.getAttribute("transform") ?? null);
        },
      },
    );

    const after = await readSlide(registry, presentationId);
    const finalMatch = /<g id="el-a"[^>]*transform="([^"]*)"/.exec(after);
    expect(finalMatch).not.toBeNull();
    // AC2: the transform shown live during the drag is byte-for-byte the
    // same string that ends up written to the SVG file.
    expect(livePreview).toBe(finalMatch![1]);

    const moved = readTranslate(after, "el-a");
    expect(moved.x).toBeGreaterThan(100);
    expect(moved.y).toBeGreaterThan(100);

    // AC1: exactly one command — a single undo returns the file to its
    // original bytes.
    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("拖曳到與另一元素左緣相距在吸附半徑內：放手後兩者左緣完全相等，且畫出/清除輔助線", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // el-b's own left edge is x=700 (translate(700 300), rect x=0). Aim the
    // raw drag AT that exact edge, rather than a hair short of it: el-a is
    // wider than el-b (160 vs 140), so its centre line sits far enough from
    // el-b's centre that even the real mouse-pixel rounding this drag goes
    // through cannot make the centre match closer than the left edge —
    // landing short (as an earlier version of this test did) risked the
    // opposite: snapping to the CLOSER centre-to-centre line instead of the
    // left edge this test means to prove.
    const targetLeft = 700;
    const dx = targetLeft - 100; // el-a starts at x=100
    const dy = 250; // deliberately not aligned with anything, to isolate the x-axis snap

    let guidesSeenDuringDrag = false;
    await dragBy(
      page,
      { x: 180, y: 150 },
      { x: dx, y: dy },
      {
        onMidDrag: async () => {
          const frame = await canvasFrame(page);
          const guideCount = await frame.evaluate(() => {
            const host = document.querySelector("[data-comot-selection-host]") as HTMLElement | null;
            return host?.shadowRoot?.querySelectorAll(".guide").length ?? 0;
          });
          guidesSeenDuringDrag = guideCount > 0;
        },
      },
    );

    expect(guidesSeenDuringDrag).toBe(true);

    const after = await readSlide(registry, presentationId);
    const movedA = readTranslate(after, "el-a");
    const b = readTranslate(after, "el-b");
    // Both rects have x=0 on their own primitive, so the container's own
    // translateX IS each element's left edge.
    expect(movedA.x).toBe(b.x);

    // Guides never persist past the gesture.
    const frame = await canvasFrame(page);
    const guideCountAfter = await frame.evaluate(() => {
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement | null;
      const guides = host?.shadowRoot?.querySelectorAll(".guide") ?? [];
      return [...guides].filter((el) => (el as HTMLElement).style.display !== "none").length;
    });
    expect(guideCountAfter).toBe(0);
  } finally {
    await cleanup();
  }
});

it("按住 Alt 拖到同一位置：不會貼齊，左緣不等於候選元素的左緣", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // Deliberately short of el-b's left edge (700) — close enough that
    // without Alt this would snap (proven by the test above), but the
    // point is to land somewhere real mouse-pixel rounding could plausibly
    // never round exactly back onto 700 by coincidence, so a passing
    // `not.toBe` genuinely proves snapping was off rather than "happened
    // to land on the line anyway".
    const targetLeft = 695;
    const dx = targetLeft - 100;
    const dy = 250;

    await dragBy(page, { x: 180, y: 150 }, { x: dx, y: dy }, { alt: true });

    const after = await readSlide(registry, presentationId);
    const movedA = readTranslate(after, "el-a");
    const b = readTranslate(after, "el-b");
    expect(movedA.x).not.toBe(b.x);
    // Still moved roughly where asked (well within real mouse-pixel
    // rounding, generously bounded) — Alt disables snapping, not the drag
    // itself.
    expect(Math.abs(movedA.x - targetLeft)).toBeLessThan(15);
  } finally {
    await cleanup();
  }
});

it("Shift 點兩個元素後一起拖曳：兩個元素各自的位移量相同，且只產生一條命令", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });

    const selName = page.locator(".status .sel-name");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：2 個元素");

    // Multi-select only ever supports move — the scale/rotate/textbox-width
    // handles must be entirely absent from the rendered handle set the
    // moment a second element joins the selection, not merely hidden by a
    // click-time check.
    const frameForHandles = await canvasFrame(page);
    const visibleHandleCount = await frameForHandles.evaluate(() => {
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement | null;
      const handles = host?.shadowRoot?.querySelectorAll("[data-comot-handle]") ?? [];
      return [...handles].filter((el) => (el as HTMLElement).style.display !== "none").length;
    });
    expect(visibleHandleCount).toBe(0);

    // Drag starting inside el-a — already part of the current selection, so
    // both ids move together (§4.2's multi-select row).
    await dragBy(page, { x: 180, y: 150 }, { x: 30, y: 20 });

    const after = await readSlide(registry, presentationId);
    const a = readTranslate(after, "el-a");
    const b = readTranslate(after, "el-b");
    expect(a.x - 100).toBe(b.x - 700);
    expect(a.y - 100).toBe(b.y - 300);
    expect(a.x).not.toBe(100); // actually moved

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("從空白處拖出框選矩形：與框相交的元素全部選中，且簡報檔案位元組完全未變", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    // A rectangle covering el-a (100..260, 100..200) and el-b (700..840,
    // 300..390) but not el-c (950..1070, 500..580) or the caption.
    await dragBy(page, { x: 40, y: 40 }, { x: 850, y: 420 });

    const selName = page.locator(".status .sel-name");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：2 個元素");

    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("拖曳右下角縮放把手放手：scale 依 factor 縮放、translate 完全不變、只產生一條命令", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-a").click();
    const box = await svgBox(page);
    // el-a: translate(100 100), rect 0 0 160 100 -> bbox 100..260 / 100..200.
    // The se handle sits exactly at that bbox's bottom-right corner
    // (positionHandles' own rule), i.e. user-space (260, 200).
    const seHandle = await handleCenter(page, "se");
    const factor = 1.5;
    // Drag straight along the origin(100,100)->se(260,200) ray so the
    // projection formula's own factor comes out to exactly `factor`.
    const target = toPagePoint(box, 100 + factor * 160, 100 + factor * 100);
    await dragPageTo(page, seHandle, target);

    const after = await readSlide(registry, presentationId);
    // `element scale` (element-edit.ts's scaleOneContainer/buildPrimitiveScaleSplices)
    // never writes a `scale()` transform segment for a leaf target — it
    // scales the primitive's own native geometry (width/height/x/y here)
    // directly and leaves the container's `transform` completely
    // untouched. The live preview (canvas.ts) still renders via a
    // `scale()` transform on the container — mathematically identical for
    // any primitive whose native x/y sits at the element's own local
    // origin, per ADR-0012's normal form — but the PERSISTED file never
    // shows a `scale()` component, so this asserts the real on-disk shape
    // rather than the preview's.
    const rectMatch = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(after);
    expect(rectMatch).not.toBeNull();
    // Real mouse-pixel rounding through the handle's own 9px hit target
    // (same generous bound the existing Alt-drag test above uses) — not
    // exact-to-the-pixel, but well inside "this is factor 1.5, not 1 or 2".
    expect(Math.abs(Number(rectMatch![3]) - 160 * factor)).toBeLessThan(5);
    expect(Math.abs(Number(rectMatch![4]) - 100 * factor)).toBeLessThan(5);
    // Anchored at the element's own local origin, never the bbox center or
    // a fixed opposite corner: the container's transform (translate) is
    // untouched, byte for byte, and no scale() segment is ever added.
    expect(readTransformAttr(after, "el-a")).toBe("translate(100 100)");

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("拖曳旋轉把手放手：rotate 改變了預期的 delta、translate/scale 不變", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-a").click();
    const box = await svgBox(page);
    const origin = { x: 100, y: 100 }; // el-a's own translate.
    const rotateHandle = await handleCenter(page, "rotate");
    const downUser = toUserPointTest(box, rotateHandle.x, rotateHandle.y);
    const downVec = { x: downUser.x - origin.x, y: downUser.y - origin.y };
    const targetDeltaDeg = 90;
    const nowVec = rotateVector(downVec, targetDeltaDeg);
    const nowUser = { x: origin.x + nowVec.x, y: origin.y + nowVec.y };
    const nowPage = toPagePoint(box, nowUser.x, nowUser.y);

    await dragPageTo(page, rotateHandle, nowPage);

    const after = await readSlide(registry, presentationId);
    const transformAfter = readTransformAttr(after, "el-a");
    expect(readRotation(transformAfter)).toBeCloseTo(targetDeltaDeg, 0);
    expect(readTranslate(after, "el-a")).toEqual({ x: 100, y: 100 });
    expect(readScale(transformAfter)).toEqual({ sx: 1, sy: 1 });

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("拖曳文字框左把手放手：data-comot-text-width 變成新寬度、tspan 行數與 wrapText 算出的一致、font-size 不變", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-text").click();
    const box = await svgBox(page);
    const leftHandle = await handleCenter(page, "width-left");
    const pixelsPerUser = box.width / VIEWBOX.width;
    // Drag the left handle further LEFT (away from the box) by 60 user
    // units — per this ticket's documented deviation (`textbox width` has
    // no position input, so the container never moves), that grows the
    // width by 60 regardless of which handle is dragged.
    const nowPage = { x: leftHandle.x - 60 * pixelsPerUser, y: leftHandle.y };
    await dragPageTo(page, leftHandle, nowPage);

    const after = await readSlide(registry, presentationId);
    const widthMatch = /<g id="el-text" data-comot-text-width="([\d.]+)"/.exec(after);
    expect(widthMatch).not.toBeNull();
    const newWidth = Number(widthMatch![1]);
    expect(newWidth).toBeCloseTo(360, 0);

    // font-size is untouched — only the frame width changed.
    const fontSizeMatch = /<text font-family="Noto Sans TC" font-size="([\d.]+)"/.exec(after);
    expect(fontSizeMatch).not.toBeNull();
    expect(Number(fontSizeMatch![1])).toBe(24);

    // The tspan line count must match what `textbox width`'s own wrapText
    // call would produce for this exact width — computed here through the
    // same core function, against the actual final width the drag landed
    // on (not a hand-picked value), so nothing about the live preview vs.
    // the post-release re-render can have silently diverged.
    const sourceMatch = /<tspan[^>]*>([^<]*)<\/tspan>/.exec(before);
    expect(sourceMatch).not.toBeNull();
    const fonts = await resolvePresentationFonts(presentationId);
    const font = fonts.get("Noto Sans TC")!;
    const expectedWrap = wrapText(sourceMatch![1], { width: newWidth, font, fontSizePx: 24 });
    const actualTspanCount = (after.match(/<tspan /g) ?? []).length;
    expect(actualTspanCount).toBe(expectedWrap.lines.length);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("雙擊進入群組後拖曳群組內的單一子元素：只有子元素的 transform 改變，群組自己的 transform 不動", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-group-child").dblclick();
    const selName = page.locator(".status .sel-name");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：群組子元素");

    // el-group: translate(300 550); el-group-child: translate(0 0), rect
    // 0 0 80 60 -> absolute 300..380 / 550..610. Alt disables snapping —
    // this test is about group scoping, not the snap radius, and
    // el-group-child's dragged position otherwise lands within snapping
    // distance of el-c's own bottom edge (580), which is incidental to
    // what this test means to prove.
    await dragBy(page, { x: 330, y: 570 }, { x: 30, y: 20 }, { alt: true });

    const after = await readSlide(registry, presentationId);
    expect(readTranslate(after, "el-group-child")).toEqual({ x: 30, y: 20 });
    // The group container's own transform is untouched — this is a
    // top-level `element move` on the CHILD's own id, not the group's.
    expect(readTransformAttr(after, "el-group")).toBe("translate(300 550)");

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("按 Esc 退出群組編輯後，點同一個畫面位置：選取解析成整個群組（外層規則），不是子元素", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status .sel-name");

    await slideFrame.locator("#el-group-child").dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：群組子元素");

    await page.keyboard.press("Escape");
    // Esc while not mid-gesture only pops the group-edit scope — the
    // selection itself is untouched until the next click.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：群組子元素");

    // Clicking the exact same screen position again now resolves at the
    // top level: the OUTERMOST id-carrying ancestor is the group itself.
    await slideFrame.locator("#el-group-child").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：群組");
  } finally {
    await cleanup();
  }
});

it("POST /api/command 的白名單：黑名單命令回 403，簡報位元組不變", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const response = await fetch(`${server.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ name: "open", input: { path: "/etc/passwd" } }),
    });
    expect(response.status).toBe(403);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});
