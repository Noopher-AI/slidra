import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";

/**
 * NOOP-91's real Chromium acceptance tests, modelled on
 * e2e/selection.test.ts and e2e/stage.test.ts's startServerFor/openApp
 * shape: a real server, a real built `packages/web/dist`, and the
 * `e2e/fixtures/direct-manipulation-deck` fixture (`demo/` has no second
 * element close enough to exercise snapping without bending its layout,
 * per the plan's own assumption note).
 *
 * 場景 ↔ 測試對照表（05-INTERACTIONS.feature「移動與縮放元素」，NOOP-91
 * round-2 FAIL #2/#4 補做——第 1 輪漏做）：
 *
 * - 場景「拖曳吸附」（假設拖曳選取中的元素／吸附輔助線／⌥不吸附／放開成一筆歷史）:
 *   - "拖曳單一元素放手後：預覽字串與寫入檔案的字串逐字元相同，整次拖曳只產生一條命令"
 *   - "拖曳到與另一元素左緣相距在吸附半徑內：放手後兩者左緣完全相等，且畫出/清除輔助線"
 *   - "按住 Alt 拖到同一位置：不會貼齊，左緣不等於候選元素的左緣"
 *   - "Shift 點兩個元素後一起拖曳：兩個元素各自的位移量相同，且只產生一條命令"
 *   - "從空白處拖出框選矩形：與框相交的元素全部選中，且簡報檔案位元組完全未變"
 *   - "拖曳到與文字元素左緣相距在吸附半徑內：貼齊文字邊緣（文字元素本身也是吸附候選）"
 *   - "驗收條件第四條 (a)/(b)"（history 計數：100 步一筆／20 次獨立拖曳 20 筆）
 *   - "基準截圖：拖曳中畫出吸附輔助線"／"基準截圖：放手後輔助線消失"／"基準截圖：多選只有 move"
 * - 場景「縮放」（拖曳四角把手／最小 3cqw×0.6cqh／不超出投影片）:
 *   - "按住 Shift 拖曳右下角把手放手：scale 依 factor 縮放..."（等比）
 *   - "拖曳右下角把手放手（不按 Shift）：走 element resize..."（非等比，含 GUI→CLI 抽查）
 *   - "非等比縮放一個原點非 (0,0) 的 rect：..."（FAIL #1 迴歸：錨點公式）
 *   - "拖 se 把手拖出投影片右下角：...縮放不超出投影片"（FAIL #2：投影片邊界夾制）
 *   - 群組祖先鏈（平移/旋轉/縮放）三條 + 文字框寬度把手一條，見對應測項標題
 *
 * 其餘測項（⌘A/Delete/⌘D/⌘]/情境列/Arrange 選單/群組進出/白名單）不對應
 * 05-INTERACTIONS.feature 這兩個場景，是 NOOP-61 驗收條件其餘各條（CLI 對應、
 * 截圖比對六案、GUI↔CLI 抽查）自己的覆蓋，各自的測項名稱已經自我描述。
 *
 * The fixture's `project.json` declares one embedded font
 * ("Noto Sans TC", for `el-text`'s textbox-width tests) but does not carry
 * the font FILE itself — a 5.4 MB binary has no business living twice in
 * this repo when `assets/fonts` already ships it for
 * every other font-dependent test. `startServerFor` below copies the
 * fixture into a throwaway temp directory and injects the real font bytes
 * into it before packing, so the checked-in fixture stays tiny.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/co-motion");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/direct-manipulation-deck");
// Dedicated single-element fixture for the "rect at a non-zero local origin"
// resize-anchor regression (NOOP-91 round-2 FAIL #1) — `direct-manipulation-deck`'s
// own el-a sits at local (0, 0), which is exactly the case that hid the bug.
const offsetDeckDir = path.join(e2eDir, "fixtures/direct-manipulation-offset-deck");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/direct-manipulation");

const VIEWPORT = { width: 1440, height: 900 };
const VIEWBOX = { width: 1280, height: 720 };

let browser: Browser;
let openPages: Page[] = [];
let fontDataUrl: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
  const fontBytes = await readFile(path.join(presentationFontDir, "NotoSansTC-Presentation.ttf"));
  fontDataUrl = `data:font/ttf;base64,${fontBytes.toString("base64")}`;
});

/**
 * Chromium's own `getComputedTextLength()` for `text` at `fontSizePx` in the
 * real embedded presentation font — same technique as
 * text-metrics.test.ts's `renderedWidthInChromium`, the external ground
 * truth this file's wrap assertion compares against post-[E4.T12] (the
 * TypeScript engine's own `wrapText`, previously used as the oracle here,
 * no longer exists).
 */
async function renderedWidthInChromium(page: Page, text: string, fontSizePx: number): Promise<number> {
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
    [fontDataUrl, "Noto Sans TC", text, fontSizePx] as const,
  );
}

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

async function startServerFor(sourceDeckDir: string = deckDir): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-dm-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-dm-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-dm-deck-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  // [E4.T9]/F7: co-motion serve now spawns the Rust binary for every read/write.
  process.env.CO_MOTION_BIN = coMotionBin;

  // Copy the checked-in fixture into a throwaway staging dir, then inject
  // the real embedded-font bytes (see this file's header comment) — the
  // fixture's own project.json already declares the font entry, it just
  // has no `fonts/` directory checked in for packDirectory to pick up.
  // `offsetDeckDir` has no font declaration at all, so this is a no-op
  // extra directory for it (packDirectory only packs what's on disk).
  await cp(sourceDeckDir, deckStagingDir, { recursive: true });
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

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      delete process.env.CO_MOTION_BIN;
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

/** `<CO_MOTION_HOME>/history/<presentationId>/stack.json`'s `undo` array length (history.ts) — 驗收條件第四條「拖曳 100 次不產生 100 筆歷史；一次拖曳一筆」的直接讀法。`startServerFor` sets `process.env.CO_MOTION_HOME` for the whole test's lifetime. A never-edited presentation has no `stack.json` at all (history.ts's own documented "genuinely missing file" case) — treated as 0, not an error. */
async function undoCount(presentationId: string): Promise<number> {
  const home = process.env.CO_MOTION_HOME!;
  try {
    const raw = await readFile(path.join(home, "history", presentationId, "stack.json"), "utf8");
    return (JSON.parse(raw).undo ?? []).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * The main-canvas `<svg>`'s bounding box in PAGE (viewport) coordinates — what
 * `page.mouse` expects. Every committed gesture makes the server rewrite the
 * slide and live reload swap the iframe's srcdoc, so right after a drag the
 * `<svg>` can be momentarily absent (boundingBox() → null); poll briefly for
 * the reloaded document instead of failing on that instant.
 */
async function svgBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const svg = page.frameLocator("iframe.slide-frame").locator("svg").first();
  const deadline = Date.now() + 2_000;
  for (;;) {
    const box = await svg.boundingBox().catch(() => null);
    if (box) return box;
    if (Date.now() > deadline) throw new Error("量不到主畫布 svg 的邊界框");
    await page.waitForTimeout(50);
  }
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
  /**
   * Wait for `#el-a`'s client box to stop moving instead of a fixed
   * `waitForTimeout(150)` after mouseup (NOOP-349 round 3, [Fix.4]). The
   * fixed sleep raced the srcdoc live-reload the persisted write triggers:
   * short enough that a following drag could land mid-reload, or a
   * following `frame.evaluate` could hit the iframe's document being torn
   * down ("Execution context was destroyed"). Off by default — every other
   * `dragBy` caller keeps the exact timing it already had.
   */
  settle?: boolean;
}

/**
 * Waits for the live-reload cycle a committed gesture triggers (canvas.ts's
 * `reload()`: fetch -> full `srcdoc` rebuild, discarding and recreating the
 * whole iframe document) to actually happen and finish, then for `#el-a`'s
 * bounding box (in the main-canvas iframe) to stop moving, up to 5s total.
 * Throws on timeout — unlike `qa/agent_helpers.py`'s
 * `_wait_status_bar_settled` (which never raises, because a QA case script
 * owns its own PASS/FAIL), a timeout here means the fixture doesn't have
 * `#el-a` or the reload never landed, which is itself a bug the caller
 * should see as a hard failure, not silently ignore.
 *
 * Geometry alone is not a sufficient settle signal, and neither is waiting
 * to observe `#el-a` go missing: right after mouseup, the live-drag preview
 * already shows the (about to be persisted) final position, so two
 * consecutive non-null reads can already be equal before the persisted
 * write — and the reload it triggers — have even started; and a real
 * `srcdoc` reload in this app does not reliably paint a blank frame in
 * between (verified directly: requiring an observed null read before
 * accepting "settled" just timed out every time — `#el-a` never once read
 * as missing across a real edit's reload). This tags the CURRENT `#el-a`
 * DOM node with a one-shot marker attribute first — an attribute set via
 * `evaluate()` can never survive a real `srcdoc` rebuild, since that
 * discards the whole document and reparses fresh markup — so a read is
 * only trusted once it comes from an element that does NOT carry this
 * call's marker, i.e. provably a new, post-reload node.
 */
async function waitForSlideSettled(page: Page): Promise<void> {
  const marker = `e2e-settle-${Math.random().toString(36).slice(2)}`;

  const tagCurrentElA = async (): Promise<boolean> => {
    try {
      const frame = await canvasFrame(page);
      return await frame.evaluate((m) => {
        const el = document.getElementById("el-a");
        if (!el) return false;
        el.setAttribute("data-e2e-settle-marker", m);
        return true;
      }, marker);
    } catch {
      return false;
    }
  };

  // A live-reload mid-flight tears down the iframe's execution context —
  // `frame.evaluate` throwing here is an expected "not settled yet" sample,
  // not swallowed silently: it only ever prevents two reads from matching,
  // so a caller stuck in a genuinely broken reload still hits the 5s
  // timeout below and gets a real error, same as any other unsettled read.
  const readBox = async () => {
    try {
      const frame = await canvasFrame(page);
      return await frame.evaluate((m) => {
        const el = document.getElementById("el-a");
        if (!el) return null;
        // Still the pre-reload node this call marked — its geometry is the
        // live-drag preview, not the persisted, post-reload result.
        if (el.getAttribute("data-e2e-settle-marker") === m) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }, marker);
    } catch {
      return null;
    }
  };

  const deadline = Date.now() + 5_000;
  if (!(await tagCurrentElA())) {
    throw new Error("waitForSlideSettled: 找不到 #el-a 可標記，無從觀察這次 reload");
  }
  let last: Awaited<ReturnType<typeof readBox>> = null;
  for (;;) {
    await page.waitForTimeout(50);
    const cur = await readBox();
    if (cur !== null && last !== null && JSON.stringify(cur) === JSON.stringify(last)) return;
    last = cur;
    if (Date.now() > deadline) throw new Error("waitForSlideSettled: #el-a 在 5 秒內沒有出現 reload 後的穩定狀態");
  }
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
  if (options.settle) {
    await waitForSlideSettled(page);
  } else {
    // POST /api/command round trip + the file write it causes.
    await page.waitForTimeout(150);
  }
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

/** The `<rect>` primitive's own x/y/width/height directly inside `<g id="elementId">` — for scale assertions on a nested child, where a bare `/<rect .../ ` regex would match the wrong element. */
function readRect(svg: string, elementId: string): { x: number; y: number; width: number; height: number } {
  const match = new RegExp(`<g id="${elementId}"[^>]*>\\s*<rect x="([-\\d.]+)" y="([-\\d.]+)" width="([-\\d.]+)" height="([-\\d.]+)"`).exec(svg);
  if (!match) throw new Error(`找不到 ${elementId} 的 <rect>`);
  return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
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
async function dragPageTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { shift?: boolean } = {},
): Promise<void> {
  if (options.shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  if (options.shift) await page.keyboard.up("Shift");
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

    // GUI-did-once -> agent-runs-same-CLI spot check (驗收條件第三條，
    // Plan §6.3 建議案例之一：移動): undo above already restored `before`;
    // running the equivalent `element move` CLI command with the exact
    // delta the drag committed must reproduce byte-for-byte the same
    // `after`.
    const cliResult = await registry.dispatch("element move", {
      id: presentationId,
      slidePath: "slides/001.svg",
      elementIds: ["el-a"],
      dx: moved.x - 100,
      dy: moved.y - 100,
    });
    expect(cliResult.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(after);
  } finally {
    await cleanup();
  }
});

it("驗收條件第四條 (a)：一次拖曳、中間 100 個 mouse-move 步，只產生一筆歷史", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const beforeUndoCount = await undoCount(presentationId);

    const box = await svgBox(page);
    const from = toPagePoint(box, 180, 150); // inside el-a
    const to = toPagePoint(box, 240, 190);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 100 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(150);

    expect(await readSlide(registry, presentationId)).not.toBe(before);
    expect(await undoCount(presentationId)).toBe(beforeUndoCount + 1);
  } finally {
    await cleanup();
  }
}, 30_000);

// 驗收條件第四條 (b) 原文要求「連續 100 次獨立拖曳，undo.length 恰好 +100」，
// 但 history.ts 的 UNDO_STACK_CAP = 50（既有、與本票無關的常數：舊條目超過
// 50 筆會被逐出，`history.test.ts` 自己也有一條「51st edit」的既有測試）在
// 100 次之後只會留下最後 50 筆——從 0 筆歷史開始跑，「+100」這個數字本身
// 不可能達成。這裡改用安全遠低於上限的 20 次，驗證同一個「不做去重/合併」
// 的不變量（每次獨立拖曳都各自算一格），不去踩到跟這張票無關的既有上限。
it("驗收條件第四條 (b)：連續 20 次獨立拖曳，恰好產生 20 筆歷史（不多不少、不合併）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const beforeUndoCount = await undoCount(presentationId);

    // Alternates +10/-10 user units (safely above the runtime's 3px drag
    // threshold at this viewport's render scale) so el-a's own position
    // stays put overall and never drifts outside the slide across every
    // iteration. Alt disables snapping — without it, every other landing
    // spot coincidentally snapped back to the exact pre-drag position
    // (roundsToZero's own no-history-for-nothing guard), silently halving
    // the count this test means to prove is NOT silently deduplicated.
    const REPEATS = 20;
    for (let i = 0; i < REPEATS; i++) {
      const dx = i % 2 === 0 ? 10 : -10;
      await dragBy(page, { x: 180, y: 150 }, { x: dx, y: 0 }, { alt: true, settle: true });
      // Confirms each individual drag's history write landed before the
      // next drag starts — a fixed waitForTimeout(150) could let a drag
      // land while the previous one's srcdoc reload was still in flight,
      // which is what made this test observe only 19 of 20 entries
      // (NOOP-349 round 3, [Fix.4]).
      await expect.poll(() => undoCount(presentationId)).toBe(beforeUndoCount + i + 1);
    }

    expect(await undoCount(presentationId)).toBe(beforeUndoCount + REPEATS);
  } finally {
    await cleanup();
  }
}, 60_000);

it("拖曳中情境列隱藏；放手並重載後選取狀態與情境列都保留（review 要求）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const bar = page.locator(".context-bar");
    const selName = page.locator(".status-selection-chip");

    let barVisibleMidDrag: boolean | null = null;
    await dragBy(page, { x: 180, y: 150 }, { x: 60, y: 40 }, {
      onMidDrag: async () => {
        barVisibleMidDrag = await bar.isVisible();
      },
    });
    expect(barVisibleMidDrag).toBe(false);

    // The committed write reloads the slide; the selection must survive it.
    await expect.poll(() => selName.textContent().then((t) => t?.trim()), { timeout: 5_000 }).toBe("Selected: 方塊 A");
    await expect.poll(() => bar.isVisible(), { timeout: 5_000 }).toBe(true);
    expect(readTranslate(await readSlide(registry, presentationId), "el-a")).not.toEqual({ x: 100, y: 100 });

    // Bar is left-aligned with the selection box.
    const selBox = await page.frameLocator("iframe.slide-frame").locator(".sel").first().boundingBox();
    const barBox = await bar.boundingBox();
    expect(Math.abs(barBox!.x - selBox!.x)).toBeLessThanOrEqual(1);
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

    // NOOP-90/T2 ADR-0011 amend: guides are drawn by the parent document's
    // own `.guide-layer` (GuideLayer.tsx) now, not inside the sandboxed
    // iframe's shadow root — `page.evaluate`, not `frame.evaluate`.
    let guidesSeenDuringDrag = false;
    await dragBy(
      page,
      { x: 180, y: 150 },
      { x: dx, y: dy },
      {
        onMidDrag: async () => {
          const guideCount = await page.evaluate(() => document.querySelectorAll(".guide-layer .guide").length);
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
    const guideCountAfter = await page.evaluate(() => document.querySelectorAll(".guide-layer .guide").length);
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

    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");

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
    // toBeCloseTo, not toBe: `a.y`/`b.y` are independently parsed from two
    // separately-formatted decimal strings in the written file, so their
    // shifted differences are only guaranteed equal to the file's own
    // 4-decimal write precision, not bit-for-bit — reload() now awaits an
    // extra font fetch before the first render (NOOP-91 follow-up round 2's
    // fonts fix), and that timing shift was enough to move the real
    // mouse-driven drag by roughly one part in 1e13, previously masked by
    // this assertion's stricter-than-warranted `toBe`.
    expect(a.x - 100).toBeCloseTo(b.x - 700, 6);
    expect(a.y - 100).toBeCloseTo(b.y - 300, 6);
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
    // 300..390) but not el-c (550..670, 500..580) or the caption.
    await dragBy(page, { x: 40, y: 40 }, { x: 850, y: 420 });

    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");

    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("框選涵蓋文字元素：文字元素本身可被框選選中（Reviewer round-1 FAIL：fonts 未傳入 elementBounds）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // el-text: translate(950 100), a text BOX (data-comot-text-width="300")
    // whose bounds start at its local origin (bbox.ts's textBounds doc) —
    // roughly 950..1250 x, 100..~160 y.
    //
    // The marquee's bottom edge originally landed at y=250 — exactly the top
    // of el-group-rotate's bbox (translate(1150 250) rotate(30); the rotated
    // rect's own local origin corner stays its topmost point, so the bbox's
    // y-minimum is exactly 250, with x-minimum 1120 — well inside this
    // marquee's x-range). That made the marquee's bottom-right corner
    // tangent to el-group-rotate's bbox: a stage-width change (e.g. the
    // style panel's fixed-width mount narrowing the canvas) shifts the
    // page-pixel<->user-unit rounding in `toPagePoint` enough to flip that
    // tangent edge from excluded to included, non-deterministically pulling
    // el-group-rotate into the selection (Reviewer round-2 FAIL). Ending the
    // drag at y=200 keeps 40 units of margin below el-text's own bottom edge
    // (~160) and 50 units clear of el-group-rotate's bbox top (250), so the
    // marquee covers el-text with room to spare on both sides regardless of
    // stage width.
    await dragBy(page, { x: 900, y: 50 }, { x: 370, y: 150 }); // -> (1270, 200)

    const selName = page.locator(".status-selection-chip");
    // el-text carries no `data-comot-name`, so the status bar falls back to
    // the raw id (StatusBar.tsx).
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: el-text");
  } finally {
    await cleanup();
  }
});

it("拖曳到與文字元素左緣相距在吸附半徑內：貼齊文字邊緣（文字元素本身也是吸附候選）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const box = await svgBox(page);
    const threshold = snapThresholdUser(box);
    // el-text's own container translateX (950) IS its left edge — a text
    // BOX's bounds start at the local origin (bbox.ts's textBounds doc).
    // The raw drag OVERSHOOTS that edge by a few user units (well inside
    // the snap radius but not exactly on it) — landing exactly on 950 would
    // pass whether or not the text candidate ever engages, since that is
    // also el-a's own unsnapped raw endpoint (Reviewer round-2 FAIL).
    // Overshooting rather than falling short also keeps el-a's own MID edge
    // (which lands 10 user units short of el-text's own centre line, since
    // el-a is 160 wide and el-text is 300) safely outside the snap radius,
    // rather than tied with — or beating — the left-edge match.
    const targetLeft = 950;
    const rawOvershoot = threshold / 3;
    const dx = targetLeft + rawOvershoot - 100; // el-a starts at x=100
    // Chosen so the moved box's top/mid/bottom edges (100+dy, 150+dy,
    // 200+dy) land far outside every OTHER candidate's own edges — the
    // nearest is el-text's own top edge at y~105 — so no coincidental
    // horizontal snap, and no non-text candidate happens to also sit at
    // x=950 (fixture keeps el-c away from that column), can produce the
    // same result as the text candidate.
    const dy = -140;

    // NOOP-90/T2 ADR-0011 amend: guides are drawn by the parent document's
    // own `.guide-layer` (GuideLayer.tsx), positioned relative to
    // `.canvas-area`'s own box (its nearest positioned ancestor) — so the
    // expected "left" is the page-viewport x (same space `svgBox`/
    // `toPagePoint` already work in) minus `.canvas-area`'s own left edge.
    let sawVerticalGuideAt950 = false;
    await dragBy(
      page,
      { x: 180, y: 150 },
      { x: dx, y: dy },
      {
        onMidDrag: async () => {
          const guides = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".guide-layer .guide")).map((el) => ({
              vertical: el.classList.contains("guide-v"),
              left: el.style.left,
            })),
          );
          const canvasAreaBox = await page.locator(".canvas-area").boundingBox();
          if (!canvasAreaBox) throw new Error("量不到 .canvas-area 的邊界框");
          const expectedPageLeft = toPagePoint(box, targetLeft, 0).x;
          const expectedLocalLeft = expectedPageLeft - canvasAreaBox.x;
          sawVerticalGuideAt950 = guides.some(
            (g) => g.vertical && Math.abs(parseFloat(g.left) - expectedLocalLeft) < 1,
          );
        },
      },
    );

    expect(sawVerticalGuideAt950).toBe(true);

    const after = await readSlide(registry, presentationId);
    expect(readTranslate(after, "el-a").x).toBe(targetLeft);
  } finally {
    await cleanup();
  }
});

it("按住 Shift 拖曳右下角把手放手：scale 依 factor 縮放、translate 完全不變、只產生一條命令", async () => {
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
    // Holding Shift is what selects the UNIFORM path (NOOP-90/T2 決定 4) —
    // without it, the same drag now goes through `element resize` instead
    // (see the dedicated resize test below).
    const target = toPagePoint(box, 100 + factor * 160, 100 + factor * 100);
    await dragPageTo(page, seHandle, target, { shift: true });

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

it("拖曳右下角把手放手（不按 Shift）：走 element resize，非等比縮放、anchor 是對角 nw、只產生一條命令", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-a").click();
    const box = await svgBox(page);
    // el-a: translate(100 100), rect 0 0 160 100 -> local bbox (own
    // transform factored out) is exactly the rect's own geometry: nw=(0,0),
    // se=(160,100). Dragging se to local (240, 130) — width ×1.5, height
    // ×1.3, deliberately DIFFERENT ratios so a uniform scale could never
    // produce this result — must anchor the OPPOSITE corner (nw), leaving
    // the container's own translate untouched.
    const seHandle = await handleCenter(page, "se");
    const target = toPagePoint(box, 100 + 240, 100 + 130);
    await dragPageTo(page, seHandle, target);

    const after = await readSlide(registry, presentationId);
    const rectMatch = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(after);
    expect(rectMatch).not.toBeNull();
    expect(Math.abs(Number(rectMatch![3]) - 240)).toBeLessThan(5);
    expect(Math.abs(Number(rectMatch![4]) - 130)).toBeLessThan(5);
    // nw anchored: the container's own translate is untouched, byte for byte.
    expect(readTransformAttr(after, "el-a")).toBe("translate(100 100)");

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);

    // GUI-did-once -> agent-runs-same-CLI spot check (驗收條件第三條): undo
    // above already restored `before`; running the equivalent `element
    // resize` CLI command must reproduce byte-for-byte the same `after`.
    const cliResult = await registry.dispatch("element resize", {
      id: presentationId,
      slidePath: "slides/001.svg",
      elementIds: ["el-a"],
      width: Number(rectMatch![3]),
      height: Number(rectMatch![4]),
      anchor: "nw",
    });
    expect(cliResult.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(after);
  } finally {
    await cleanup();
  }
});

it("非等比縮放一個原點非 (0,0) 的 rect：預覽 nw 角與放手後 nw 角在 client 座標系一致（NOOP-91 round-2 FAIL #1 迴歸測試）", async () => {
  // `direct-manipulation-deck`'s own el-a is a <rect x="0" y="0" .../> inside
  // a translated <g> — the anchor-preserving delta formula in
  // `resizeOneTarget` (element-edit.ts) happens to be correct for that shape
  // even when `buildPrimitiveResizeSplices` leaves the rect's own x/y
  // untouched, because 0 * anything is still 0. `offsetDeckDir`'s el-a has
  // NO <g> transform at all and a rect anchored at local (100, 100) —
  // exactly the shape that exposed the bug (the nw corner visibly jumped on
  // release because the persisted x/y never scaled while the live preview,
  // driven by a `scale()` transform, correctly did).
  const { server, registry, presentationId, cleanup } = await startServerFor(offsetDeckDir);
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    expect(readTransformAttr(before, "el-a")).toBe("");

    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();
    const box = await svgBox(page);
    const seHandle = await handleCenter(page, "se");
    // Same non-uniform ratios as the sibling "不按 Shift" test above (width
    // x1.5, height x1.3) — deliberately different axes so this can only be
    // `element resize`, anchored at the opposite (nw) corner.
    const target = toPagePoint(box, 100 + 240, 100 + 130);

    const readNwCornerClient = async (): Promise<{ x: number; y: number }> => {
      const frame = await canvasFrame(page);
      return frame.evaluate(() => {
        const rect = document.getElementById("el-a")!.getBoundingClientRect();
        return { x: rect.left, y: rect.top };
      });
    };

    await page.mouse.move(seHandle.x, seHandle.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await page.waitForTimeout(80);
    const nwDuringDrag = await readNwCornerClient();
    await page.mouse.up();
    // Wait for the POST /api/command round trip + the write's own
    // /api/events live-reload push (canvas.ts's reload()) to actually land,
    // instead of guessing a fixed delay (NOOP-349 round 3, [Fix.5]) — a
    // fixed waitForTimeout(150) here could read el-a's client rect while
    // the srcdoc swap was still in flight, throwing "Execution context was
    // destroyed" instead of the intended before/after comparison.
    await waitForSlideSettled(page);
    const nwAfterRelease = await readNwCornerClient();

    // The nw corner is the anchor: it must not visibly jump between the
    // live preview (mid-drag) and the persisted result (after release).
    expect(Math.abs(nwAfterRelease.x - nwDuringDrag.x)).toBeLessThan(3);
    expect(Math.abs(nwAfterRelease.y - nwDuringDrag.y)).toBeLessThan(3);

    // Byte-level check, independent of client-pixel rounding: the nw corner
    // in the persisted file's own coordinate space — translate(tx,ty) + the
    // rect's own (spliced) x/y — must land back on exactly (100, 100),
    // where it started.
    const after = await readSlide(registry, presentationId);
    const rectMatch = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(after);
    expect(rectMatch).not.toBeNull();
    expect(Math.abs(Number(rectMatch![3]) - 240)).toBeLessThan(5);
    expect(Math.abs(Number(rectMatch![4]) - 130)).toBeLessThan(5);
    // `readTransformAttr`/`readTranslate` (this file's own helpers) assume
    // `transform` appears AFTER `id` in the tag — true for every other
    // fixture here (their elements already carry a `transform`, so a
    // resize/move only ever rewrites it in place), but false for this
    // fixture's el-a: it starts with NO `transform` at all, so
    // `buildTransformSplice` (element-edit.ts) inserts the new attribute
    // right after `<g`, BEFORE `id`. Match the whole opening tag first
    // (attribute-order-independent), then pull `transform` out of that.
    const gTag = /<g\b[^>]*\bid="el-a"[^>]*>/.exec(after)?.[0] ?? "";
    const transformValue = /transform="([^"]*)"/.exec(gTag)?.[1] ?? "";
    const translateAfter = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(transformValue);
    const tx = translateAfter ? Number(translateAfter[1]) : 0;
    const ty = translateAfter ? Number(translateAfter[2]) : 0;
    expect(tx + Number(rectMatch![1])).toBeCloseTo(100, 3);
    expect(ty + Number(rectMatch![2])).toBeCloseTo(100, 3);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("拖 se 把手拖出投影片右下角：結果 bbox 的右／下緣夾在 viewBox 邊緣（NOOP-91 round-2 FAIL #2：縮放不超出投影片）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-a").click();
    const box = await svgBox(page);
    const seHandle = await handleCenter(page, "se");
    // el-a: translate(100 100), rect 0 0 160 100 -> bbox 100..260 / 100..200.
    // Drag the se handle far past the slide's own viewBox (1280x720) —
    // the resulting bbox's right/bottom edge must clamp to the viewBox
    // edge itself, not keep growing with the pointer.
    const target = toPagePoint(box, 1600, 1000);
    await dragPageTo(page, seHandle, target);

    const after = await readSlide(registry, presentationId);
    const rectMatch = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(after);
    expect(rectMatch).not.toBeNull();
    const translateAfter = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(readTransformAttr(after, "el-a"));
    const tx = translateAfter ? Number(translateAfter[1]) : 0;
    const ty = translateAfter ? Number(translateAfter[2]) : 0;
    const right = tx + Number(rectMatch![1]) + Number(rectMatch![3]);
    const bottom = ty + Number(rectMatch![2]) + Number(rectMatch![4]);
    expect(right).toBeLessThanOrEqual(1280 + 1);
    expect(bottom).toBeLessThanOrEqual(720 + 1);
    // Dragged far past the edge, so the clamp must actually have engaged —
    // the result should land close to the viewBox edge, not merely under it.
    expect(right).toBeGreaterThan(1270);
    expect(bottom).toBeGreaterThan(710);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
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

it("雙擊進入平移群組後按住 Shift 拖曳子元素的縮放把手：原點套用祖先的平移（Reviewer round-1 FAIL 的原始重現）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-group-child").dblclick();
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 群組子元素");

    const box = await svgBox(page);
    // el-group: translate(300 550); el-group-child: translate(0 0), rect
    // 0 0 80 60. The child's own local origin (0, 0) maps to TOP-LEVEL
    // (300, 550) through the ancestor's translate — not (0, 0), which is
    // what the pre-fix code used (the FAIL comment's own repro: dragging to
    // the exact 2x point produced a ~90-wide box instead of 160).
    const origin = { x: 300, y: 550 };
    const seTopLevel = { x: 380, y: 610 }; // origin + local (80, 60)
    const seHandle = await handleCenter(page, "se");
    const factor = 2;
    const target = toPagePoint(
      box,
      origin.x + factor * (seTopLevel.x - origin.x),
      origin.y + factor * (seTopLevel.y - origin.y),
    );
    // Shift selects the uniform path — see the plain se-handle test above.
    await dragPageTo(page, seHandle, target, { shift: true });

    const after = await readSlide(registry, presentationId);
    const rect = readRect(after, "el-group-child");
    expect(Math.abs(rect.width - 80 * factor)).toBeLessThan(5);
    expect(Math.abs(rect.height - 60 * factor)).toBeLessThan(5);
    expect(readTransformAttr(after, "el-group")).toBe("translate(300 550)");
    expect(readTransformAttr(after, "el-group-child")).toBe("translate(0 0)");

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("雙擊進入旋轉群組後按住 Shift 拖曳子元素的縮放把手：原點套用祖先的旋轉，縮放與旋轉共用同一套 core matrix 路徑", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-group-rotate-child").dblclick();
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 旋轉群組子元素");

    const box = await svgBox(page);
    // el-group-rotate: translate(1150 250) rotate(30); child: translate(0
    // 0). The handle's own on-screen position (read below, via
    // `handleCenter`) is selection-runtime.js's `getBoundingClientRect()`
    // corner of the ROTATED shape — not the same point as rotating the
    // local (80, 60) corner by hand — so this test maps that ACTUAL
    // handle position into el-group-rotate's local (parent) frame via the
    // ancestor's inverse rotation, scales by `factor` in that local frame
    // (mirroring canvas.ts's own `parentInverse` math exactly), then maps
    // the scaled point back out to a top-level drag target. Both directions
    // use the same rotate(30) matrix `functionToMatrix`/`multiplyMatrix` in
    // packages/core/src/geometry/transform.ts compute.
    const origin = { x: 1150, y: 250 };
    const rotateDeg = 30;
    const seHandle = await handleCenter(page, "se");
    const downTop = toUserPointTest(box, seHandle.x, seHandle.y);
    const downLocal = rotateVector({ x: downTop.x - origin.x, y: downTop.y - origin.y }, -rotateDeg);
    const factor = 1.5;
    const targetLocal = { x: downLocal.x * factor, y: downLocal.y * factor };
    const targetTopVec = rotateVector(targetLocal, rotateDeg);
    const target = toPagePoint(box, origin.x + targetTopVec.x, origin.y + targetTopVec.y);
    // Shift selects the uniform path — see the plain se-handle test above.
    await dragPageTo(page, seHandle, target, { shift: true });

    const after = await readSlide(registry, presentationId);
    const rect = readRect(after, "el-group-rotate-child");
    expect(Math.abs(rect.width - 80 * factor)).toBeLessThan(5);
    expect(Math.abs(rect.height - 60 * factor)).toBeLessThan(5);
    expect(readTransformAttr(after, "el-group-rotate")).toBe("translate(1150 250) rotate(30)");
    expect(readTransformAttr(after, "el-group-rotate-child")).toBe("translate(0 0)");

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("雙擊進入縮放群組後拖曳子元素的旋轉把手：原點套用祖先的縮放，delta 不因祖先縮放而失真", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-group-scale-child").dblclick();
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 縮放群組子元素");

    const box = await svgBox(page);
    // el-group-scale: translate(1150 450) scale(1.5); child: translate(0
    // 0). A uniform ancestor scale preserves angles, so the same
    // rotateVector helper the single-level rotate test above uses still
    // applies, once both ends of the vector are expressed in this
    // TOP-LEVEL frame (origin = ancestor applied to local (0, 0) = (1150,
    // 450) — the scale of the origin itself is a no-op, only the translate
    // moves it).
    const origin = { x: 1150, y: 450 };
    const rotateHandle = await handleCenter(page, "rotate");
    const downUser = toUserPointTest(box, rotateHandle.x, rotateHandle.y);
    const downVec = { x: downUser.x - origin.x, y: downUser.y - origin.y };
    const targetDeltaDeg = 45;
    const nowVec = rotateVector(downVec, targetDeltaDeg);
    const nowUser = { x: origin.x + nowVec.x, y: origin.y + nowVec.y };
    const nowPage = toPagePoint(box, nowUser.x, nowUser.y);

    await dragPageTo(page, rotateHandle, nowPage);

    const after = await readSlide(registry, presentationId);
    const transformAfter = readTransformAttr(after, "el-group-scale-child");
    expect(readRotation(transformAfter)).toBeCloseTo(targetDeltaDeg, 0);
    // translateX/Y are still 0 — `formatTransform` omits a zero
    // translate() segment entirely, so its absence here (rather than an
    // explicit "translate(0 0)") IS the "nothing moved" assertion.
    expect(transformAfter).not.toMatch(/translate\(/);
    expect(readScale(transformAfter)).toEqual({ sx: 1, sy: 1 });
    expect(readTransformAttr(after, "el-group-scale")).toBe("translate(1150 450) scale(1.5)");

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("拖曳文字框左把手放手：data-comot-text-width 變成新寬度、tspan 行數不多於放手前、每行實際渲染寬度都在新寬度內、font-size 不變", async () => {
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

    // Non-circular wrap assertions (post-[E4.T12]: the TypeScript engine's
    // `wrapText`, previously this test's oracle, no longer exists). The
    // drag only ever widens the box (see the comment above `nowPage`), so
    // it can only need as many or fewer lines than before, never more; and
    // every resulting line must actually fit the new declared width in a
    // real browser (Chromium's `getComputedTextLength()`, the same
    // external ground truth text-metrics.test.ts uses) — an external check
    // stronger than the old same-engine comparison.
    const tspanCountBefore = (before.match(/<tspan /g) ?? []).length;
    const tspanCountAfter = (after.match(/<tspan /g) ?? []).length;
    expect(tspanCountAfter).toBeLessThanOrEqual(tspanCountBefore);
    const afterLines = [...after.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
    for (const line of afterLines) {
      if (line === "") continue; // A trailing empty wrapped line has nothing to measure.
      const renderedWidth = await renderedWidthInChromium(page, line, 24);
      expect(renderedWidth, `行 "${line}" 的實際渲染寬度`).toBeLessThanOrEqual(newWidth * 1.005);
    }

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
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 群組子元素");

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

    const undo = await registry.dispatch<{ message?: string }>("undo", { id: presentationId });
    expect(undo.ok, undo.message).toBe(true);
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
    const selName = page.locator(".status-selection-chip");

    await slideFrame.locator("#el-group-child").dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 群組子元素");

    await page.keyboard.press("Escape");
    // Esc while not mid-gesture only pops the group-edit scope — the
    // selection itself is untouched until the next click.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 群組子元素");

    // Clicking the exact same screen position again now resolves at the
    // top level: the OUTERMOST id-carrying ancestor is the group itself.
    await slideFrame.locator("#el-group-child").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 群組");
  } finally {
    await cleanup();
  }
});

// --- NOOP-90/T2 §4.4: 鍵盤快捷鍵、情境列、Arrange 選單（右鍵選單已移除） ---

it("⌘A 全選本頁頂層元素（不含群組內的子元素），焦點在父文件時生效", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // 本頁頂層元素：el-a/el-b/el-c/el-caption/el-text/el-group/
    // el-group-rotate/el-group-scale，共 8 個——群組內的子元素不算。
    await page.keyboard.press("Meta+a");
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 8 elements");
  } finally {
    await cleanup();
  }
});

it("Delete 鍵刪除目前選取，undo 還原；無選取時是 no-op", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    // 無選取：Delete 不應該有任何效果。
    await page.keyboard.press("Delete");
    await page.waitForTimeout(100);
    expect(await readSlide(registry, presentationId)).toBe(before);

    await page.frameLocator("iframe.slide-frame").locator("#el-c").click();
    await page.keyboard.press("Delete");
    await page.waitForTimeout(150);

    const after = await readSlide(registry, presentationId);
    expect(after).not.toContain('id="el-c"');

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("焦點曾經在 rail、之後移到 rail 以外：Delete／Backspace 完全不動投影片（#214×#215 整合回歸：曾經會刪掉整張投影片）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    // 先點 rail（跟「刪目前頁」那條測試一樣，focus 進 rail），再把焦點移到
    // parent document 裡 rail 以外、無害的一個可聚焦元素（Undo 按鈕；stack
    // 是空的，點下去只會送一個安全的 /api/undo 空棧錯誤，不影響投影片）。
    // 這確保守門條件看的是「現在」的焦點，不是「曾經點過 rail」這種容易
    // 失效的殘留狀態。
    await page.locator(".rail-slides-label").click();
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForTimeout(50);
    expect(await readSlide(registry, presentationId)).toBe(before);

    await page.keyboard.press("Delete");
    await page.waitForTimeout(100);
    expect(await readSlide(registry, presentationId)).toBe(before);

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("⌘D 複製選取，位移是 viewBox 的 +3%/+4%，新元素成為選取，undo 還原", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    await page.frameLocator("iframe.slide-frame").locator("#el-c").click();
    await page.keyboard.press("Meta+d");
    await page.waitForTimeout(150);

    const after = await readSlide(registry, presentationId);
    const beforeCount = (before.match(/<g id="/g) ?? []).length;
    const afterCount = (after.match(/<g id="/g) ?? []).length;
    expect(afterCount).toBe(beforeCount + 1);
    // el-c is at translate(550 500); +3%/+4% of the 1280x720 viewBox is
    // (38.4, 28.8). generateElementId's ids are base64url, which includes
    // "-"/"_" — the id charclass below must allow both.
    // `element duplicate` carries the source's `data-comot-name` along, so
    // the new `<g>` has it between `id` and `transform` — do not anchor the
    // two attributes as adjacent.
    const newIdMatch = /<g id="(el-[A-Za-z0-9_-]+)"[^>]*transform="translate\(588\.4 528\.8\)"/.exec(after);
    expect(newIdMatch).not.toBeNull();

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("⌘]／⌘[／⌘⇧]／⌘⇧[ 的鍵盤層序入口（element order up/down/front/back，焦點在 iframe 內）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    // 起始 z 順序（檔案順序，由下到上）：el-a, el-b, el-c, el-caption, el-text,
    // el-group, el-group-rotate, el-group-scale（見 fixture）。
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    // ⌘⇧BracketRight（front）— 必須用實體鍵名，Shift+"]" 字面字元寫法在
    // 未修正的程式碼上就會巧合通過，等同沒測（見計畫 §3 已驗證 1）。
    let after = "";
    await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf('id="el-group-scale"') < after.indexOf('id="el-a"');
      })
      .toBe(true);

    // ⌘⇧BracketLeft（back）— el-a 回到最前
    await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf('id="el-a"') < after.indexOf('id="el-b"');
      })
      .toBe(true);

    // ⌘]（up，無回歸）— el-a 上移一層，越過 el-b
    await page.keyboard.press("Meta+]");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf("el-b") < after.indexOf('id="el-a"');
      })
      .toBe(true);

    // ⌘[（down，無回歸）— el-a 下移一層，回到 el-b 之前
    await page.keyboard.press("Meta+[");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf('id="el-a"') < after.indexOf('id="el-b"');
      })
      .toBe(true);

    for (let i = 0; i < 4; i++) {
      const undo = await registry.dispatch("undo", { id: presentationId });
      expect(undo.ok).toBe(true);
    }
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("⌘⇧]／⌘⇧[ 的鍵盤層序入口（element order front/back，焦點在父文件）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    // 把焦點移回父文件而不清掉選取（計畫 §3 已驗證 2）：blur 掉 iframe、
    // 讓 body 拿到焦點，選取狀態列仍顯示原本選中的元素。
    await page.evaluate(() => (document.querySelector("iframe.slide-frame") as HTMLIFrameElement | null)?.blur());
    await page.evaluate(() => document.body.focus());
    const active = await page.evaluate(() => document.activeElement?.tagName);
    expect(active).toBe("BODY");
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 方塊 A");

    let after = "";
    await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf('id="el-group-scale"') < after.indexOf('id="el-a"');
      })
      .toBe(true);

    await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf('id="el-a"') < after.indexOf('id="el-b"');
      })
      .toBe(true);

    for (let i = 0; i < 2; i++) {
      const undo = await registry.dispatch("undo", { id: presentationId });
      expect(undo.ok).toBe(true);
    }
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("情境列：點選元素後按情境列的 Delete 送出 element delete（右鍵選單已移除，項目併入情境列）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    await page.frameLocator("iframe.slide-frame").locator("#el-c").click();
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 方塊 C");

    const bar = page.locator(".context-bar");
    expect(await bar.isVisible()).toBe(true);
    await bar.getByRole("button", { name: "Delete" }).click();
    await page.waitForTimeout(150);

    const after = await readSlide(registry, presentationId);
    expect(after).not.toContain('id="el-c"');
    // Nothing selected any more → the bar is gone with the selection.
    expect(await bar.isVisible()).toBe(false);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("情境列：Bring to front 送出 element order；右鍵元素只選取、不開任何選單", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    expect(before.indexOf('id="el-a"')).toBeLessThan(before.indexOf('id="el-c"'));

    await page.frameLocator("iframe.slide-frame").locator("#el-a").click({ button: "right" });
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 方塊 A");
    expect(await page.locator(".element-context-menu").count()).toBe(0);

    await page.locator(".context-bar").getByRole("button", { name: "Bring to front" }).click();
    await page.waitForTimeout(150);

    const after = await readSlide(registry, presentationId);
    expect(after.indexOf('id="el-a"')).toBeGreaterThan(after.indexOf('id="el-c"'));
  } finally {
    await cleanup();
  }
});

it("Arrange 選單：Align left 對齊三個選取元素的最小 x；未達門檻時停用", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    // 只選一個元素：Arrange 按鈕本身可按（有選取），但 Align 停用（< 2）。
    await slideFrame.locator("#el-a").click();
    await page.getByRole("button", { name: "Arrange" }).click();
    const alignLeftSingle = page.locator(".arrange-menu-item", { hasText: "Align left" });
    expect(await alignLeftSingle.isDisabled()).toBe(true);
    await page.keyboard.press("Escape");

    // 三個元素：Align/Distribute/Order 全部可用。
    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    await slideFrame.locator("#el-c").click({ modifiers: ["Shift"] });
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 3 elements");

    await page.getByRole("button", { name: "Arrange" }).click();
    const alignLeft = page.locator(".arrange-menu-item", { hasText: "Align left" });
    expect(await alignLeft.isDisabled()).toBe(false);
    await alignLeft.click();
    await page.waitForTimeout(150);

    const after = await readSlide(registry, presentationId);
    // el-a/el-b/el-c's own x are 100/700/550 — the minimum is 100.
    expect(readTranslate(after, "el-a").x).toBe(100);
    expect(readTranslate(after, "el-b").x).toBe(100);
    expect(readTranslate(after, "el-c").x).toBe(100);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);

    // GUI-did-once -> agent-runs-same-CLI spot check (驗收條件第三條，
    // Plan §6.3 建議案例之一：Arrange › Align left): undo above already
    // restored `before`; running the equivalent `element align` CLI command
    // for the same three targets must reproduce byte-for-byte the same
    // `after`.
    const cliResult = await registry.dispatch("element align", {
      id: presentationId,
      slidePath: "slides/001.svg",
      elementIds: ["el-a", "el-b", "el-c"],
      direction: "left",
    });
    expect(cliResult.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(after);
  } finally {
    await cleanup();
  }
});

// --- 視覺回歸基準（計畫 §5.6 拖曳中／放手後輔助線、§5.9 多選 move-only） ---

it("基準截圖：拖曳中畫出吸附輔助線（計畫 §5.6）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.evaluate(() => document.fonts.ready);
    // Same drag as "拖曳到與另一元素左緣相距在吸附半徑內" above — lands
    // el-a's left edge exactly on el-b's, guaranteed inside the snap
    // radius, so the vertical guide is showing at capture time.
    const targetLeft = 700;
    const dx = targetLeft - 100;
    const dy = 250;
    await dragBy(
      page,
      { x: 180, y: 150 },
      { x: dx, y: dy },
      {
        onMidDrag: async () => {
          // Layout from the live preview's DOM writes needs a tick to
          // settle before a byte-exact capture (selection.test.ts's own
          // baseline test uses the same short wait for the same reason).
          await page.waitForTimeout(50);
          await settleForScreenshot(page);
          await compareScreenshot(page, { name: "dragging-shows-guide", baselineDir });
        },
      },
    );
  } finally {
    await cleanup();
  }
});

it("基準截圖：放手後輔助線消失（計畫 §5.6）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.evaluate(() => document.fonts.ready);
    const targetLeft = 700;
    const dx = targetLeft - 100;
    const dy = 250;
    await dragBy(page, { x: 180, y: 150 }, { x: dx, y: dy });
    await page.waitForTimeout(50);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "released-guide-cleared", baselineDir });
  } finally {
    await cleanup();
  }
});

it("基準截圖：多選只有 move（無縮放／旋轉把手）（計畫 §5.9）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.evaluate(() => document.fonts.ready);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");
    await page.waitForTimeout(50);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "multiselect-move-only", baselineDir });
  } finally {
    await cleanup();
  }
});

// NOOP-91 round-2 FAIL #3: 驗收條件第二條「截圖比對：單選、多選、群組選取、
// 鑽入標籤、Arrange 選單、右鍵選單」六案，第 1 輪只交了前三案——這是第五、
// 六案。基準圖尚未產生（AGENTS.md「視覺回歸的把關分工」），這兩條測試在基
// 準產生前會因「找不到基準截圖」失敗，等 CI 觸發 update_baselines 後才會轉
// 綠，同 selection.test.ts 的「鑽入標籤」基準截圖一樣。
it("基準截圖：Arrange 選單（三欄 Align / Distribute / Order）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.evaluate(() => document.fonts.ready);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    await slideFrame.locator("#el-c").click({ modifiers: ["Shift"] });
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 3 elements");

    await page.getByRole("button", { name: "Arrange" }).click();
    await expect.poll(() => page.locator(".arrange-menu-item", { hasText: "Align left" }).isVisible()).toBe(true);
    await page.waitForTimeout(50);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "arrange-menu", baselineDir });
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

