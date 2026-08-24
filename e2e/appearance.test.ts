import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot } from "./helpers/screenshot.js";

/**
 * Visual regression baseline for ticket #49 — the app now wears the
 * base-shell (docs/design/base-shell.html) token set and a bundled font
 * subset instead of 338 lines of hand-tuned values, and this is the first
 * screenshot test that holds it in place. Later tickets (#50 stage, #54
 * play, #55 grid, #56 selection) add their own baselines through the same
 * e2e/helpers/screenshot.ts helper — this file only needs to prove the
 * machinery itself works end to end against the real built app.
 *
 * Same posture as e2e/smoke.test.ts and e2e/demo-deck.test.ts: a real
 * `startServe`, the real built `packages/web/dist` bundle, a real
 * Chromium (Playwright's own bundled build, never a system/channel
 * browser — required so the byte-exact baselines stay reproducible), and
 * the repo's real `demo/` presentation. Only the ACP agent is a fake
 * subprocess.
 *
 * Viewport is hard-coded to 1440×900 — the same fixed frame size
 * docs/design/base-shell.html's own static template uses ("樣板永遠以
 * 1440×900 的視窗呈現").
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/appearance");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let server: RunningServer;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  // Playwright's own bundled Chromium — never a system/channel browser
  // (`channel` option left unset), matching the ticket's constraint that
  // the byte-exact baselines only need to hold on one specific browser
  // build.
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-appearance-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-appearance-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  registry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "demo.comot");
  await packDirectory(demoDir, comotPath);
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

  server = await startServe({ registry, presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.CO_MOTION_HOME;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

/** Loads the app and waits for the first slide to actually be painted before returning the page. */
async function openApp(): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

  // The bundled Noto Sans TC subset must have finished loading before any
  // screenshot — otherwise the baseline would depend on exactly when the
  // font swap lands mid-run, defeating byte-exact comparison. `tokens.css`
  // already sets `font-display: block` for the same reason; this is the
  // explicit, awaited confirmation of it.
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

it("標準檢視：整個 app 的外觀符合基準截圖", async () => {
  const page = await openApp();
  await compareScreenshot(page, { name: "standard-view", baselineDir });
  await page.close();
});

// A second, differently-shaped baseline in the same file — proves the
// helper's `name` + `clip` combination genuinely supports more than one
// baseline per test file, which the later per-view tickets depend on.
it("縮圖軌：目前投影片的選取框（重點色）符合基準截圖", async () => {
  const page = await openApp();
  const currentThumb = page.locator(".overview-item-current .overview-thumb");
  const box = await currentThumb.boundingBox();
  if (!box) throw new Error("找不到目前投影片的縮圖 — .overview-item-current 沒有渲染出來");
  await compareScreenshot(page, {
    name: "overview-current-thumb",
    baselineDir,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  await page.close();
});

it("字體：UI 實際套用的是打包的 Noto Sans TC，不是 system-ui 落地字型", async () => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".woff2")) fontRequests.push(request.url());
  });

  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(() => document.fonts.ready);

  // The computed font-family of a real, currently-rendered UI element —
  // not the CSS source text, which would pass even if the @font-face
  // failed to load and the browser silently fell through to the next
  // family in the stack.
  const computedFontFamily = await page.locator(".status-bar").evaluate((el) => getComputedStyle(el).fontFamily);
  expect(computedFontFamily).toContain("Noto Sans TC");

  // document.fonts itself must contain a loaded "Noto Sans TC" face — this
  // is what actually distinguishes "the family resolved to our face" from
  // "the family name merely matches and the browser silently substituted
  // a system font with the same display name".
  const loadedFamilies = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
  expect(loadedFamilies).toContain("Noto Sans TC");

  // The woff2 must come from the app's own origin, never fonts.gstatic.com
  // — runtime loading from Google Fonts is forbidden (breaks offline use,
  // makes screenshots depend on network availability).
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) {
    expect(new URL(url).origin).toBe(new URL(server.url).origin);
  }

  await page.close();
});
