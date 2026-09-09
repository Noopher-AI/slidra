import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Gate review round 2, P2: a legal slide element can carry its own inline
 * `style="opacity:1"`. Inline style normally wins the CSS cascade over any
 * injected stylesheet rule, regardless of that rule's specificity — without
 * `!important` on both the hide stylesheet (player-plan.ts) and the
 * runtime's own reveal (player-runtime.js), such an element flashes fully
 * visible at the very start of play, defeating "進入播放時不會閃過完整內
 * 容". This is a real-browser cascade question, not something jsdom can
 * answer reliably, so it is tested here end to end rather than only at the
 * unit level.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/co-motion");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/inline-opacity-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let coMotionHome: string;
let comotDir: string;
let server: RunningServer;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-inlineop-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-inlineop-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  // [E4.T9]/F7: co-motion serve now spawns the Rust binary for every read/write.
  process.env.CO_MOTION_BIN = coMotionBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "inline-opacity-deck.comot");
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

  server = await startServe({ presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.CO_MOTION_HOME;
  delete process.env.CO_MOTION_BIN;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

it('元素自帶 inline style="opacity:1" 時，進場前仍被藏起來，推進後仍看得到', async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const stubborn = page.frameLocator("iframe.slide-frame").locator("#el-stubborn");
  await expect.poll(() => stubborn.textContent().catch(() => null), { timeout: 30_000 }).toBe("固執的文字");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  const opacityOf = () => stubborn.evaluate((el) => getComputedStyle(el).opacity);

  // The element's own inline style says opacity:1. If the injected hide
  // rule loses the cascade to it, this would read "1" instead of "0" —
  // the exact flash-of-full-content bug this test exists to catch.
  await expect.poll(opacityOf, { timeout: 10_000 }).toBe("0");

  await page.keyboard.press("ArrowRight");
  await expect.poll(opacityOf, { timeout: 10_000 }).toBe("1");
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
