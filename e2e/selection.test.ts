import { access, mkdtemp, rm } from "node:fs/promises";
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
      // The shadow host is whatever selection-runtime.js appended to
      // <body> — the last child, appended after the fetched slide markup.
      const host = document.body.lastElementChild as HTMLElement;
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

it("點空白處取消選取，狀態列的選取顯示區清空", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status .sel-name");

    await slideFrame.locator("#el-title").click();
    // The postMessage round trip from selection-runtime.js to React state
    // is asynchronous — poll rather than reading immediately after click.
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).not.toBe("");

    // A point on the slide with no id-carrying ancestor: the demo's first
    // slide is 1280×720 and el-title/el-subtitle sit around y=330/420 —
    // a corner of the stage is well clear of both.
    const svgRoot = slideFrame.locator("svg").first();
    const box = await svgRoot.boundingBox();
    if (!box) throw new Error("量不到 svg 的邊界框");
    await page.mouse.click(box.x + 4, box.y + 4);

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("");

    const frame = await canvasFrame(page);
    const boxDisplay = await frame.evaluate(() => {
      const host = document.body.lastElementChild as HTMLElement;
      const sel = host.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay).toBe("none");
  } finally {
    await cleanup();
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
      const host = document.body.lastElementChild as HTMLElement;
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

    await expect.poll(() => pageIndicator.textContent()).toBe("第 1 頁，共 3 頁");
    await page.locator('button[aria-label="下一頁"]').click();
    await expect.poll(() => pageIndicator.textContent()).toBe("第 2 頁，共 3 頁");

    const sandbox = await slideFrame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");

    // Slide 2's script fires its forged message 300ms after load; give it
    // comfortably longer than that before asserting nothing moved.
    await page.waitForTimeout(600);

    await expect.poll(() => pageIndicator.textContent()).toBe("第 2 頁，共 3 頁");
    const srcdoc = await slideFrame.getAttribute("srcdoc");
    expect(srcdoc).not.toBeNull();
    expect(srcdoc).not.toContain("__COMOT_PLAN__");
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
