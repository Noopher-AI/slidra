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
import { compareScreenshot } from "./helpers/screenshot.js";

/**
 * 元素選取 (#56, ADR-0011): clicking an element on the canvas in view mode
 * selects it, draws a four-corner box over it in a Shadow DOM, and shows
 * its 顯示名稱 (or 識別碼 fallback) in the status bar. Modeled on
 * e2e/grid-view.test.ts's startServerFor shape and e2e/player-hostile.test.ts's
 * hostile-fixture posture.
 *
 * Every click below uses a real Playwright locator click (dispatches a
 * trusted mouse event) or `page.mouse.click()` at a measured coordinate —
 * never `element.click()` inside page script — because wave 4's grid unit
 * found a real gap here: DOM `.click()` passes even when a missing
 * `pointer-events: none` would swallow a genuine mouse event.
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
    const selName = page.locator(".status .sel-name");

    await slideFrame.locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：標題");

    await slideFrame.locator("#el-plain").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：el-plain");
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
    const selName = page.locator(".status .sel-name");

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

it("選取不會啟用任何 disabled 的功能區按鈕", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const disabledCountBefore = await page.locator("button[disabled]").count();

    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const disabledCountAfter = await page.locator("button[disabled]").count();
    expect(disabledCountAfter).toBe(disabledCountBefore);
  } finally {
    await cleanup();
  }
});

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

    await expect.poll(() => pageIndicator.textContent()).toBe("第 1 頁，共 4 頁");
    await page.locator('button[aria-label="下一頁"]').click();
    await expect.poll(() => pageIndicator.textContent()).toBe("第 2 頁，共 4 頁");

    const sandbox = await slideFrame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");

    // Slide 2's script fires its forged message 300ms after load; give it
    // comfortably longer than that before asserting nothing moved.
    await page.waitForTimeout(600);

    await expect.poll(() => pageIndicator.textContent()).toBe("第 2 頁，共 4 頁");
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
      await page.locator('button[aria-label="下一頁"]').click();
    }
    await expect.poll(() => pageIndicator.textContent()).toBe("第 4 頁，共 4 頁");

    const selName = page.locator(".status .sel-name");
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：標題");

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

    await page.locator('.cmd:has-text("從頭播放")').click();
    // Shell collapsing (titlebar unmounts) is direct evidence play mode
    // took effect — same signal e2e/shell.test.ts polls after this same
    // click, chosen over the sandbox attribute because both modes now
    // carry allow-scripts (ADR-0011).
    await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

    await page.locator('button:has-text("離開播放")').click();
    // Symmetric wait for the round trip back to view mode: the titlebar
    // (and with it the ribbon's 從頭播放 command) reappears.
    await expect.poll(() => page.locator(".titlebar").count()).toBe(1);

    const selName = page.locator(".status .sel-name");
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：標題");

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
    const selName = page.locator(".status .sel-name");

    const svgRoot = slideFrame.locator("svg").first();
    const box = await svgRoot.boundingBox();
    if (!box) throw new Error("量不到 svg 的邊界框");
    await page.mouse.click(box.x + 4, box.y + 4);

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toMatch(/^已選取：el-.+$/);
    // Not one of the two named elements — it really is the background.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).not.toBe("已選取：標題");
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
    const selName = page.locator(".status .sel-name");

    // Click the child's own `<rect>`. The nearest id-carrying ancestor is
    // el-child-left; the outermost is el-group, and el-group is the answer.
    await page.frameLocator("iframe.slide-frame").locator("#el-child-left rect").click();

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：群組");
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
    const selName = page.locator(".status .sel-name");

    // First dblclick enters el-outer (the outermost group at top level) and
    // lands directly on the leaf actually under the pointer.
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：葉節點");
    // The click/dblclick sequence's own select messages each round-trip
    // through the host (which echoes group scope + handle flags back down
    // — see canvas.ts's pushSelectionToRuntime); give the last echo time to
    // land before reading geometry, so a still-in-flight echo cannot land
    // after a later assertion/action and silently revert local state.
    await page.waitForTimeout(50);
    const afterOuter = await groupFrameBoxes(page);
    expect(afterOuter).toHaveLength(1);
    const outerFrame = afterOuter[0];

    // Second dblclick, now scoped inside el-outer, resolves the leaf's
    // outermost-within-scope ancestor (el-inner) and enters it too — the
    // outer frame must still be there, with a second (inner) frame added
    // on top of it, not replacing it (NOOP-149 r2: a single-element frame
    // that moved to the innermost level made the outer group vanish).
    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：葉節點");
    await page.waitForTimeout(50);
    const afterInner = await groupFrameBoxes(page);
    expect(afterInner).toHaveLength(2);
    const [outerAfterInner, innerFrame] = afterInner;

    // The outer frame's own rect is unchanged by entering the inner level.
    expect(outerAfterInner.left).toBeCloseTo(outerFrame.left, 0);
    expect(outerAfterInner.width).toBeCloseTo(outerFrame.width, 0);

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
    const selName = page.locator(".status .sel-name");

    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：葉節點");
    await page.waitForTimeout(50);
    const [outerFrame] = await groupFrameBoxes(page);

    await slideLeaf.dblclick();
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：葉節點");
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
    await compareScreenshot(page, { name: "group-frame", baselineDir });
  } finally {
    await cleanup();
    await deck.cleanup();
  }
});
