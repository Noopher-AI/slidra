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
 * Multi-slide paging end to end (issue #25). The deck under test is the
 * hand-written fixture in `fixtures/player-deck/`: three visibly different
 * 投影片, one of which references an asset by relative path. Everything is
 * real — a real `.comot` packed from that directory, the real `open`
 * command, a real server, the real built bundle, a real Chromium. The
 * agent is the same fake ACP subprocess the smoke test uses; nothing here
 * talks to it.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/player-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let server: RunningServer;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-player-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-player-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  registry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "player-deck.comot");
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

  server = await startServe({ registry, presentationId, port: 0, agent });
});

afterAll(async () => {
  // Browser first, then server. An open page holds a live `/api/events`
  // SSE connection, and `server.close()` waits for in-flight requests to
  // finish — with a page still attached that wait never ends.
  await browser?.close();
  await server?.close();
  delete process.env.CO_MOTION_HOME;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

it("作者可以在瀏覽器裡往後翻、往前翻，兩端到底就停住", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  const currentSlideText = async (): Promise<string | null> => {
    if (pageErrors.length > 0) return `頁面錯誤：${pageErrors.join("; ")}`;
    return slideText.textContent().catch(() => null);
  };
  const nextButton = page.locator('.slide-nav-button[aria-label="下一頁"]');
  const previousButton = page.locator('.slide-nav-button[aria-label="上一頁"]');
  const position = page.locator(".slide-nav-position");

  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");
  await expect.poll(() => position.textContent(), { timeout: 30_000 }).toBe("1 / 3");
  // 第一頁再往前不動：the control is there, and it refuses.
  await expect.poll(() => previousButton.isDisabled()).toBe(true);

  await nextButton.click();
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第二頁");
  await expect.poll(() => position.textContent()).toBe("2 / 3");

  await nextButton.click();
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第三頁");
  await expect.poll(() => position.textContent()).toBe("3 / 3");

  // 第三頁再往後不動，也不當機。
  await expect.poll(() => nextButton.isDisabled()).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第三頁");

  await page.keyboard.press("ArrowLeft");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第二頁");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

  expect(pageErrors).toEqual([]);
});

it("第二頁的相對路徑圖片真的載入了", async () => {
  const page = await browser.newPage();
  const rawResponses: { url: string; status: number; contentType: string | undefined }[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/raw/")) return;
    rawResponses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"],
    });
  });

  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).toBe("第一頁");

  await page.locator('.slide-nav-button[aria-label="下一頁"]').click();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).toBe("第二頁");

  // A missing image leaves the <image> element in the DOM exactly as a
  // loaded one does, so the element's presence proves nothing. Two
  // independent checks that it really arrived: the bytes came back 200 as
  // a PNG, and the browser painted it with a non-zero box.
  await expect
    .poll(() => rawResponses.filter((r) => r.url.endsWith("/assets/photo.png")), { timeout: 30_000 })
    .toHaveLength(1);
  const photoResponse = rawResponses.find((r) => r.url.endsWith("/assets/photo.png"))!;
  expect(photoResponse.status).toBe(200);
  expect(photoResponse.contentType).toContain("image/png");

  const image = page.frameLocator("iframe.slide-frame").locator("svg image");
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
