import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * T6 (NOOP-145/200): the「切換」tab's two buttons, end to end, driven
 * entirely through the UI (never `registry.dispatch` directly — that would
 * bypass the wiring this ticket exists to add). Covers the plan's AC3–AC5:
 * `fade` actually fades a forward page change, `none` is instant, and
 * retreat is instant even with `fade` set (`player-runtime.js`'s existing
 * "retreat is instant" principle, mirrored one layer up in canvas.ts).
 *
 * Fixture: `e2e/fixtures/play-deck/` — 2 slides, no `transition` field, so
 * "no value yet" is exercised for free before either button is ever clicked.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/play-deck");
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

async function startServerForPlayDeck(): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-transitions-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-transitions-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckFixtureDir, comotPath);
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
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

/** Loads the app and waits for the first slide + the SSE chat stream to be up (mirrors shell.test.ts's openApp). */
async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await expect
    .poll(() => page.locator(".agent-dot").textContent().catch(() => null), { timeout: 30_000 })
    .toContain("已連線");
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * Sets the presentation-level transition via the「切換」tab's UI, and waits
 * for the resulting live-reload round trip to actually land — the button
 * click only fires `POST /api/command`; the canvas module only picks the
 * new value up once the server's `presentation-changed` push drives its own
 * `reload()`, which is the `GET /api/presentation` this waits for. Without
 * this wait, entering play mode immediately after the click can still see
 * the *previous* transition value (the exact race the plan's §4.4 calls out).
 */
async function setTransitionViaUi(page: Page, label: "無" | "淡入淡出"): Promise<void> {
  await page.locator('.tab:has-text("切換")').click();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/presentation") && response.status() === 200),
    page.locator(`.cmd:has-text("${label}")`).click(),
  ]);
}

/** Enters play mode from the「投影片放映」tab, the same click path #51's own play-mode test uses. */
async function enterPlay(page: Page): Promise<void> {
  await page.locator('.tab:has-text("投影片放映")').click();
  await page.locator('.cmd:has-text("從頭播放")').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
}

/**
 * Kicks off (without awaiting) an 800ms sampling window on `.slide-frame`'s
 * computed opacity — twice `PAGE_FADE_MS`, canvas.ts's own fade duration —
 * and resolves the minimum value seen. Deliberately not awaited by this
 * function itself: the caller must start sampling, THEN trigger the page
 * change, and only await the result afterwards, or the sampling window
 * would already be over before the transition even starts (plan §6.3). A
 * single-point read of a CSS transition is inherently flaky; the window's
 * floor is not.
 */
function sampleMinOpacity(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const frame = document.querySelector(".slide-frame") as HTMLElement;
        let min = 1;
        const t0 = performance.now();
        const tick = () => {
          min = Math.min(min, parseFloat(getComputedStyle(frame).opacity));
          if (performance.now() - t0 < 800) requestAnimationFrame(tick);
          else resolve(min);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * Waits until a page change's fade has fully, visually settled at opacity 1
 * before the caller starts the NEXT page change (AC5 needs slide 2's own
 * forward fade completely out of the way before retreating, or its tail can
 * bleed into the retreat's own sampling window).
 *
 * Polling *computed* opacity for `"1"` is not enough proof by itself:
 * `"1"` is also `.slide-frame`'s un-animated resting value, so a poll that
 * only checks the computed style cannot tell "the fade has not started yet
 * because renderPlay()'s fetch, or this environment's requestAnimationFrame
 * scheduling, is still lagging" apart from "the fade genuinely finished" —
 * both read back as computed `"1"`. Polling the *inline* `style.opacity`
 * instead is unambiguous: canvas.ts's animate path only ever writes an
 * inline `"1"` from the fade's second (post-rAF) phase, so seeing it there
 * proves that phase actually ran. From that confirmed point, waiting one
 * more full `PAGE_FADE_MS` (with margin) covers the CSS transition's own
 * remaining visual playback before the frame is truly at rest.
 */
async function waitForFadeToSettle(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator(".slide-frame").evaluate((el) => (el as HTMLElement).style.opacity), {
      timeout: 30_000,
    })
    .toBe("1");
  await page.waitForTimeout(800);
}

it("AC3：設定「淡入淡出」後前進換頁，.slide-frame 的 opacity 在動畫窗內確實低於 1", async () => {
  const { server, cleanup } = await startServerForPlayDeck();
  try {
    const page = await openApp(server);
    await setTransitionViaUi(page, "淡入淡出");
    await enterPlay(page);

    const sampling = sampleMinOpacity(page);
    await page.locator('.play-nav-button[aria-label="下一步"]').click();
    const min = await sampling;

    expect(min).toBeLessThan(0.9);
  } finally {
    await cleanup();
  }
});

it("AC4：設定「無」後前進換頁瞬切，.slide-frame 的 opacity 全程維持 1", async () => {
  const { server, cleanup } = await startServerForPlayDeck();
  try {
    const page = await openApp(server);
    await setTransitionViaUi(page, "無");
    await enterPlay(page);

    const sampling = sampleMinOpacity(page);
    await page.locator('.play-nav-button[aria-label="下一步"]').click();
    const min = await sampling;

    expect(min).toBe(1);
  } finally {
    await cleanup();
  }
});

it("AC5：設定「淡入淡出」後倒退換頁一律瞬切，.slide-frame 的 opacity 全程維持 1（retreat is instant）", async () => {
  const { server, cleanup } = await startServerForPlayDeck();
  try {
    const page = await openApp(server);
    await setTransitionViaUi(page, "淡入淡出");
    await enterPlay(page);

    // Move to slide 2 first and let its fade-in fully settle, so the
    // retreat below starts from a clean, non-animating state, not from
    // the tail of the forward fade this step itself triggers.
    await page.locator('.play-nav-button[aria-label="下一步"]').click();
    await waitForFadeToSettle(page);

    const sampling = sampleMinOpacity(page);
    await page.locator('.play-nav-button[aria-label="上一步"]').click();
    const min = await sampling;

    expect(min).toBe(1);
  } finally {
    await cleanup();
  }
});
