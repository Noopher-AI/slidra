import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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
 * NOOP-141's 「常用」分頁 7 顆按鈕，driven end-to-end through real Chromium —
 * modelled on e2e/direct-manipulation.test.ts's startServerFor/openApp/
 * canvasFrame shape. Reuses that same fixture
 * (`e2e/fixtures/direct-manipulation-deck`, injecting the real embedded
 * font the same way) because it already has more than one selectable
 * element (needed for 排列/剪下/複製) and no `templates` field (needed for
 * the「新增投影片」empty-templates acceptance item).
 *
 * Every assertion reads the presentation file directly through the same
 * in-process `registry` the server dispatches through (`cat`), never the
 * DOM — the acceptance criteria are about the file system, not about CSS
 * classes (see `## 6. 驗證方式` in the plan this ticket implements).
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

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ribbon-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ribbon-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ribbon-deck-"));
  process.env.CO_MOTION_HOME = coMotionHome;

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
  await page.locator('.tab:has-text("常用")').click();
  return page;
}

async function readSlide(registry: CommandRegistry, presentationId: string, slidePath = "slides/001.svg"): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: slidePath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

async function readProject(registry: CommandRegistry, presentationId: string): Promise<{ slides: string[]; templates?: string[] }> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "project.json" });
  if (!result.ok) throw new Error(result.message);
  return JSON.parse(result.data!.content);
}

/** `translate(x y)` -> `{x, y}`. Throws if the element carries no such transform. */
function readTranslate(svg: string, elementId: string): { x: number; y: number } {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  if (!elementMatch) throw new Error(`找不到 ${elementId} 的 transform`);
  const translateMatch = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(elementMatch[1]);
  if (!translateMatch) throw new Error(`${elementId} 的 transform 沒有 translate：${elementMatch[1]}`);
  return { x: Number(translateMatch[1]), y: Number(translateMatch[2]) };
}

it("新增投影片：範本選單只有「空白」（fixture 未宣告 templates），選它讓 slides 長度 +1 且新 SVG 存在", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readProject(registry, presentationId);
    expect(before.slides.length).toBe(1);

    await page.locator('.cmd:has-text("新增投影片")').click();
    const menuItems = page.locator(".ribbon-menu [role=\"menuitem\"]");
    await expect.poll(() => menuItems.count()).toBe(1);
    expect(await menuItems.first().textContent()).toBe("空白");

    await menuItems.first().click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length).toBe(2);
    const after = await readProject(registry, presentationId);
    const newSlidePath = after.slides[1];
    // Throws if the new slide's file does not actually exist.
    await readSlide(registry, presentationId, newSlidePath);
    // The menu closes itself after a selection.
    expect(await page.locator(".ribbon-menu").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("複製 + 貼上：複製不改檔案，貼上讓目標頁多出一個 <g>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();

    const beforeCopy = await readSlide(registry, presentationId);
    await page.locator('.cmd:has-text("複製")').click();
    // Copy never mutates the presentation — give the (nonexistent) write a
    // moment to prove it really isn't happening, then check.
    await page.waitForTimeout(150);
    expect(await readSlide(registry, presentationId)).toBe(beforeCopy);

    await page.locator('.cmd:has-text("貼上")').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<g /g)?.length ?? 0).toBe(
      (beforeCopy.match(/<g /g)?.length ?? 0) + 1,
    );
  } finally {
    await cleanup();
  }
});

it("剪下：該頁少一個 <g>，選取的元素從 SVG 消失", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-b").click();

    const before = await readSlide(registry, presentationId);
    const beforeCount = before.match(/<g /g)?.length ?? 0;

    await page.locator('.cmd:has-text("剪下")').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<g /g)?.length ?? 0).toBe(
      beforeCount - 1,
    );
    expect(await readSlide(registry, presentationId)).not.toContain('id="el-b"');
  } finally {
    await cleanup();
  }
});

it("文字方塊：該頁多出一個含 <text> 的 <g>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const beforeCount = before.match(/<g /g)?.length ?? 0;

    await page.locator('.cmd:has-text("文字方塊")').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<g /g)?.length ?? 0).toBe(
      beforeCount + 1,
    );
    const after = await readSlide(registry, presentationId);
    expect(after).toContain("文字方塊");
    expect(after).toContain("<text");
  } finally {
    await cleanup();
  }
});

it("圖案：選單出現，選「矩形」後該頁多出一個含 <rect> 的 <g>", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readSlide(registry, presentationId);
    const beforeRectCount = before.match(/<rect/g)?.length ?? 0;

    await page.locator('.cmd:has-text("圖案")').click();
    const menuItems = page.locator(".ribbon-menu [role=\"menuitem\"]");
    await expect.poll(() => menuItems.count()).toBe(3);
    expect(await menuItems.allTextContents()).toEqual(["矩形", "橢圓", "線"]);

    await page.locator('.ribbon-menu [role="menuitem"]:has-text("矩形")').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<rect/g)?.length ?? 0).toBe(
      beforeRectCount + 1,
    );
    expect(await page.locator(".ribbon-menu").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("排列：選兩個元素，選單出現，選「靠左對齊」後兩者 translate 的 x 相同", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });

    await page.locator('.cmd:has-text("排列")').click();
    const menuItems = page.locator(".ribbon-menu [role=\"menuitem\"]");
    await expect.poll(() => menuItems.count()).toBe(12);

    await page.locator('.ribbon-menu [role="menuitem"]:has-text("靠左對齊")').click();
    await expect.poll(async () => {
      const svg = await readSlide(registry, presentationId);
      return readTranslate(svg, "el-a").x === readTranslate(svg, "el-b").x;
    }).toBe(true);
  } finally {
    await cleanup();
  }
});

it("未選取任何元素點「複製」/「剪下」：canvasState.error 以 role=alert 顯示", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const alert = page.locator(".canvas-error-banner[role='alert']");

    await page.locator('.cmd:has-text("複製")').click();
    await expect.poll(() => alert.textContent()).toBe("元素清單不可為空");

    // 沒有選取，剪下走同一條驗證路徑，訊息不變 — 只確認 banner 仍在。
    await page.locator('.cmd:has-text("剪下")').click();
    await expect.poll(() => alert.textContent()).toBe("元素清單不可為空");
  } finally {
    await cleanup();
  }
});

it("剪貼簿是空的時候點「貼上」：canvasState.error 以 role=alert 顯示，接著一次成功命令會清掉它", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const alert = page.locator(".canvas-error-banner[role='alert']");

    await page.locator('.cmd:has-text("貼上")').click();
    await expect.poll(() => alert.textContent()).toBe("剪貼簿是空的");

    // 接著一次成功命令（新增文字方塊，不需要選取）應清掉舊的錯誤訊息。
    await page.locator('.cmd:has-text("文字方塊")').click();
    await expect.poll(() => alert.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("A1 維持綠：常用分頁 7 顆按鈕全部接線後，disabled 數量仍是 0", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    expect(await page.locator(".groups .cmd[disabled]").count()).toBe(0);
  } finally {
    await cleanup();
  }
});
