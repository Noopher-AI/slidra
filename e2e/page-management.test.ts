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
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";

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
const baselineDir = path.join(e2eDir, "__screenshots__/page-management");

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

/**
 * The CLI-only half of the GUI/CLI equivalence test (C): no server, no
 * browser — a bare registry against its own copy of the fixture deck, the
 * same shape `notes-transition.test.ts` uses for its CLI-side assertions.
 */
async function startRegistryFor(): Promise<{
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-pm-cli-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-pm-cli-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const presentationId = opened.data!.id;

  return {
    registry,
    presentationId,
    cleanup: async () => {
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

/**
 * Collapses every re-minted `el-*` id (`slide add --template`/`slide
 * duplicate` both call `mintElementIds`, which is `crypto.randomUUID`-backed
 * — never equal across two independent runs) to a stable, first-seen-order
 * placeholder, so a GUI run and a CLI run of the same operation can be
 * compared byte-for-byte on everything except the part that's random by
 * design. Consistent across the whole document, so an id used twice (an
 * attribute and a same-document reference) still normalizes to one value.
 */
function normalizeIds(svg: string): string {
  const seen = new Map<string, string>();
  let counter = 0;
  return svg.replace(/el-[A-Za-z0-9_-]+/g, (match) => {
    let placeholder = seen.get(match);
    if (placeholder === undefined) {
      placeholder = `el-NORMALIZED-${counter++}`;
      seen.set(match, placeholder);
    }
    return placeholder;
  });
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

it("備忘稿（T3 plan §4.1／§5-D）：打字 → blur → 檔案內容；換頁往返；跳脫字元往返", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const notes = page.getByRole("textbox", { name: "Speaker notes" });

    await notes.click();
    await notes.fill("第一頁的講稿");
    await page.locator(".rail-slides-label").click(); // blur the textarea
    await expect
      .poll(async () => readSlide(registry, presentationId, "slides/001.svg"), { timeout: 10_000 })
      .toEqual(expect.stringContaining('<comot:notes xmlns:comot="https://co-motion.dev/ns">第一頁的講稿</comot:notes>'));

    // 換頁往返：切到第二頁（沒有備忘稿，顯示 placeholder），再切回第一頁，
    // 欄位要顯示剛才存的內容——不是空的，也不是第二頁的草稿。
    await page.locator('.overview-item[data-index="1"] .overview-thumb').click();
    await expect.poll(() => notes.inputValue()).toBe("");
    await page.locator('.overview-item[data-index="0"] .overview-thumb').click();
    await expect.poll(() => notes.inputValue()).toBe("第一頁的講稿");

    // 跳脫字元往返：檔案裡要轉義，UI 讀回要還原。
    await notes.click();
    await notes.fill("1 < 2 && true");
    await page.locator(".rail-slides-label").click();
    await expect
      .poll(async () => readSlide(registry, presentationId, "slides/001.svg"), { timeout: 10_000 })
      .toEqual(expect.stringContaining("1 &lt; 2 &amp;&amp; true"));
    await page.reload();
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.getByRole("textbox", { name: "Speaker notes" }).inputValue(), { timeout: 10_000 }).toBe(
      "1 < 2 && true",
    );
  } finally {
    await cleanup();
  }
});

it("鍵盤（T3 plan §4.3）：⌘D 複製目前頁、Delete 刪目前頁（皆限無選取）、PageUp／PageDown 換頁", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // 先點一個不會把焦點送進投影片 iframe 的安全元素，讓 page.keyboard.press
    // 送到 document 層級的 keydown effect，而不是播放器 runtime。
    await page.locator(".rail-slides-label").click();

    await page.keyboard.press("PageDown");
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("1");
    await page.keyboard.press("PageUp");
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("0");

    await page.keyboard.press("ControlOrMeta+d");
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    const afterDuplicate = await readProject(registry, presentationId);
    expect(afterDuplicate.slides[1]).not.toBe("slides/002.svg"); // inserted right after the source, not appended
    await expect.poll(() => page.locator(".overview-item-current").getAttribute("data-index")).toBe("1");

    await page.locator(".rail-slides-label").click();
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      4,
    );
    const afterDelete = await readProject(registry, presentationId);
    expect(afterDelete.slides).toEqual(afterDuplicate.slides.filter((_, i) => i !== 1));
  } finally {
    await cleanup();
  }
});

it("縮圖右鍵選單（T3 plan §3.9／§4.4）：開啟、Comment to agent 停用、Duplicate／Move／Delete 各自送出對應命令", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);

    await page.locator('.overview-item[data-index="0"]').click({ button: "right" });
    const menu = page.locator('[data-testid="thumb-context-menu"]');
    await expect.poll(() => menu.isVisible()).toBe(true);
    const commentItem = menu.getByRole("menuitem", { name: "Comment to agent" });
    expect(await commentItem.getAttribute("aria-disabled")).toBe("true");
    expect(await commentItem.isDisabled()).toBe(true);
    // Move up is disabled on the first slide (T3 plan §4.4).
    expect(await menu.getByRole("menuitem", { name: "Move up" }).isDisabled()).toBe(true);

    await menu.getByRole("menuitem", { name: /^Duplicate slide/ }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      5,
    );
    await expect.poll(() => menu.isVisible()).toBe(false); // menu closes after an action

    await page.locator('.overview-item[data-index="0"]').click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Move down" }).click();
    await expect
      .poll(async () => (await readProject(registry, presentationId)).slides[1], { timeout: 10_000 })
      .toBe("slides/001.svg");

    await page.locator('.overview-item[data-index="1"]').click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Delete slide" }).click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length, { timeout: 10_000 }).toBe(
      4,
    );
    expect((await readProject(registry, presentationId)).slides).not.toContain("slides/001.svg");
  } finally {
    await cleanup();
  }
});

it("截圖比對（T3 plan §5-G）：rail、New 面板、拖曳插入線、縮圖右鍵選單", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    // `.rail-menu` 進場有一個 translateY/opacity 的 CSS `animation`
    // （rail.css `rail-menu-in`，`--dur-fast`）；`compareScreenshot` 的
    // `animations: "disabled"` 理論上會把動畫快轉到結束態，但實測在 CI 上
    // 兩次各自捕捉的 New 面板截圖仍有肉眼不可見、pixelmatch 抓得到的
    // 一致性差異（608/37932，遠高於其餘無動畫元素的雜訊量級）——換成
    // `reducedMotion: "reduce"` 讓 tokens.css 的 reduced-motion 層直接把
    // `--dur-fast` 歸零，animation 從一開始就不存在，不再依賴「快轉到終
    // 態」這個間接機制。
    await page.emulateMedia({ reducedMotion: "reduce" });
    // 縮圖右上留言鈕靜止態 opacity:0、滑入該縮圖才變 1（rail.css）。截圖前
    // 明確把滑鼠移到不在任何 .overview-item 上的座標，讓「鈕不可見」是刻意
    // 保證的，不是「剛好還沒移過去」的巧合。
    await page.mouse.move(0, 0);
    await settleForScreenshot(page);
    const railBox = await page.locator(".rail").boundingBox();
    if (!railBox) throw new Error("找不到 .rail");
    await compareScreenshot(page, { name: "rail", baselineDir, clip: railBox });

    await page.getByRole("button", { name: "New" }).click();
    const newMenu = page.locator('[role="menu"][data-menu="new"]');
    // 範本清單走 `template list` 非同步載入（useTemplateList）——只等
    // `Blank`（同步渲染）可見就截圖是一場競賽：CI 上兩次執行的載入時機不
    // 保證相同，基準截圖與比對截圖可能一個等到範本、一個還在 loading。
    // 等到範本項目（Title／Section）也出現，畫面才是穩定的「已完全載入」
    // 狀態，跟 New 面板那個功能測試（test A）等的東西一致。
    await expect.poll(() => newMenu.getByRole("menuitem", { name: "Blank" }).isVisible()).toBe(true);
    await expect.poll(() => newMenu.getByRole("menuitem", { name: "Title" }).isVisible()).toBe(true);
    await expect.poll(() => newMenu.getByRole("menuitem", { name: "Section" }).isVisible()).toBe(true);
    await settleForScreenshot(page);
    const newPanelBox = await newMenu.boundingBox();
    if (!newPanelBox) throw new Error("找不到 New 面板");
    await compareScreenshot(page, { name: "new-panel", baselineDir, clip: newPanelBox });
    await page.keyboard.press("Escape");

    await dragOver(page, 0, 2, "bottom");
    await expect.poll(() => page.locator(".overview-drop-line").count(), { timeout: 5_000 }).toBe(1);
    // 拖曳模擬是合成 DragEvent（見上方 dragOver），不移動真實滑鼠；同一個
    // 「明確移到中性座標」的理由見上方 rail 截圖前的註解。
    await page.mouse.move(0, 0);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "drop-line", baselineDir, clip: railBox });
    await drop(page, 2, "bottom");
    await dragEnd(page, 0);

    await page.locator('.overview-item[data-index="0"]').click({ button: "right" });
    const contextMenu = page.locator('[data-testid="thumb-context-menu"]');
    await expect.poll(() => contextMenu.isVisible()).toBe(true);
    await settleForScreenshot(page);
    const contextMenuBox = await contextMenu.boundingBox();
    if (!contextMenuBox) throw new Error("找不到縮圖右鍵選單");
    await compareScreenshot(page, { name: "thumb-context-menu", baselineDir, clip: contextMenuBox });
  } finally {
    await cleanup();
  }
});

it("縮圖留言鈕依 03-UI_RATIONALE.md「滑入才顯示」：靜止態不可見，滑入該縮圖才可見（T3 plan §5-I-3）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const pin = page.locator('.overview-item[data-index="0"] .overview-comment-button');

    await page.mouse.move(0, 0);
    await expect.poll(() => pin.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");

    await page.locator('.overview-item[data-index="0"]').hover();
    await expect.poll(() => pin.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    // 滑入別的縮圖時，只有被滑入的那一項顯示，其餘維持 0。
    await page.locator('.overview-item[data-index="1"]').hover();
    await expect.poll(() => pin.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  } finally {
    await cleanup();
  }
});

it("GUI 與 CLI 的逐位元組等價（T3 plan §5-C／#208「每個操作對應 CLI 命令；agent 用同一命令可重現」）", async () => {
  // 每個操作各自在一份全新的 fixture 副本上做一次 GUI 操作、再在另一份全新
  // 副本上做一次等價的 registry.dispatch，比較兩邊的結果——而不是把五個操
  // 作串在同一份簡報上：串起來之後 CLI 那一側要嘛重新讀 GUI 那一側寫出的
  // 中繼狀態（等於在斷言「CLI 讀得懂 GUI 的輸出」而不是「兩條路徑本身等
  // 價」），要嘛得手算五步的中繼索引——後者正是 slide-ops.ts 的索引語意已
  // 經在單元測試裡覆蓋過的東西，這裡重複沒有增加驗證力道。「各做一次」照
  // 字面：同一個操作，兩條路徑，同一份起始位元組。
  //
  // GUI 與 CLI 兩側絕不能同時開著：`CO_MOTION_HOME` 是行程層級的環境變數
  // （`workspace.ts` 每次呼叫都重新讀一次，見它自己的說明），`startServerFor`
  // 與 `startRegistryFor` 都會覆寫它。GUI 側必須先跑完、`cleanup()` 收尾之
  // 後，CLI 側才能開始，否則兩邊的檔案操作會打到同一個暫存目錄。

  // 1) slide add（Blank）：GUI 走 New > Blank，等價 CLI 是 `slide add --at 1`
  //    （insertAt = hasSlides ? currentIndex+1 : 0，currentIndex 剛載入時是 0）。
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    let guiContent: string;
    try {
      const page = await openApp(gui.server);
      await page.getByRole("button", { name: "New" }).click();
      const menu = page.locator('[role="menu"][data-menu="new"]');
      await expect.poll(() => menu.getByRole("menuitem", { name: "Blank" }).isVisible()).toBe(true);
      await menu.getByRole("menuitem", { name: "Blank" }).click();
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides.length, { timeout: 10_000 })
        .toBe(5);
      guiProject = await readProject(gui.registry, gui.presentationId);
      guiContent = await readSlide(gui.registry, gui.presentationId, guiProject.slides[1]);
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch<{ slidePath: string }>("slide add", {
        id: cli.presentationId,
        at: 1,
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);
      const cliContent = await readSlide(cli.registry, cli.presentationId, cliResult.data!.slidePath);

      expect(cliProject).toEqual(guiProject);
      expect(cliContent).toBe(guiContent); // blank slides carry no ids — no normalization needed
    } finally {
      await cli.cleanup();
    }
  }

  // 2) slide duplicate：GUI 走縮圖右鍵選單，等價 CLI 是
  //    `slide duplicate slides/001.svg`。複製會重鑄 element id，比對前先正規化。
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    let guiContent: string;
    try {
      const page = await openApp(gui.server);
      await page.locator('.overview-item[data-index="0"]').click({ button: "right" });
      const menu = page.locator('[data-testid="thumb-context-menu"]');
      await expect.poll(() => menu.isVisible()).toBe(true);
      await menu.getByRole("menuitem", { name: /^Duplicate slide/ }).click();
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides.length, { timeout: 10_000 })
        .toBe(5);
      guiProject = await readProject(gui.registry, gui.presentationId);
      guiContent = normalizeIds(await readSlide(gui.registry, gui.presentationId, guiProject.slides[1]));
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch<{ slidePath: string }>("slide duplicate", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);
      const cliContent = normalizeIds(await readSlide(cli.registry, cli.presentationId, cliResult.data!.slidePath));

      expect(cliProject).toEqual(guiProject);
      expect(cliContent).toBe(guiContent);
    } finally {
      await cli.cleanup();
    }
  }

  // 3) slide delete：GUI 走 Delete 鍵（無選取），等價 CLI 是 `slide delete slides/001.svg`。
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    try {
      const page = await openApp(gui.server);
      await page.locator(".rail-slides-label").click();
      await page.keyboard.press("Delete");
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides.length, { timeout: 10_000 })
        .toBe(3);
      guiProject = await readProject(gui.registry, gui.presentationId);
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch("slide delete", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);

      expect(cliProject).toEqual(guiProject);
    } finally {
      await cli.cleanup();
    }
  }

  // 4) slide move：GUI 拖曳（同 test B 的拖法：0 拖到 2 的下緣 → newIndex=2），
  //    等價 CLI 是 `slide move slides/001.svg 2`。只動 project.json，不開 SVG。
  {
    const gui = await startServerFor();
    let guiProject: { slides: string[] };
    try {
      const page = await openApp(gui.server);
      await dragOver(page, 0, 2, "bottom");
      await drop(page, 2, "bottom");
      await dragEnd(page, 0);
      await expect
        .poll(async () => (await readProject(gui.registry, gui.presentationId)).slides, { timeout: 10_000 })
        .toEqual(["slides/002.svg", "slides/003.svg", "slides/001.svg", "slides/004.svg"]);
      guiProject = await readProject(gui.registry, gui.presentationId);
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch("slide move", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
        newIndex: 2,
      });
      expect(cliResult.ok).toBe(true);
      const cliProject = await readProject(cli.registry, cli.presentationId);

      expect(cliProject).toEqual(guiProject);
    } finally {
      await cli.cleanup();
    }
  }

  // 5) slide notes set：GUI 打字＋blur，等價 CLI 是 `slide notes set slides/001.svg "…"`。
  {
    const text = "GUI／CLI 等價測試備忘稿";
    const gui = await startServerFor();
    let guiContent: string;
    try {
      const page = await openApp(gui.server);
      const notes = page.getByRole("textbox", { name: "Speaker notes" });
      await notes.click();
      await notes.fill(text);
      await page.locator(".rail-slides-label").click();
      await expect
        .poll(async () => readSlide(gui.registry, gui.presentationId, "slides/001.svg"), { timeout: 10_000 })
        .toEqual(expect.stringContaining(text));
      guiContent = await readSlide(gui.registry, gui.presentationId, "slides/001.svg");
    } finally {
      await gui.cleanup();
    }

    const cli = await startRegistryFor();
    try {
      const cliResult = await cli.registry.dispatch("slide notes set", {
        id: cli.presentationId,
        slidePath: "slides/001.svg",
        text,
      });
      expect(cliResult.ok).toBe(true);
      const cliContent = await readSlide(cli.registry, cli.presentationId, "slides/001.svg");

      expect(cliContent).toBe(guiContent);
    } finally {
      await cli.cleanup();
    }
  }
});
