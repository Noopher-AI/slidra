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

/**
 * Real Chromium acceptance tests, modelled on
 * e2e/selection.test.ts and e2e/stage.test.ts's startServerFor/openApp
 * shape: a real server, a real built `apps/web/dist`, and the
 * `e2e/fixtures/direct-manipulation-deck` fixture (`demo/` has no second
 * element close enough to exercise snapping without bending its layout,
 * per the plan's own assumption note).
 *
 * Scenario-to-test mapping (05-INTERACTIONS.feature's "move and scale
 * elements"):
 *
 * - "drag to snap" scenario (dragging a selected element / snap guides /
 *   Option disables snapping / release commits one history entry):
 *   - "dropping a single dragged element: the live preview string is
 *     byte-for-byte identical to what's written to the file, and the whole
 *     drag produces exactly one command"
 *   - "dragging within snap radius of another element's left edge: both left
 *     edges end up exactly equal, and guides are drawn/cleared"
 *   - "holding Alt while dragging to the same spot: no snapping — the left
 *     edge does not match the candidate element's left edge"
 *   - "Shift-clicking two elements then dragging together: both elements
 *     shift by the same amount, and only one command is produced"
 *   - "marquee-dragging from empty space: every element intersecting the box
 *     gets selected, and the presentation file's bytes are completely
 *     unchanged"
 *   - "dragging within snap radius of a text element's left edge: snaps to
 *     the text edge (a text element is itself a snap candidate)"
 *   - history-count invariants (100 mouse-move steps in one drag produce one
 *     history entry; 20 independent drags produce exactly 20 entries)
 * - "resize" scenario (dragging the four corner handles / minimum 3cqw x
 *   0.6cqh / never exceeds the slide bounds):
 *   - "holding Shift while dragging the se handle: scale by factor..."
 *     (uniform)
 *   - "dragging the se handle without Shift: goes through element resize..."
 *     (non-uniform, includes a GUI-to-CLI spot check)
 *   - "non-uniform resize of a rect whose local origin isn't (0,0): ..."
 *     (anchor-formula regression)
 *   - "dragging the se handle past the slide's edge: ...resize never exceeds
 *     the slide" (slide-boundary clamping)
 *   - three group-ancestor-chain tests (translate/rotate/scale) plus one for
 *     the text-box width handle — see each test's own title
 *
 * The remaining tests (Cmd+A / Delete / Cmd+D / Cmd+] / context bar / Arrange
 * menu / group enter-exit / command whitelist) don't map to either of those
 * two feature scenarios; they cover the rest of the acceptance criteria (CLI
 * parity, GUI-to-CLI spot checks) on their own, and each test's own title is
 * self-descriptive.
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
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/direct-manipulation-deck");
// Dedicated single-element fixture for the "rect at a non-zero local origin"
// resize-anchor regression — `direct-manipulation-deck`'s
// own el-a sits at local (0, 0), which is exactly the case that hid the bug.
const offsetDeckDir = path.join(e2eDir, "fixtures/direct-manipulation-offset-deck");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };
const VIEWBOX = { width: 1280, height: 720 };

let browser: Browser;
let openPages: Page[] = [];
let fontDataUrl: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist does not exist, please run npm run build first");
  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
  const fontBytes = await readFile(path.join(presentationFontDir, "NotoSansTC-Presentation.ttf"));
  fontDataUrl = `data:font/ttf;base64,${fontBytes.toString("base64")}`;
});

/**
 * Chromium's own `getComputedTextLength()` for `text` at `fontSizePx` in the
 * real embedded presentation font — same technique as
 * text-metrics.test.ts's `renderedWidthInChromium`, the external ground
 * truth this file's wrap assertion compares against now that the
 * TypeScript engine's own `wrapText`, previously used as the oracle here,
 * no longer exists.
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
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-dm-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-dm-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-dm-deck-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

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
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckStagingDir, slidraPath);
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
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
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

/** `<SLIDRA_HOME>/history/<presentationId>/stack.json`'s `undo` array length (history.ts) — a direct read of the invariant that dragging 100 times must not produce 100 history entries; each drag is exactly one entry. `startServerFor` sets `process.env.SLIDRA_HOME` for the whole test's lifetime. A never-edited presentation has no `stack.json` at all (history.ts's own documented "genuinely missing file" case) — treated as 0, not an error. */
async function undoCount(presentationId: string): Promise<number> {
  const home = process.env.SLIDRA_HOME!;
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
   * `waitForTimeout(150)` after mouseup. The
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

/** The page-viewport bounding box (center point) of one of selection-runtime.js's `data-slidra-handle` elements — Playwright's locator pierces the open shadow root and translates the nested-iframe coordinate system automatically. */
async function handleCenter(page: Page, name: string): Promise<{ x: number; y: number }> {
  const handle = page.frameLocator("iframe.slide-frame").locator(`[data-slidra-handle="${name}"]`);
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

it("dropping a single dragged element: the live preview string matches the written file byte-for-byte, and the drag produces exactly one command", async () => {
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

    // GUI-did-once -> agent-runs-same-CLI spot check (move): undo above
    // already restored `before`;
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

it("dropping a single dragged element: the overview thumbnail (iframe.overview-frame) transform stays in sync, and undo restores the thumbnail too", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const beforeTransform = readTransformAttr(before, "el-a");

    // overview.ts's fetchAndFillThumbnail() sets the iframe's `srcdoc` from
    // a plain fetch of the slide file — same markup, same el-a `<g>` — so
    // this is the thumbnail's own copy of the transform, not the main
    // canvas's.
    const thumbEl = page.frameLocator('.overview-item[data-index="0"] iframe.overview-frame').locator("#el-a");
    await expect.poll(() => thumbEl.getAttribute("transform").catch(() => null), { timeout: 15_000 }).toBe(beforeTransform);

    await dragBy(page, { x: 180, y: 150 }, { x: 60, y: 40 }); // inside el-a (100..260, 100..200)

    const after = await readSlide(registry, presentationId);
    const afterTransform = readTransformAttr(after, "el-a");
    expect(afterTransform).not.toBe(beforeTransform);

    // The drop's live reload pushes a `presentation-changed` SSE event,
    // which App.tsx's listener forwards to `overviewControllerRef.current.refresh()`
    // (see App.tsx's own comment there) — the thumbnail must pick up the moved
    // element without a page reload.
    await expect.poll(() => thumbEl.getAttribute("transform").catch(() => null), { timeout: 15_000 }).toBe(afterTransform);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);

    await expect.poll(() => thumbEl.getAttribute("transform").catch(() => null), { timeout: 15_000 }).toBe(beforeTransform);
  } finally {
    await cleanup();
  }
});

it("a single drag with 100 mouse-move steps in the middle produces exactly one history entry", async () => {
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

// The acceptance criterion behind this test originally called for "100
// consecutive independent drags produce exactly undo.length +100", but
// history.ts's UNDO_STACK_CAP = 50 (a pre-existing, unrelated constant —
// entries beyond 50 get evicted, and `history.test.ts` already has its own
// "51st edit" test for it) means that starting from 0 history entries, only
// the last 50 of 100 drags would remain — the "+100" figure itself can never
// be reached. This uses a count of 20 instead, safely below that cap, to
// verify the same "no dedup/merge" invariant (each independent drag counts
// as its own entry) without running into that unrelated pre-existing limit.
it("20 consecutive independent drags produce exactly 20 history entries (no more, no less, never merged)", async () => {
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
      // which is what made this test observe only 19 of 20 entries.
      await expect.poll(() => undoCount(presentationId)).toBe(beforeUndoCount + i + 1);
    }

    expect(await undoCount(presentationId)).toBe(beforeUndoCount + REPEATS);
  } finally {
    await cleanup();
  }
}, 60_000);

it("the context bar hides during a drag; both selection and context bar survive the reload after drop", async () => {
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

it("dragging within snap radius of another element's left edge: both left edges end up exactly equal, and guides are drawn/cleared", async () => {
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

    // Per ADR-0011: guides are drawn by the parent document's
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

it("holding Alt while dragging to the same spot: no snapping — left edge does not match the candidate element's left edge", async () => {
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

it("Shift-clicking two elements then dragging together: both elements shift by the same amount, and only one command is produced", async () => {
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
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement | null;
      const handles = host?.shadowRoot?.querySelectorAll("[data-slidra-handle]") ?? [];
      return [...handles].filter((el) => (el as HTMLElement).style.display !== "none").length;
    });
    expect(visibleHandleCount).toBe(0);

    // Drag starting inside el-a — already part of the current selection, so
    // both ids move together.
    await dragBy(page, { x: 180, y: 150 }, { x: 30, y: 20 });

    const after = await readSlide(registry, presentationId);
    const a = readTranslate(after, "el-a");
    const b = readTranslate(after, "el-b");
    // toBeCloseTo, not toBe: `a.y`/`b.y` are independently parsed from two
    // separately-formatted decimal strings in the written file, so their
    // shifted differences are only guaranteed equal to the file's own
    // 4-decimal write precision, not bit-for-bit — reload() now awaits an
    // extra font fetch before the first render (a later fonts fix), and that
    // timing shift was enough to move the real mouse-driven drag by roughly
    // one part in 1e13, previously masked by this assertion's
    // stricter-than-warranted `toBe`.
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

it("marquee-dragging from empty space: every element intersecting the box gets selected, and the presentation file's bytes are completely unchanged", async () => {
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

it("a marquee covering a text element: the text element itself can be selected by marquee (regression: fonts weren't passed into elementBounds)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // el-text: translate(950 100), a text BOX (data-slidra-text-width="300")
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
    // el-group-rotate into the selection. Ending the
    // drag at y=200 keeps 40 units of margin below el-text's own bottom edge
    // (~160) and 50 units clear of el-group-rotate's bbox top (250), so the
    // marquee covers el-text with room to spare on both sides regardless of
    // stage width.
    await dragBy(page, { x: 900, y: 50 }, { x: 370, y: 150 }); // -> (1270, 200)

    const selName = page.locator(".status-selection-chip");
    // el-text carries no `data-slidra-name`, so the status bar falls back to
    // the raw id (StatusBar.tsx).
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: el-text");
  } finally {
    await cleanup();
  }
});

it("dragging within snap radius of a text element's left edge: snaps to the text edge (a text element is itself a snap candidate)", async () => {
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
    // also el-a's own unsnapped raw endpoint.
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

    // Per ADR-0011: guides are drawn by the parent document's
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

it("holding Shift while dragging the se handle and releasing: scale changes by factor, translate is entirely unchanged, and only one command is produced", async () => {
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
    // Holding Shift is what selects the UNIFORM path —
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

it("dragging the se handle and releasing (without Shift): goes through element resize — non-uniform scale, anchored at the opposite (nw) corner, one command", async () => {
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

    // GUI-did-once -> agent-runs-same-CLI spot check: undo
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

it("non-uniform resize of a rect whose local origin isn't (0,0): the nw corner matches between live preview and after release, in client coordinates (anchor-formula regression test)", async () => {
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
    // Same non-uniform ratios as the sibling "without Shift" test above (width
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
    // instead of guessing a fixed delay — a
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

it("dragging the se handle past the slide's bottom-right corner: the resulting bbox's right/bottom edge clamps to the viewBox edge (resize never exceeds the slide)", async () => {
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

it("dragging the rotate handle and releasing: rotate changes by the expected delta, translate/scale are unchanged", async () => {
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

it("double-click into a translated group, then Shift-drag a child's resize handle: the origin applies the ancestor's translate (regression test)", async () => {
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
    // what the pre-fix code used (dragging to the exact 2x point produced a ~90-wide box instead of 160).
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

it("double-click into a rotated group, then Shift-drag a child's resize handle: the origin applies the ancestor's rotation, sharing the same core-matrix path as rotate", async () => {
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

it("double-click into a scaled group, then drag a child's rotate handle: the origin applies the ancestor's scale, and the delta isn't distorted by it", async () => {
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

it("dragging the text box's left handle and releasing: data-slidra-text-width updates to the new width, tspan count never increases, every line's actual rendered width fits the new width, and font-size is unchanged", async () => {
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
    // units — since `textbox width` has no position input, so the container
    // never moves, that grows the width by 60 regardless of which handle is dragged.
    const nowPage = { x: leftHandle.x - 60 * pixelsPerUser, y: leftHandle.y };
    await dragPageTo(page, leftHandle, nowPage);

    const after = await readSlide(registry, presentationId);
    const widthMatch = /<g id="el-text" data-slidra-text-width="([\d.]+)"/.exec(after);
    expect(widthMatch).not.toBeNull();
    const newWidth = Number(widthMatch![1]);
    expect(newWidth).toBeCloseTo(360, 0);

    // font-size is untouched — only the frame width changed.
    const fontSizeMatch = /<text font-family="Noto Sans TC" font-size="([\d.]+)"/.exec(after);
    expect(fontSizeMatch).not.toBeNull();
    expect(Number(fontSizeMatch![1])).toBe(24);

    // Non-circular wrap assertions (the TypeScript engine's
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

it("double-click into a group, then drag a single child inside it: only the child's transform changes, the group's own transform stays put", async () => {
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

it("pressing Esc to exit group-edit mode, then clicking the same screen position: selection resolves to the whole group (outermost rule), not the child", async () => {
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

// --- Keyboard shortcuts, context bar, Arrange menu (the right-click menu is gone) ---

it("Cmd+A selects every top-level element on this slide (not children inside groups), and works while focus is in the parent document", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // Top-level elements on this slide: el-a/el-b/el-c/el-caption/el-text/
    // el-group/el-group-rotate/el-group-scale — 8 total, not counting
    // children inside groups.
    await page.keyboard.press("Meta+a");
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 8 elements");
  } finally {
    await cleanup();
  }
});

it("the Delete key removes the current selection and undo restores it; a no-op with nothing selected", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    // Nothing selected: Delete should have no effect.
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

it("focus was once in the rail, then moved outside it: Delete/Backspace leave the slide completely untouched (regression: this used to delete the whole slide)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    // First click the rail (same as the "delete current slide" test, putting
    // focus in the rail), then move focus to a harmless focusable element in
    // the parent document outside the rail (the Undo button; the stack is
    // empty, so clicking it just sends a safe /api/undo empty-stack error
    // without touching the slide). This makes sure the guard condition looks
    // at the CURRENT focus, not a stale "once clicked the rail" state that
    // could easily go wrong.
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

it("Cmd+D duplicates the selection with an offset of +3%/+4% of the viewBox, the new element becomes the selection, and undo restores it", async () => {
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
    // `element duplicate` carries the source's `data-slidra-name` along, so
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

it("Cmd+]/Cmd+[/Cmd+Shift+]/Cmd+Shift+[ as keyboard entry points for z-order (element order up/down/front/back), with focus inside the iframe", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    // Starting z-order (file order, bottom to top): el-a, el-b, el-c,
    // el-caption, el-text, el-group, el-group-rotate, el-group-scale (see
    // the fixture).
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    // Cmd+Shift+BracketRight (front) — must use the physical key name; a
    // literal Shift+"]" spelling would coincidentally pass even on
    // unfixed code, which is the same as not testing it at all.
    let after = "";
    await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf('id="el-group-scale"') < after.indexOf('id="el-a"');
      })
      .toBe(true);

    // Cmd+Shift+BracketLeft (back) — el-a returns to the very front
    await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf('id="el-a"') < after.indexOf('id="el-b"');
      })
      .toBe(true);

    // Cmd+] (up) — el-a moves up one layer, past el-b
    await page.keyboard.press("Meta+]");
    await expect
      .poll(async () => {
        after = await readSlide(registry, presentationId);
        return after.indexOf("el-b") < after.indexOf('id="el-a"');
      })
      .toBe(true);

    // Cmd+[ (down) — el-a moves down one layer, back before el-b
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

it("Cmd+Shift+]/Cmd+Shift+[ as keyboard entry points for z-order (element order front/back), with focus in the parent document", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    // Move focus back to the parent document without clearing the
    // selection: blur the iframe so the body takes focus, while the
    // selection status bar still shows the originally selected element.
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

it("context bar: clicking an element then pressing the context bar's Delete sends element delete (the right-click menu is gone, folded into the context bar)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);

    await page.frameLocator("iframe.slide-frame").locator("#el-c").click();
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 方塊 C");

    const bar = page.locator(".context-bar");
    expect(await bar.isVisible()).toBe(true);
    // Ghost until hovered long enough to solidify.
    const barBox = (await bar.boundingBox())!;
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
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

it("context bar: Bring to front sends element order; right-clicking an element only selects it, without opening any menu", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    expect(before.indexOf('id="el-a"')).toBeLessThan(before.indexOf('id="el-c"'));

    await page.frameLocator("iframe.slide-frame").locator("#el-a").click({ button: "right" });
    const selName = page.locator(".status-selection-chip");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 方塊 A");
    expect(await page.locator(".element-context-menu").count()).toBe(0);

    // Ghost until hovered long enough to solidify.
    const bringToFrontBox = (await page.locator(".context-bar").getByRole("button", { name: "Bring to front" }).boundingBox())!;
    await page.mouse.move(bringToFrontBox.x + bringToFrontBox.width / 2, bringToFrontBox.y + bringToFrontBox.height / 2);
    await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
    await page.locator(".context-bar").getByRole("button", { name: "Bring to front" }).click();
    await page.waitForTimeout(150);

    const after = await readSlide(registry, presentationId);
    expect(after.indexOf('id="el-a"')).toBeGreaterThan(after.indexOf('id="el-c"'));
  } finally {
    await cleanup();
  }
});

it("Arrange menu: Align left aligns three selected elements to their minimum x; disabled below the threshold", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    // Only one element selected: the Arrange button itself is clickable
    // (something is selected), but Align is disabled (needs >= 2).
    await slideFrame.locator("#el-a").click();
    await page.getByRole("button", { name: "Arrange" }).click();
    const alignLeftSingle = page.locator(".arrange-menu-item", { hasText: "Align left" });
    expect(await alignLeftSingle.isDisabled()).toBe(true);
    await page.keyboard.press("Escape");

    // Three elements: Align/Distribute/Order are all enabled.
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

    // GUI-did-once -> agent-runs-same-CLI spot check (Arrange › Align left):
    // undo above already
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

it("POST /api/command whitelist: a blacklisted command returns 403 and the presentation's bytes are unchanged", async () => {
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

