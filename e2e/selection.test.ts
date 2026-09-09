import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
 * 元素選取 (#56, ADR-0011): clicking an element on the canvas in view mode
 * selects it, draws a four-corner box over it in a Shadow DOM, and shows
 * its 顯示名稱 (or 識別碼 fallback) in the status bar. Modeled on
 * e2e/demo-deck.test.ts's startServerFor shape and e2e/player-hostile.test.ts's
 * hostile-fixture posture.
 *
 * Every click below uses a real Playwright locator click (dispatches a
 * trusted mouse event) or `page.mouse.click()` at a measured coordinate —
 * never `element.click()` inside page script — because wave 4's grid unit
 * found a real gap here: DOM `.click()` passes even when a missing
 * `pointer-events: none` would swallow a genuine mouse event.
 *
 * 場景 ↔ 測試對照表（05-INTERACTIONS.feature，NOOP-91 round-2 FAIL #4 補做
 * ——第 1 輪漏做）：
 *
 * - 功能「選取」› 場景「單選」（出現選取框/左上名稱標籤/情境列正下方）:
 *   - "點畫布上的元素會選起它，出現四角選取框（畫在 Shadow DOM 裡，不是 b/u 八點）"
 *   - "狀態列顯示選取元素的顯示名稱；沒有顯示名稱的元素顯示其識別碼"
 *   - "單選一個元素：出現名稱標籤（選取框正上方）與情境列（選取框正下方）"
 *   - "基準截圖：標準檢視含選取框"／"點 demo 第 1 頁的背景會選到背景容器..."
 *   - "敵意投影片的 CSS 蓋不掉 Shadow DOM 選取框..."／"投影片自己的 script 搶先攔截點擊..."
 *   - "離開播放後仍可重新選取：..."
 *   - 情境列「空間不足翻到上方」分支：本檔未 e2e 化，理由見「選取後簡報檔案
 *     位元組完全未變」測項之前的說明區塊——精確覆蓋在
 *     packages/web/test/stage-overlays.test.ts（純邏輯單元測試）。
 * - 功能「選取」› 場景「多選」「全選 / 取消」: ⇧點/框選/⌘A 是舞台直接操作，
 *   在 e2e/direct-manipulation.test.ts 測（"Shift 點兩個元素後一起拖曳"、
 *   "從空白處拖出框選矩形"、"⌘A 全選本頁頂層元素..."）；本檔只測「點空白處
 *   取消選取，狀態列的選取顯示區清空」（Esc/點空白清除選取的那一半）。
 * - 功能「群組（含巢狀）」› 場景「選取群組」:
 *   - "點群組裡的子元素，選到的是整個群組，狀態列顯示群組的顯示名稱"
 *   - "選取群組時顯示虛線框"
 * - 功能「群組（含巢狀）」› 場景「鑽入」（標籤顯示路徑「Group 2 › Group 1」）:
 *   - "巢狀逐層進入時虛線框逐層疊加：每進一層新增一個框，外層的框保留不動"
 *   - "Esc 逐層退出：每次只收掉最內層的框，其餘外層框保留至也被退出為止"
 *   - "拖曳作用對象與選取層級一致：..."
 *   - "基準截圖：群組編輯中的虛線框"／"基準截圖：鑽入群組後的標籤（Group 2 › Group 1 路徑）"
 * - 功能「群組（含巢狀）」› 場景「成組」「巢狀」「解組」（[E2.T15]/#205，Dock
 *   的 Group/Ungroup 按鈕；「停用態」矩陣本身測在
 *   packages/web/test/dock.test.ts，這裡只測按鈕真的接到命令、檔案真的變了）:
 *   - "成組：Shift 選 2 個元素、按 Group，成員自身動畫被移除並顯示 toast"
 *     （含基準截圖 group-toast）
 *   - "巢狀：選「一個既有群組 ＋ 一個元素」按 Group，外層再包一層，既有群組原封不動"
 *   - "解組：整組選取後按 Ungroup，只解目前這一層——內層群組與其動畫皆保留在外的那一層被移除"
 *
 * 其餘測項（沙箱 sandbox 屬性、播放模式互動）不對應本檔案上述場景，各自的
 * 測項名稱已自我描述。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const hostileDeckDir = path.join(e2eDir, "fixtures/hostile-selection-deck");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/selection");

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

async function startServerFor(
  deckDir: string,
): Promise<{ server: RunningServer; registry: CommandRegistry; presentationId: string; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-selection-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-selection-files-"));
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
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

/** Loads the app and waits for the first slide to actually be painted before returning the page. */
async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return page;
}

/**
 * The Playwright `Frame` object for the main canvas iframe, distinguished
 * from the overview thumbnail iframes (which also have `srcdoc` documents)
 * by its `class="slide-frame"` element — same disambiguation
 * e2e/player.test.ts already uses. Needed whenever a test has to run JS
 * *inside* the iframe's own document (its opaque origin makes normal
 * cross-document access from page script impossible; Playwright's CDP-based
 * `Frame.evaluate` is not subject to that restriction).
 */
async function canvasFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  throw new Error("找不到主畫布的 iframe.slide-frame");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

it("檢視模式的主畫布 iframe sandbox 是 allow-scripts，且不含 allow-same-origin", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const sandbox = await page.locator("iframe.slide-frame").getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  } finally {
    await cleanup();
  }
});

// ADR-0011: this loosening is cut in exactly one place, the main canvas —
// the overview rail's thumbnails must stay zero-token.
it("總覽縮圖的 iframe sandbox 仍是零 token（這個洞只鑿在主畫布一處）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await expect.poll(() => page.locator("iframe.overview-frame").count()).toBeGreaterThan(0);
    const thumbSandbox = await page.locator("iframe.overview-frame").first().getAttribute("sandbox");
    expect(thumbSandbox).toBe("");
  } finally {
    await cleanup();
  }
});

it("點畫布上的元素會選起它，出現四角選取框（畫在 Shadow DOM 裡，不是 b/u 八點）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const titleLocator = page.frameLocator("iframe.slide-frame").locator("#el-title");
    await titleLocator.click();

    const frame = await canvasFrame(page);
    const corners = await frame.evaluate(() => {
      // The shadow host carries a stable attribute (selection-runtime.js),
      // not a DOM-position assumption — the runtime is injected before
      // the fetched slide markup (#56 fix), so the host is not
      // document.body's last child.
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
      const root = host.shadowRoot;
      if (!root) return null;
      const sel = root.querySelector(".sel");
      const i = sel?.querySelector("i") ?? null;
      if (!sel || !i) return null;
      const contentOf = (el: Element, pseudo: string) => getComputedStyle(el, pseudo).content;
      return {
        display: getComputedStyle(sel).display,
        topLeft: contentOf(sel, "::before"),
        topRight: contentOf(sel, "::after"),
        bottomLeft: contentOf(i, "::before"),
        bottomRight: contentOf(i, "::after"),
        // 軍令 4: exactly four corners, never eight handles — the
        // template's `b`/`u` elements must never be created.
        hasB: root.querySelector("b") !== null,
        hasU: root.querySelector("u") !== null,
      };
    });

    expect(corners).not.toBeNull();
    expect(corners!.display).toBe("block");
    expect(corners!.topLeft).not.toBe("none");
    expect(corners!.topRight).not.toBe("none");
    expect(corners!.bottomLeft).not.toBe("none");
    expect(corners!.bottomRight).not.toBe("none");
    expect(corners!.hasB).toBe(false);
    expect(corners!.hasU).toBe(false);
  } finally {
    await cleanup();
  }
});

it("狀態列顯示選取元素的顯示名稱；沒有顯示名稱的元素顯示其識別碼", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    await slideFrame.locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 標題");

    await slideFrame.locator("#el-plain").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: el-plain");
  } finally {
    await cleanup();
  }
});

/**
 * A deck built inside the test, so a test that needs a particular slide
 * shape does not have to bend `demo/` (or `e2e/fixtures/`, which other
 * tests own) into that shape. Written in the compliant container form
 * (ADR-0012).
 */
async function makeDeckDir(slideSvg: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-selection-deck-"));
  await mkdir(path.join(dir, "slides"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(
    path.join(dir, "project.json"),
    JSON.stringify(
      { formatVersion: 1, name: "選取測試簡報", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] },
      null,
      2,
    ),
    "utf-8",
  );
  await writeFile(path.join(dir, "slides/001.svg"), slideSvg, "utf-8");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// This test used `demo/` until #72, and cannot any more — for a reason that
// is the ticket itself. Demo slide 1's background `<rect>` is now an
// element of its own inside a container with an id, so there is no longer
// any point on that page with nothing under it. Leaving the background out
// of conversion just to keep one test's assumption alive would be the wrong
// repair, so the test brings its own deck instead: one small square with
// generous empty space around it.
it("點空白處取消選取，狀態列的選取顯示區清空", async () => {
  const deck = await makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-square" data-comot-name="方塊">\n' +
      '    <rect x="540" y="280" width="200" height="160" fill="#c66"/>\n' +
      "  </g>\n" +
      // openApp waits for the first painted <text>; a deck with none would
      // never finish loading as far as that helper is concerned.
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="500" text-anchor="middle" font-size="32" fill="#9aa7b4">方塊</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    await slideFrame.locator("#el-square").click();
    // The postMessage round trip from selection-runtime.js to React state
    // is asynchronous — poll rather than reading immediately after click.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).not.toBe("");

    // The slide's top-left corner: the square sits at x=540 y=280 on a
    // 1280×720 viewBox, so this point has no element under it at all.
    const svgRoot = slideFrame.locator("svg").first();
    const box = await svgRoot.boundingBox();
    if (!box) throw new Error("量不到 svg 的邊界框");
    await page.mouse.click(box.x + 4, box.y + 4);

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("");

    const frame = await canvasFrame(page);
    const boxDisplay = await frame.evaluate(() => {
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
      const sel = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay).toBe("none");
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// NOOP-91 round-2 FAIL #4: 05-INTERACTIONS.feature「選取 › 單選」的
// 「出現…左上名稱標籤」「情境列出現在選取框正下方（空間不足則翻到上方）」
// 兩句「而且」句子此前完全沒有 e2e 覆蓋（座標換算邏輯的單元測試見
// packages/web/test/stage-overlays.test.ts；這裡驗證真實瀏覽器的最終定位）。
it("單選一個元素：出現名稱標籤（選取框正上方）與情境列（選取框正下方）", async () => {
  const deck = await makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-square" data-comot-name="方塊">\n' +
      // Bottom edge at y=200, leaving 520 user units of slide below it —
      // comfortably more than the context bar's fixed 49 CSS px (GAP 13 +
      // BAR_HEIGHT 36) floor at any realistic render scale.
      '    <rect x="540" y="100" width="200" height="100" fill="#c66"/>\n' +
      "  </g>\n" +
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="500" text-anchor="middle" font-size="32" fill="#9aa7b4">方塊</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-square").click();

    const label = page.locator(".selection-label");
    await expect.poll(() => label.textContent().catch(() => null)).toBe("方塊");

    const selBox = await slideFrame.locator(".sel").boundingBox();
    const labelBox = await label.boundingBox();
    const barBox = await page.locator(".context-bar").boundingBox();
    expect(selBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    expect(barBox).not.toBeNull();

    // Label sits above the selection box's own top edge (a small tolerance
    // for sub-pixel layout rounding, not for being wrong by a whole line).
    expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(selBox!.y + 1);
    // Context bar sits below the selection box's own bottom edge.
    expect(barBox!.y).toBeGreaterThanOrEqual(selBox!.y + selBox!.height - 1);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// The above-flip branch (`ContextBar`'s `fitsBelow === false`) is NOT
// e2e'd here — measured directly (see this PR's delivery notes): `.canvas-
// area`'s CSS reserves a FIXED `--space-gutter-bottom: 76px` below the
// rendered slide (packages/web/src/styles/tokens.css), and the flip
// threshold is GAP(8) + BAR_HEIGHT(40) = 48px < 76px. Any element placed
// anywhere within the slide's own bounds therefore always leaves at least
// 76px below it — `fitsBelow` is mathematically guaranteed true for every
// reachable-by-content-placement position, at every viewport size tried
// (probed at well heights from ~150px to ~700px). The flip branch is only
// reachable through zoom+pan pushing a selection's on-screen box past the
// visible well's edge, which this suite does not attempt to orchestrate
// precisely — `packages/web/test/stage-overlays.test.ts` unit-tests both
// branches of `ContextBar`'s `fitsBelow` decision directly against its own
// props instead, including the exact boundary case, which is the more
// precise place to pin this particular piece of logic down.

it("選取後簡報檔案位元組完全未變", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor(demoDir);
  try {
    const before = sha256(
      (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!
        .content,
    );

    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await page.frameLocator("iframe.slide-frame").locator("#el-subtitle").click();

    const after = sha256(
      (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!
        .content,
    );
    expect(after).toBe(before);
  } finally {
    await cleanup();
  }
});

// ADR-0011's own reasoning: a slide's `*`/`::before` rule cannot cross a
// Shadow DOM boundary, which is what selection-runtime.js relies on to
// keep its box visible under hostile CSS. This test proves the boundary
// actually holds by building a second, deliberately naive light-DOM box
// with the same markup inside the same iframe and showing the fixture
// really does defeat it — a fixture that fails to defeat a naive
// implementation would prove nothing about the Shadow DOM.
it("敵意投影片的 CSS 蓋不掉 Shadow DOM 選取框，同一份 CSS 會蓋掉沒用 Shadow DOM 的對照組", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const frame = await canvasFrame(page);
    const measurement = await frame.evaluate(() => {
      // The real box selection-runtime.js already drew, inside its shadow
      // root — protected by the host's own inline !important styles.
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
      const realBox = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      if (!realBox) return null;
      const realStyle = getComputedStyle(realBox);

      // The naive control: the *same* markup (`.sel` + `<i>`), but placed
      // directly in the light DOM with no shadow root and no inline
      // !important defence — exactly what selection-runtime.js would look
      // like without ADR-0011's Shadow DOM requirement.
      const control = document.createElement("div");
      control.className = "sel";
      control.appendChild(document.createElement("i"));
      document.body.appendChild(control);
      const controlStyle = getComputedStyle(control);

      return {
        realDisplay: realStyle.display,
        realVisibility: realStyle.visibility,
        realOpacity: realStyle.opacity,
        controlDisplay: controlStyle.display,
        controlVisibility: controlStyle.visibility,
        controlOpacity: controlStyle.opacity,
        // Corroborating, not conclusive, evidence for the covering vector
        // (the full-viewport high-z-index overlay): the CSS values the
        // browser's own paint-order algorithm uses. This does not
        // substitute for a pixel-level "is it actually painted on top"
        // measurement — see the unit's own report for why one was not
        // attempted (the box is deliberately `pointer-events: none`,
        // which excludes it from `elementFromPoint` hit-testing, the
        // usual non-pixel way to ask "what's on top here").
        hostZIndex: getComputedStyle(host).zIndex,
        hostPosition: getComputedStyle(host).position,
      };
    });

    expect(measurement).not.toBeNull();
    // The naive light-DOM control genuinely gets defeated by the hostile
    // `*` rule — proving this fixture is actually hostile, not a no-op.
    expect(measurement!.controlDisplay).toBe("none");
    expect(measurement!.controlVisibility).toBe("hidden");
    expect(measurement!.controlOpacity).toBe("0");
    // The real, shadow-DOM box survives the exact same stylesheet.
    expect(measurement!.realDisplay).toBe("block");
    expect(measurement!.realVisibility).toBe("visible");
    expect(measurement!.realOpacity).toBe("1");
    // The overlay's own z-index is 999999999; our host's inline
    // !important z-index (2147483647, the max signed 32-bit value) and
    // `position: fixed` outrank it in the values the cascade computes,
    // even though this test does not sample pixels to confirm paint order.
    expect(Number(measurement!.hostZIndex)).toBeGreaterThan(999999999);
    expect(measurement!.hostPosition).toBe("fixed");
  } finally {
    await cleanup();
  }
});

// Gate review round 1 (#56): the view-mode iframe has `allow-scripts` too
// (ADR-0011), so any slide script can forge a `comot-player` message by
// hand — `event.source === frame.contentWindow` only proves which iframe
// sent it, never which script inside that iframe did. Before canvas.ts's
// mode gate, this forged message drove advancePastEnd() and replaced the
// view-mode srcdoc with the play document (containing
// `window.__COMOT_PLAN__`) while mode stayed "view" — reproduced directly
// against this branch's pre-fix canvas.ts. Slide 2 of hostile-selection-deck
// carries the forging script; slide 1's hostile CSS plays no part here.
// Slide 2 is deliberately not the deck's last slide (slide 3 is harmless
// filler after it): advancePastEnd() is a no-op on the last slide even
// with no gate at all, so landing on the true last slide would make this
// test pass whether or not the fix is in place.
it("檢視模式下，投影片偽造 comot-player 訊息不會換頁、也不會把 iframe 換成播放文件", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    const pageIndicator = page.locator(".slide-nav-position");
    const slideFrame = page.locator("iframe.slide-frame");

    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 1 of 4");
    await page.locator('button[aria-label="Next slide"]').click();
    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 2 of 4");

    const sandbox = await slideFrame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");

    // Slide 2's script fires its forged message 300ms after load; give it
    // comfortably longer than that before asserting nothing moved.
    await page.waitForTimeout(600);

    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 2 of 4");
    const srcdoc = await slideFrame.getAttribute("srcdoc");
    expect(srcdoc).not.toBeNull();
    expect(srcdoc).not.toContain("__COMOT_PLAN__");
  } finally {
    await cleanup();
  }
});

// Gate round 2 (#56): slide 4 of hostile-selection-deck installs a
// capturing `window` click listener that calls
// `event.stopImmediatePropagation()` the moment its inline script runs.
// Before the fix, this silently killed selection with no visible error:
// wrapSelectionDocument() put the runtime AFTER the slide markup, so the
// slide's script ran (and registered) first, and the runtime's own
// listener lived on `document`/bubbling, which capture never even
// reaches. The click below is a real mouse click (Playwright locator
// click), never `element.click()` in page script, per this file's own
// posture note above.
it("投影片自己的 script 搶先攔截點擊（stopImmediatePropagation）也選不掉：狀態列與選取框仍更新", async () => {
  const { server, cleanup } = await startServerFor(hostileDeckDir);
  try {
    const page = await openApp(server);
    const pageIndicator = page.locator(".slide-nav-position");
    for (let i = 0; i < 3; i++) {
      await page.locator('button[aria-label="Next slide"]').click();
    }
    await expect.poll(() => pageIndicator.textContent()).toBe("Slide 4 of 4");

    const selName = page.locator(".status-selection-chip");
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 標題");

    const frame = await canvasFrame(page);
    const boxDisplay = await frame.evaluate(() => {
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
      const sel = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay).toBe("block");
  } finally {
    await cleanup();
  }
});

// 裁決 6 (#56): exitPlay() destroys the play iframe and rebuilds it in view
// mode — that rebuild must re-inject selection-runtime.js, or selection
// silently stops working with no error and no failed assertion anywhere
// else. Both the status bar text and the Shadow DOM box are asserted: the
// status bar alone would not catch a rebuilt frame that lost its box.
it("離開播放後仍可重新選取：狀態列顯示顯示名稱，且選取框仍畫在 Shadow DOM 裡", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);

    await page.locator(".play-from-start-button").click();
    // Shell collapsing (titlebar unmounts) is direct evidence play mode
    // took effect — same signal e2e/shell.test.ts polls after this same
    // click, chosen over the sandbox attribute because both modes now
    // carry allow-scripts (ADR-0011).
    await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

    await page.locator('button:has-text("離開播放")').click();
    // Symmetric wait for the round trip back to view mode: the titlebar
    // (and with it its own Play-from-start button) reappears.
    await expect.poll(() => page.locator(".titlebar").count()).toBe(1);

    const selName = page.locator(".status-selection-chip");
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 標題");

    const frame = await canvasFrame(page);
    const boxDisplay = await frame.evaluate(() => {
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
      const sel = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay).toBe("block");
  } finally {
    await cleanup();
  }
});

it("基準截圖：標準檢視含選取框", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await page.evaluate(() => document.fonts.ready);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    // The box's geometry is read from getBoundingClientRect() at click
    // time; give layout a tick to settle before the byte-exact capture.
    await page.waitForTimeout(50);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "selected", baselineDir });
  } finally {
    await cleanup();
  }
});

// --- #72: 選取改為認容器 ---------------------------------------------------

// The demo's background rect used to be unselectable (it had no id). After
// conversion it is a real element, and clicking it selects its container.
// This is the correct new behaviour, not a regression: #85's locking is
// what will later make "I don't want to select the background" possible.
// The status bar falls back to showing the 識別碼, because conversion does
// not invent a 顯示名稱 for an element whose author never gave it one.
it("點 demo 第 1 頁的背景會選到背景容器，狀態列顯示它的識別碼", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    const svgRoot = slideFrame.locator("svg").first();
    const box = await svgRoot.boundingBox();
    if (!box) throw new Error("量不到 svg 的邊界框");
    await page.mouse.click(box.x + 4, box.y + 4);

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toMatch(/^Selected: el-.+$/);
    // Not one of the two named elements — it really is the background.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).not.toBe("Selected: 標題");
  } finally {
    await cleanup();
  }
});

// ADR-0012: a group is a container of containers, so clicking a child
// inside a group selects the whole group — PowerPoint's semantics. This is
// what "選取改為認容器" actually buys, and it is invisible on `demo/`
// (which has no groups), so the test brings its own deck.
it("點群組裡的子元素，選到的是整個群組，狀態列顯示群組的顯示名稱", async () => {
  const deck = await makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-group" data-comot-name="群組">\n' +
      '    <g id="el-child-left" data-comot-name="左邊">\n' +
      '      <rect x="200" y="260" width="200" height="200" fill="#c66"/>\n' +
      "    </g>\n" +
      '    <g id="el-child-right" data-comot-name="右邊">\n' +
      '      <rect x="880" y="260" width="200" height="200" fill="#69c"/>\n' +
      "    </g>\n" +
      "  </g>\n" +
      // openApp waits for the first painted <text>; see makeDeckDir's other
      // caller. This one sits well outside the group.
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="620" text-anchor="middle" font-size="32" fill="#9aa7b4">群組測試</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const selName = page.locator(".status-selection-chip");

    // Click the child's own `<rect>`. The nearest id-carrying ancestor is
    // el-child-left; the outermost is el-group, and el-group is the answer.
    await page.frameLocator("iframe.slide-frame").locator("#el-child-left rect").click();

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 群組");
    // 功能「群組（含巢狀）」› 場景「選取群組」：標籤顯示群組的顯示名稱（此處
    // 選取停在頂層，groupPath 是 []，所以標籤沒有「A › B」路徑前綴，就是名稱本身）。
    await expect.poll(() => page.locator(".selection-label").textContent()).toBe("群組");

    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "group-selected", baselineDir });
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// --- NOOP-149 / #117: 群組編輯的虛線框視覺輔助 -----------------------------

/**
 * The `.group-frame` overlay's box pool (NOOP-149 r2): one dashed box per
 * level of `groupPath` currently in scope, outermost first. Only the
 * currently-visible (`display:block`) boxes are returned — a collapsed
 * inner level leaves its pooled element behind with `display:none`, which
 * would otherwise show up as a spurious zero-rect entry.
 */
async function groupFrameBoxes(
  page: Page,
): Promise<Array<{ display: string; left: number; top: number; width: number; height: number }>> {
  const frame = await canvasFrame(page);
  return frame.evaluate(() => {
    const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
    const els = [...host.shadowRoot!.querySelectorAll(".group-frame")] as HTMLElement[];
    return els
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          display: getComputedStyle(el).display,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
  });
}

/**
 * Three-level nested deck for the group-frame tests: a decorative untagged
 * `<rect>` gives `el-outer` a bounding box strictly larger than (and
 * offset from) `el-inner`'s own, so "the frame moved to the inner group"
 * is a real geometry assertion rather than two rects that happen to
 * coincide because the outer group has no content of its own.
 */
async function makeNestedGroupDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-outer" data-comot-name="外層群組">\n' +
      '    <rect x="450" y="200" width="380" height="320" fill="none" stroke="#ccc"/>\n' +
      '    <g id="el-inner" data-comot-name="內層群組" transform="translate(500 260)">\n' +
      '      <rect id="el-leaf" data-comot-name="葉節點" width="200" height="200" fill="#c66"/>\n' +
      "    </g>\n" +
      "  </g>\n" +
      // openApp waits for the first painted <text>; see makeDeckDir's other callers.
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="620" text-anchor="middle" font-size="32" fill="#9aa7b4">群組虛線框測試</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("選取群組時顯示虛線框", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);

    // Clicking the leaf resolves to the outermost id'd ancestor, el-outer
    // (the container rule already covered above) — selecting a group.
    await page.frameLocator("iframe.slide-frame").locator("#el-leaf").click();

    const boxes = await groupFrameBoxes(page);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].display).toBe("block");
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

it("巢狀逐層進入時虛線框逐層疊加：每進一層新增一個框，外層的框保留不動", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");

    // First dblclick enters el-outer (the outermost group at top level).
    // NOOP-149r3: the newly-entered scope's own selection is resolved by
    // the same outermost-within-scope rule a click/drag would use
    // (resolveClickTarget), so it lands on el-inner — the outermost
    // id-carrying element strictly inside el-outer — not directly on the
    // leaf under the pointer. This is what makes the highlighted selection
    // box match what a drag started right after this dblclick would
    // actually move (see the "拖曳作用對象與選取層級一致" test below).
    // el-inner being selected-but-not-yet-entered gets the same one-frame
    // preview a plain click on any group gets ("選取群組時顯示虛線框"
    // above), on top of el-outer's own entered-scope frame — 2 frames
    // already, not 1.
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 內層群組");
    // The click/dblclick sequence's own select messages each round-trip
    // through the host (which echoes group scope + handle flags back down
    // — see canvas.ts's pushSelectionToRuntime); give the last echo time to
    // land before reading geometry, so a still-in-flight echo cannot land
    // after a later assertion/action and silently revert local state.
    await page.waitForTimeout(50);
    const afterOuter = await groupFrameBoxes(page);
    expect(afterOuter).toHaveLength(2);
    const [outerFrame, innerPreviewFrame] = afterOuter;

    // Second dblclick, now scoped inside el-outer, formally enters el-inner
    // too (it is itself a group container, wrapping el-leaf) and resolves
    // the leaf as el-inner's own outermost-within-scope descendant. Both
    // frames were already showing (as el-outer's entered-scope frame and
    // el-inner's selected-but-not-entered preview) — entering el-inner for
    // real must not move or drop either one (NOOP-149 r2: a single-element
    // frame that moved to the innermost level made the outer group vanish).
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 葉節點");
    await page.waitForTimeout(50);
    const afterInner = await groupFrameBoxes(page);
    expect(afterInner).toHaveLength(2);
    const [outerAfterInner, innerFrame] = afterInner;

    // Both frames' rects are unchanged by entering the inner level.
    expect(outerAfterInner.left).toBeCloseTo(outerFrame.left, 0);
    expect(outerAfterInner.width).toBeCloseTo(outerFrame.width, 0);
    expect(innerFrame.left).toBeCloseTo(innerPreviewFrame.left, 0);
    expect(innerFrame.width).toBeCloseTo(innerPreviewFrame.width, 0);

    // The inner group's rect is strictly contained within the outer's, per
    // the deck's own construction (el-outer's decorative rect makes it larger).
    expect(innerFrame.left).not.toBe(outerFrame.left);
    expect(innerFrame.width).toBeLessThan(outerFrame.width);
    expect(innerFrame.height).toBeLessThan(outerFrame.height);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

it("Esc 逐層退出：每次只收掉最內層的框，其餘外層框保留至也被退出為止", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");

    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 內層群組");
    await page.waitForTimeout(50);
    const [outerFrame] = await groupFrameBoxes(page);

    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 葉節點");
    // See the previous test's comment: wait for the dblclick's own select
    // message to round-trip back through the host before pressing Escape,
    // so a late-arriving echo cannot re-apply the just-entered scope on
    // top of Escape's own (synchronous, local) pop.
    await page.waitForTimeout(50);
    expect(await groupFrameBoxes(page)).toHaveLength(2);

    // First Esc: back out of el-inner, into el-outer — the innermost frame
    // is removed and the outer frame's own rect is left untouched.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
    const afterFirstEsc = await groupFrameBoxes(page);
    expect(afterFirstEsc).toHaveLength(1);
    expect(afterFirstEsc[0].left).toBeCloseTo(outerFrame.left, 0);
    expect(afterFirstEsc[0].width).toBeCloseTo(outerFrame.width, 0);

    // Second Esc: back to the top level. The still-selected leaf is not a
    // group container, so every frame is gone.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
    expect(await groupFrameBoxes(page)).toHaveLength(0);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

/**
 * Two-child inner group for the drag/selection-consistency test below —
 * mirrors the human's PR #123 repro (三層巢狀 deck ⊃ 內層群組 ⊃ 藍色方塊／
 * 粉色方塊). `makeNestedGroupDeck`'s inner group wraps a single leaf, so
 * its own bounding box happens to coincide with that leaf's — useless for
 * telling "the solid box wraps the leaf" apart from "the solid box wraps
 * the whole group" geometrically. Two side-by-side children make the two
 * boxes visibly different sizes.
 */
// ADR-0012's normal form requires every group's children to themselves be
// `<g>` containers ("a group is a container of containers") and forbids an
// id/data-comot-name on a bare primitive — core's parseSlide (packages/core
// src/slide/format.ts's toElement) only recurses into a `<g>`'s children as
// real, independently addressable SlideElements when EVERY child is itself
// a `<g>`; otherwise the whole thing collapses into one opaque "compound"
// element and anything nested inside becomes unreachable by id for a
// server-side command (found the hard way: an earlier, non-compliant draft
// of this deck put id/name straight on the `<rect>`s and a stray
// id-less decorative `<rect>` next to el-inner, which silently made
// el-inner unindexable — the drag below produced zero commands and zero
// errors). el-blue/el-pink therefore get their own wrapping `<g>` each.
async function makeDragConsistencyDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-outer" data-comot-name="外層群組">\n' +
      '    <g id="el-inner" data-comot-name="內層群組" transform="translate(460 220)">\n' +
      '      <g id="el-blue" data-comot-name="藍色方塊">\n' +
      '        <rect width="150" height="150" fill="#69c"/>\n' +
      "      </g>\n" +
      '      <g id="el-pink" data-comot-name="粉色方塊" transform="translate(190 0)">\n' +
      '        <rect width="150" height="150" fill="#c9a"/>\n' +
      "      </g>\n" +
      "    </g>\n" +
      "  </g>\n" +
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="620" text-anchor="middle" font-size="32" fill="#9aa7b4">拖曳一致性測試</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

/** `translate(x y)` on `elementId`'s own `<g>` — mirrors e2e/direct-manipulation.test.ts's own `readTranslate`. */
function readTranslate(svg: string, elementId: string): { x: number; y: number } {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  if (!elementMatch) throw new Error(`找不到 ${elementId} 的 transform`);
  const translateMatch = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(elementMatch[1]);
  if (!translateMatch) throw new Error(`${elementId} 的 transform 沒有 translate：${elementMatch[1]}`);
  return { x: Number(translateMatch[1]), y: Number(translateMatch[2]) };
}

// NOOP-149r3: the human's second PR #123 repro — after entering a group,
// the solid selection box was drawn on a leaf while a drag actually moved
// its enclosing (un-entered) inner group. The two assertions below cover
// both halves of that mismatch directly, rather than trusting that
// "displayed" and "dragged" agree: first, that the box shown right after
// entering the group already spans the whole group (not just the child
// under the pointer); second, that dragging from that same point really
// does move the group as a rigid whole (both children shift, and neither
// child gained a transform of its own).
it("拖曳作用對象與選取層級一致：實線框標示的節點跟實際被拖動的節點是同一個", async () => {
  const deck = await makeDragConsistencyDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const selName = page.locator(".status-selection-chip");
    const pink = page.frameLocator("iframe.slide-frame").locator("#el-pink");

    // One dblclick enters el-outer; el-pink's outermost-within-scope
    // ancestor is el-inner (a group wrapping both el-blue and el-pink), so
    // the solid selection box must land on the whole group, not on
    // el-pink alone.
    await pink.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 內層群組");
    await page.waitForTimeout(50);

    // The iframe is sandboxed without allow-same-origin (see the sandbox
    // test above), so its contentDocument is unreachable from page-level
    // script — canvasFrame's CDP-based Frame.evaluate is the only way in,
    // same as groupFrameBoxes above.
    const frame = await canvasFrame(page);
    const selBox = await frame.evaluate(() => {
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
      const rect = host.shadowRoot!.querySelector(".sel")!.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const pinkBox = await pink.boundingBox();
    if (!pinkBox) throw new Error("量不到 el-pink 的邊界框");
    // el-inner's own box (blue + pink side by side) is roughly twice as
    // wide as el-pink alone — a box that had wrongly wrapped just the leaf
    // would be close to pinkBox.width, not ~2x it.
    expect(selBox.width).toBeGreaterThan(pinkBox.width * 1.5);

    const before = (
      await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })
    ).data!.content;
    const innerBefore = readTranslate(before, "el-inner");
    const pinkLocalBefore = readTranslate(before, "el-pink");

    // Alt disables snap-to-guide (direct-manipulation.test.ts's own
    // convention) — without it this drag's endpoint can land within
    // snapping distance of a guide and get pulled back to (effectively)
    // its start position, which is not what this test means to prove.
    const from = { x: pinkBox.x + pinkBox.width / 2, y: pinkBox.y + pinkBox.height / 2 };
    await page.keyboard.down("Alt");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 120, from.y + 90, { steps: 5 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(150);

    const after = (
      await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })
    ).data!.content;
    // el-blue never had a transform of its own and still doesn't; el-pink
    // keeps exactly its original local offset — neither child moved
    // independently, only el-inner did, as one rigid unit.
    expect(/<g id="el-blue"[^>]*transform=/.test(after)).toBe(false);
    expect(readTranslate(after, "el-pink")).toEqual(pinkLocalBefore);
    const innerAfter = readTranslate(after, "el-inner");
    expect(innerAfter.x).not.toBe(innerBefore.x);
    expect(innerAfter.y).not.toBe(innerBefore.y);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

it("基準截圖：群組編輯中的虛線框", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    await page.evaluate(() => document.fonts.ready);
    await page.frameLocator("iframe.slide-frame").locator("#el-leaf").dblclick();
    // Same settle-before-capture wait as the other baseline screenshot
    // above — geometry is read from getBoundingClientRect() at click time.
    await page.waitForTimeout(50);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "group-frame", baselineDir });
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// NOOP-91 round-2 FAIL #3: 驗收條件第二條「截圖比對：單選、多選、群組選取、
// 鑽入標籤、Arrange 選單、右鍵選單」六案，第 1 輪只交了前三案——這是第四案。
// 基準圖尚未產生（AGENTS.md「視覺回歸的把關分工」：本機只能比對, 不能產生
// 基準）；這條測試在基準產生前會因「找不到基準截圖」失敗，符合
// compareScreenshot 自己文件裡「先寫測試、CI 觸發 update_baselines 產生
// 基準」的流程。
it("基準截圖：鑽入群組後的標籤（Group 2 › Group 1 路徑）", async () => {
  const deck = await makeNestedGroupDeck();
  const { server, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");

    // Two dblclicks drills all the way to the leaf, same sequence as "巢狀
    // 逐層進入" above — label ends up "外層群組 › 內層群組 › 葉節點".
    await slideLeaf.dblclick();
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 葉節點");
    await expect.poll(() => page.locator(".selection-label").textContent()).toBe("外層群組 › 內層群組 › 葉節點");

    await page.waitForTimeout(50);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "drill-in-label", baselineDir });
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// --- [E2.T15]/#205: 成組／解組 (Dock 的 Group/Ungroup 按鈕) ----------------

/** How many effect items the slide currently has, straight off the server (independent of what the GUI has rendered). */
async function effectCount(registry: CommandRegistry, presentationId: string): Promise<number> {
  const result = await registry.dispatch<{ effects: unknown[] }>("effect list", { id: presentationId, slidePath: "slides/001.svg" });
  return result.ok ? result.data!.effects.length : -1;
}

// Two same-layer elements, both above the vertical midline — the "group-
// toast" screenshot below clips to the dock ∪ toast union, and needs
// whatever sits *behind* that strip (through the glass blur) to be the same
// blank space before and after the reload `element group` triggers (see
// that test's own comment for why).
async function makeGroupCommandDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-a" data-comot-name="矩形A">\n' +
      '    <rect x="200" y="80" width="160" height="120" fill="#c66"/>\n' +
      "  </g>\n" +
      '  <g id="el-b" data-comot-name="矩形B">\n' +
      '    <rect x="500" y="80" width="160" height="120" fill="#69c"/>\n' +
      "  </g>\n" +
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="260" text-anchor="middle" font-size="32" fill="#9aa7b4">成組測試</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("成組：Shift 選 2 個元素、按 Group，成員自身動畫被移除並顯示 toast", async () => {
  const deck = await makeGroupCommandDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    // el-a carries an animation of its own before grouping — [E2.T7]: a
    // member's individual animation does not carry over into the new group.
    const added = await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-a"],
      family: "enter", effect: "fade", start: "on-click", duration: 0.5, delay: 0,
    });
    expect(added.ok).toBe(true);
    expect(await effectCount(registry, presentationId)).toBe(1);

    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");
    const groupButton = page.locator('.dock-command[aria-label="Group"]');

    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");
    expect(await groupButton.isDisabled()).toBe(false);

    await groupButton.click();

    const toast = page.locator(".dock-toast");
    await expect.poll(() => toast.textContent()).toBe("Grouped 2 elements · their animations were removed");

    // D4.2：成組後選取變成新群組本身；D1：新群組得到自動命名 Group 1。
    // 移到截圖之前（F8, NOOP-289 期間發現）：dock 按鈕的 enabled/disabled
    // 狀態跟著「選取是否已還原」走，不是 toast 一出現就與 reload 進度脫鉤
    // ——這裡等的正是同一個 reload，只是等的方式從「不管它」換成「等它
    // 落地」，讓下面的截圖固定在 reload 之後那個狀態，不再跟 reload 賽跑
    // （原本「不等 reload 完成」的假設在這個成員上不成立，被較快的 reload
    // 時序放大成偶發 flaky）。
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: Group 1");
    expect(await effectCount(registry, presentationId)).toBe(0);

    // 基準截圖：toast（clip 到 dock ∪ toast 的聯集，四邊取整——見
    // Plan §6.4「group-toast 截圖的去 flaky 規則」）。
    await settleForScreenshot(page);
    const dockBox = await page.locator(".dock").boundingBox();
    const toastBox = await toast.boundingBox();
    if (!dockBox || !toastBox) throw new Error("量不到 .dock 或 .dock-toast 的邊界框");
    const x = Math.floor(Math.min(dockBox.x, toastBox.x));
    const y = Math.floor(Math.min(dockBox.y, toastBox.y));
    const right = Math.ceil(Math.max(dockBox.x + dockBox.width, toastBox.x + toastBox.width));
    const bottom = Math.ceil(Math.max(dockBox.y + dockBox.height, toastBox.y + toastBox.height));
    await compareScreenshot(page, { name: "group-toast", baselineDir, clip: { x, y, width: right - x, height: bottom - y } });

    const svg = (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content;
    const groupMatch = /<g id="(el-[^"]+)" data-comot-name="Group 1">/.exec(svg);
    if (!groupMatch) throw new Error("找不到新群組的 <g data-comot-name=\"Group 1\">");
    expect(svg.indexOf('id="el-a"')).toBeGreaterThan(groupMatch.index);
    expect(svg.indexOf('id="el-b"')).toBeGreaterThan(groupMatch.index);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// A pre-existing group (el-group ⊃ el-child) sitting next to a lone element
// (el-extra), both direct children of <svg> — selecting "one existing group
// + one element" and grouping them is the 巢狀 scenario (05-INTERACTIONS
// .feature「群組（含巢狀）」).
async function makeNestingCommandDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-group" data-comot-name="子群組">\n' +
      '    <g id="el-child" data-comot-name="子項">\n' +
      '      <rect x="150" y="80" width="120" height="100" fill="#c66"/>\n' +
      "    </g>\n" +
      "  </g>\n" +
      '  <g id="el-extra" data-comot-name="額外元素">\n' +
      '    <rect x="450" y="80" width="120" height="100" fill="#69c"/>\n' +
      "  </g>\n" +
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="300" text-anchor="middle" font-size="32" fill="#9aa7b4">巢狀成組測試</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("巢狀：選「一個既有群組 ＋ 一個元素」按 Group，外層再包一層，既有群組原封不動", async () => {
  const deck = await makeNestingCommandDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");
    const groupButton = page.locator('.dock-command[aria-label="Group"]');

    // Clicking el-child resolves to its outermost id-carrying ancestor,
    // el-group — selecting the whole pre-existing group.
    await slideFrame.locator("#el-child").click();
    await slideFrame.locator("#el-extra").click({ modifiers: ["Shift"] });
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 2 elements");
    expect(await groupButton.getAttribute("aria-label")).toBe("Group");
    expect(await groupButton.isDisabled()).toBe(false);

    await groupButton.click();
    await expect.poll(() => page.locator(".dock-toast").textContent()).toBe("Grouped 2 elements");

    const svg = (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content;
    // The pre-existing group and its own child are untouched; a new outer
    // group wraps el-group (as a whole) and el-extra.
    expect(svg).toContain('id="el-group"');
    expect(svg).toContain('id="el-child"');
    const outerMatch = /<g id="(el-[^"]+)" data-comot-name="Group 1">/.exec(svg);
    if (!outerMatch) throw new Error("找不到新的外層群組");
    expect(svg.indexOf('id="el-group"')).toBeGreaterThan(outerMatch.index);
    expect(svg.indexOf('id="el-extra"')).toBeGreaterThan(outerMatch.index);
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});

// `makeNestedGroupDeck`（group-frame 系列測試用）刻意在 el-outer 底下混了一
// 個沒有 id 的裝飾用 <rect>——ADR-0012 合規規則要求容器的子節點「全部是
// <g>，或全部是圖元」，這個 fixture 只在 selection-runtime 的畫面層合法，
// 送進 `element group/ungroup`（走 assertSlideCompliant）會直接 403：「容器
// 同時含有圖元與子容器」。這裡另外做一份三層都合規的巢狀 deck。
async function makeCompliantNestedDeck(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  return makeDeckDir(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <g id="el-outer" data-comot-name="外層群組">\n' +
      '    <g id="el-inner" data-comot-name="內層群組" transform="translate(500 60)">\n' +
      '      <g id="el-leaf" data-comot-name="葉節點">\n' +
      '        <rect width="200" height="200" fill="#c66"/>\n' +
      "      </g>\n" +
      "    </g>\n" +
      "  </g>\n" +
      '  <g id="el-caption" data-comot-name="說明">\n' +
      '    <text x="640" y="600" text-anchor="middle" font-size="32" fill="#9aa7b4">解組測試</text>\n' +
      "  </g>\n" +
      "</svg>\n",
  );
}

it("解組：整組選取後按 Ungroup，只解目前這一層——內層群組與其動畫皆保留在外的那一層被移除", async () => {
  const deck = await makeCompliantNestedDeck();
  const { server, registry, presentationId, cleanup } = await startServerFor(deck.dir);
  try {
    // el-outer (the level about to be dissolved) carries its own animation.
    const added = await registry.dispatch("effect add", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: ["el-outer"],
      family: "enter", effect: "fade", start: "on-click", duration: 0.5, delay: 0,
    });
    expect(added.ok).toBe(true);

    const page = await openApp(server);
    const slideLeaf = page.frameLocator("iframe.slide-frame").locator("#el-leaf");
    const selName = page.locator(".status-selection-chip");
    const groupButton = page.locator('.dock-command[aria-label="Ungroup"]');

    // Not yet drilled into anything: clicking the leaf resolves to the
    // outermost group at top scope, el-outer.
    await slideLeaf.click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 外層群組");
    expect(await groupButton.getAttribute("aria-label")).toBe("Ungroup");
    expect(await groupButton.isDisabled()).toBe(false);

    await groupButton.click();
    await expect.poll(() => page.locator(".dock-toast").textContent()).toBe("Ungrouped · the group animation was removed");

    // D4.2：解組後選取變成被解散群組的直接子節點——el-outer 唯一的直接
    // 子節點是 el-inner。
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 內層群組");
    expect(await effectCount(registry, presentationId)).toBe(0);

    const svg = (await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" })).data!.content;
    expect(svg).not.toContain('id="el-outer"');
    // 只解目前這一層：內層群組（及其葉節點）原封不動保留。
    expect(svg).toContain('id="el-inner"');
    expect(svg).toContain('id="el-leaf"');
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});
