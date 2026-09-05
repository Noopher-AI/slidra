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
 * [E2.T3] `05-INTERACTIONS.feature`「頁面管理」的 New／Templates 與拖曳排
 * 序場景（#208 的驗收硬性下限），加上 T3 plan §0 的根因迴歸守門測試（E）
 * ——`slide notes set` 曾經寫出未繫結 `comot:` 前綴的 `<comot:notes>`，讓
 * 那一頁的播放模式解析失敗；這個檔案的 "root cause" 測試就是防止它再發
 * 生的迴歸測試。
 *
 * 拖曳排序（B）不用 Playwright 的滑鼠事件合成原生 HTML5 拖放——Chromium
 * 的原生 DnD 依賴作業系統層級的拖放協調，在無頭環境下用滑鼠事件序列
 * 觸發並不可靠。改用 `page.evaluate` 直接對真實 DOM 節點派送
 * `DragEvent`（`dragstart`/`dragover`/`drop`/`dragend`，帶一個真的
 * `DataTransfer`）——這仍然是瀏覽器裡跑的、`overview.ts` 真正掛上去的事
 * 件監聽器，測的是同一段production code，只是跳過作業系統那一層無法在
 * 無頭 CI 穩定重現的部分。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/page-management-deck");
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

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-pm-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-pm-files-"));
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

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  // Thumbnails materialise lazily (IntersectionObserver) — wait for the
  // rail itself before any test touches `.overview-item`.
  await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBeGreaterThan(0);
  return page;
}

async function readProject(registry: CommandRegistry, id: string): Promise<{ slides: string[] }> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
  if (!result.ok) throw new Error(result.message);
  return JSON.parse(result.data!.content);
}

async function readSlide(registry: CommandRegistry, id: string, slidePath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

/** Fires `dragstart` on `fromIndex`'s `<li>` then `dragover` on `toIndex`'s, at a Y offset near that item's top or bottom edge (T3 plan §3.8's "cursor position decides insert-before/-after" rule as this shell implements it — no trailing placeholder card, see overview.ts's own comment). */
async function dragOver(page: Page, fromIndex: number, toIndex: number, edge: "top" | "bottom"): Promise<void> {
  await page.evaluate(
    ({ fromIndex, toIndex, edge }) => {
      const w = window as unknown as { __e2eDrag?: DataTransfer };
      const source = document.querySelector(`.overview-item[data-index="${fromIndex}"]`) as HTMLElement;
      const target = document.querySelector(`.overview-item[data-index="${toIndex}"]`) as HTMLElement;
      const rect = target.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = edge === "top" ? rect.top + 2 : rect.bottom - 2;
      const dataTransfer = new DataTransfer();
      w.__e2eDrag = dataTransfer;
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer, clientX, clientY: rect.top }),
      );
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }));
    },
    { fromIndex, toIndex, edge },
  );
}

async function drop(page: Page, toIndex: number, edge: "top" | "bottom"): Promise<void> {
  await page.evaluate(
    ({ toIndex, edge }) => {
      const w = window as unknown as { __e2eDrag?: DataTransfer };
      const target = document.querySelector(`.overview-item[data-index="${toIndex}"]`) as HTMLElement;
      const rect = target.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = edge === "top" ? rect.top + 2 : rect.bottom - 2;
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: w.__e2eDrag, clientX, clientY }),
      );
    },
    { toIndex, edge },
  );
}

async function dragEnd(page: Page, fromIndex: number): Promise<void> {
  await page.evaluate((fromIndex) => {
    const w = window as unknown as { __e2eDrag?: DataTransfer };
    const source = document.querySelector(`.overview-item[data-index="${fromIndex}"]`) as HTMLElement;
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: w.__e2eDrag }));
  }, fromIndex);
}

it("New 面板：Blank 與範本清單皆可用，套用會插入新頁（05-INTERACTIONS「New／Templates」場景）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const before = await readProject(registry, presentationId);
    expect(before.slides).toEqual(["slides/001.svg", "slides/002.svg", "slides/003.svg", "slides/004.svg"]);

    await page.getByRole("button", { name: "New" }).click();
    const menu = page.locator('[role="menu"][data-menu="new"]');
    await expect.poll(() => menu.getByRole("menuitem", { name: "From outline…" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Blank" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Title" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Section" }).isVisible()).toBe(true);

    await menu.getByRole("menuitem", { name: "Blank" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    const afterBlank = await readProject(registry, presentationId);
    // Current page was slides/001.svg (index 0) on load, so Blank inserts at index 1.
    const blankSlidePath = afterBlank.slides[1];
    expect(before.slides).not.toContain(blankSlidePath);

    // Applying a template: same insertion semantics, content copied byte-for-byte except ids.
    await page.getByRole("button", { name: "New" }).click();
    await menu.getByRole("menuitem", { name: "Title" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      6,
    );
    const afterTemplate = await readProject(registry, presentationId);
    // Blank's own insert already moved currentIndex to 1 (runPageCommand's
    // showSlide(at)), so this second insert lands right after IT, at index 2.
    const templateSlidePath = afterTemplate.slides[2];
    const templateContent = await readSlide(registry, presentationId, templateSlidePath);
    expect(templateContent).toContain("Title 範本");
    expect(templateContent).not.toContain('id="el-template-title"'); // re-minted, not copied verbatim
    expect(templateContent).toMatch(/id="el-[^"]+"/);
  } finally {
    await cleanup();
  }
});

it("Templates 按鈕：只列範本清單（沒有 Blank／From outline…），套用走跟 New 面板同一個函式", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.getByRole("button", { name: "Templates" }).click();
    const menu = page.locator('[role="menu"][data-menu="templates"]');
    await expect.poll(() => menu.getByRole("menuitem", { name: "Title" }).isVisible()).toBe(true);
    await expect.poll(() => menu.getByRole("menuitem", { name: "Section" }).isVisible()).toBe(true);
    expect(await menu.getByRole("menuitem", { name: "Blank" }).count()).toBe(0);
    expect(await menu.getByRole("menuitem", { name: "From outline…" }).count()).toBe(0);

    await menu.getByRole("menuitem", { name: "Section" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    const project = await readProject(registry, presentationId);
    const newContent = await readSlide(registry, presentationId, project.slides[1]);
    expect(newContent).toContain("Section 範本");
  } finally {
    await cleanup();
  }
});

it("拖曳排序：紅色插入線出現在放置目標上緣，放開後 project.json 順序改變（05-INTERACTIONS「拖曳排序」場景）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);

    let commandCalls = 0;
    await page.route("**/api/command", (route) => {
      commandCalls++;
      void route.continue();
    });

    // Drop item 0 (slides/001.svg) onto the BOTTOM half of item 2
    // (slides/003.svg): to=3, newIndex=2 → final order [002,003,001,004]
    // (T3 plan §5-B's own expected result, "[2,3,1,4]" by original numbering).
    await dragOver(page, 0, 2, "bottom");
    await expect.poll(() => page.locator(".overview-drop-line").count(), { timeout: 5_000 }).toBe(1);
    const dropLineColor = await page
      .locator(".overview-drop-line")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const brandRed = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--brand-red"));
    const brandRedResolved = await page.evaluate((v) => {
      const probe = document.createElement("div");
      probe.style.color = v;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, brandRed.trim());
    expect(dropLineColor).toBe(brandRedResolved);

    await drop(page, 2, "bottom");
    await dragEnd(page, 0);

    await expect.poll(async () => (await readProject(registry, presentationId)).slides, { timeout: 10_000 }).toEqual([
      "slides/002.svg",
      "slides/003.svg",
      "slides/001.svg",
      "slides/004.svg",
    ]);
    await expect.poll(() => page.locator(".overview-drop-line").count()).toBe(0);
    expect(commandCalls).toBe(1);

    // no-op: dropping item 0 onto itself (top half) must not draw a line or send a command.
    await dragOver(page, 0, 0, "top");
    expect(await page.locator(".overview-drop-line").count()).toBe(0);
    await drop(page, 0, "top");
    await dragEnd(page, 0);
    expect(commandCalls).toBe(1);

    // no-op: dropping item 0 onto its own immediate next slot (index 1's top half, i.e. to=1=from+1).
    await dragOver(page, 0, 1, "top");
    expect(await page.locator(".overview-drop-line").count()).toBe(0);
    await drop(page, 1, "top");
    await dragEnd(page, 0);
    expect(commandCalls).toBe(1);
    await expect.poll(async () => (await readProject(registry, presentationId)).slides).toEqual([
      "slides/002.svg",
      "slides/003.svg",
      "slides/001.svg",
      "slides/004.svg",
    ]);
  } finally {
    await cleanup();
  }
});

it("根因迴歸守門測試（T3 plan §0/§5-E）：slide notes set 之後進播放模式，不出現 [role=alert]，投影片正常渲染", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const result = await registry.dispatch("slide notes set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      text: "講者備忘稿：這段話不該出現在縮圖或播放畫面上",
    });
    expect(result.ok).toBe(true);
    const content = await readSlide(registry, presentationId, "slides/001.svg");
    expect(content).toContain('<comot:notes xmlns:comot="https://co-motion.dev/ns">');

    const page = await openApp(server);

    // 縮圖不得畫出 <metadata> 內容（備忘稿文字不該外流到 rail）——`<metadata>`
    // 本來就在 markup 裡（wrapSlideDocument 直接把整份 slide markup 塞進
    // iframe 的 body），所以這裡斷言的是「不可見」（SVG UA 樣式表對
    // `<metadata>` 是 `display:none`），不是「HTML 裡沒有這段文字」。
    const thumbFrame = page.frameLocator(".overview-item[data-index=\"0\"] iframe.overview-frame");
    await expect.poll(() => thumbFrame.locator("metadata").count().catch(() => 0), { timeout: 15_000 }).toBeGreaterThan(0);
    const metadataVisible = await thumbFrame.locator("metadata").first().isVisible();
    expect(metadataVisible).toBe(false);

    await page.locator(".play-button").click();
    await page.waitForTimeout(500);

    expect(await page.locator('[role="alert"]').count()).toBe(0);
    expect(await page.content()).not.toContain("無法讀取效果清單");

    const playFrame = page.frameLocator("iframe.slide-frame");
    await expect.poll(() => playFrame.locator("#el-page-1").textContent().catch(() => null), { timeout: 15_000 }).toBe(
      "第一頁",
    );
  } finally {
    await cleanup();
  }
});
