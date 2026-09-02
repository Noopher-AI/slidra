import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import type { CommandRegistry } from "@co-motion/cli";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp as openAppHelper, requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

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
const deckDir = path.join(e2eDir, "fixtures/direct-manipulation-deck");

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  return startServerForHelper({ deckDir, prefix: "ribbon", injectFonts: true });
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await openAppHelper(browser, server);
  openPages.push(page);
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

/** Every top-level `<g id="...">` in a slide's markup, in document order. */
function groupIds(svg: string): string[] {
  return [...svg.matchAll(/<g id="([^"]+)"/g)].map((match) => match[1]);
}

/** Same lookup as e2e/ribbon-insert.test.ts's own helper — the main canvas iframe, not the overview thumbnails. */
async function canvasFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  throw new Error("找不到主畫布的 iframe.slide-frame");
}

/** Reads the `.sel` overlay's `display` the same way e2e/ribbon-insert.test.ts's does — `"block"` means a selection box is actually showing. */
async function selectionBoxDisplay(page: Page): Promise<string | null> {
  const frame = await canvasFrame(page);
  return frame.evaluate(() => {
    const host = document.querySelector("[data-comot-selection-host]") as HTMLElement | null;
    const sel = host?.shadowRoot?.querySelector(".sel") ?? null;
    return sel ? getComputedStyle(sel).display : null;
  });
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

    // NOOP-275/#156 A1: the pasted element must become the current
    // selection, so the author sees a selection box instead of a silent
    // insert.
    await expect.poll(() => selectionBoxDisplay(page)).toBe("block");
  } finally {
    await cleanup();
  }
});

it("多選複製 + 貼上：貼上後全部新元素被選取，不是只有第一個 (A2)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });

    const before = await readSlide(registry, presentationId);
    await page.locator('.cmd:has-text("複製")').click();
    await page.locator('.cmd:has-text("貼上")').click();

    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<g /g)?.length ?? 0).toBe(
      (before.match(/<g /g)?.length ?? 0) + 2,
    );

    // StatusBar 在多選時顯示「N 個元素」（見 packages/web/src/shell/StatusBar.tsx）——
    // 這是唯一能從畫面直接讀出「選了幾個」的地方，不必逐一比對 selection-runtime
    // 的內部訊息。
    const selName = page.locator(".status .sel-name");
    await expect.poll(() => selName.textContent()).toBe("已選取：2 個元素");
  } finally {
    await cleanup();
  }
});

it("同頁連續貼上兩次：兩份彼此錯開，肉眼可辨識為兩份 (A3)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await page.locator('.cmd:has-text("複製")').click();

    const before = await readSlide(registry, presentationId);
    const beforeIds = new Set(groupIds(before));

    await page.locator('.cmd:has-text("貼上")').click();
    await expect.poll(async () => groupIds(await readSlide(registry, presentationId)).length).toBe(
      beforeIds.size + 1,
    );
    const afterFirstPaste = await readSlide(registry, presentationId);
    const firstNewId = groupIds(afterFirstPaste).find((id) => !beforeIds.has(id))!;
    const firstOffset = readTranslate(afterFirstPaste, firstNewId);

    await page.locator('.cmd:has-text("貼上")').click();
    await expect.poll(async () => groupIds(await readSlide(registry, presentationId)).length).toBe(
      beforeIds.size + 2,
    );
    const afterSecondPaste = await readSlide(registry, presentationId);
    const secondNewId = groupIds(afterSecondPaste).find(
      (id) => !beforeIds.has(id) && id !== firstNewId,
    )!;
    const secondOffset = readTranslate(afterSecondPaste, secondNewId);

    // 兩次貼上的偏移必須不同（且沿同一方向遞增），肉眼才分得出兩份。
    expect(secondOffset.x).toBeGreaterThan(firstOffset.x);
    expect(secondOffset.y).toBeGreaterThan(firstOffset.y);
  } finally {
    await cleanup();
  }
});

it("跨投影片貼上：新元素座標與來源完全相同 (A4)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();

    const sourceSlide = await readSlide(registry, presentationId);
    const sourceOffset = readTranslate(sourceSlide, "el-a");
    await page.locator('.cmd:has-text("複製")').click();

    // 開一張新的空白投影片，切過去。
    await page.locator('.cmd:has-text("新增投影片")').click();
    const menuItems = page.locator('.ribbon-menu [role="menuitem"]');
    await expect.poll(() => menuItems.count()).toBe(1);
    await menuItems.first().click();
    await expect.poll(async () => (await readProject(registry, presentationId)).slides.length).toBe(2);
    const newSlidePath = (await readProject(registry, presentationId)).slides[1];

    const thumbnails = page.locator("li.overview-item button.overview-thumb");
    await expect.poll(() => thumbnails.count()).toBe(2);
    await thumbnails.nth(1).click();
    // 確認主畫布真的已經切到新頁（空白頁，沒有 el-a），貼上才會落在正確目標。
    await expect.poll(() => slideFrame.locator("#el-a").count()).toBe(0);

    const beforePaste = await readSlide(registry, presentationId, newSlidePath);
    const beforeIds = new Set(groupIds(beforePaste));

    await page.locator('.cmd:has-text("貼上")').click();
    await expect
      .poll(async () => groupIds(await readSlide(registry, presentationId, newSlidePath)).length)
      .toBe(beforeIds.size + 1);

    const afterPaste = await readSlide(registry, presentationId, newSlidePath);
    const newId = groupIds(afterPaste).find((id) => !beforeIds.has(id))!;
    const pastedOffset = readTranslate(afterPaste, newId);

    expect(pastedOffset).toEqual(sourceOffset);
  } finally {
    await cleanup();
  }
});

it("貼上（含偏移）是一格復原，不因偏移變成兩格 (A5)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator("#el-a").click();
    await page.locator('.cmd:has-text("複製")').click();

    // 貼回來源頁的第一次貼上就已帶有非零偏移（見 paste-offset.ts 的
    // clipboardWritten/nextPasteOffset 規則），不需要先貼一次墊底。
    const before = await readSlide(registry, presentationId);
    const beforeIds = new Set(groupIds(before));
    const sourceOffset = readTranslate(before, "el-a");

    await page.locator('.cmd:has-text("貼上")').click();
    await expect.poll(async () => groupIds(await readSlide(registry, presentationId)).length).toBe(
      beforeIds.size + 1,
    );
    const afterPaste = await readSlide(registry, presentationId);
    const newId = groupIds(afterPaste).find((id) => !beforeIds.has(id))!;
    // 這次貼上確實帶了非零偏移，undo 才有意義驗證「不多花一格」。
    expect(readTranslate(afterPaste, newId)).not.toEqual(sourceOffset);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
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
    // Fixture already has both a filled and a fill-less `<text>` (NOOP-224:
    // counting must isolate the newly inserted one, not just "some text has
    // fill", which would already be true before the fix).
    const beforeFilledTextCount = before.match(/<text[^>]*\sfill="[^"]+"/g)?.length ?? 0;

    await page.locator('.cmd:has-text("文字方塊")').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<g /g)?.length ?? 0).toBe(
      beforeCount + 1,
    );
    const after = await readSlide(registry, presentationId);
    expect(after).toContain("文字方塊");
    expect(after).toContain("<text");
    expect(after.match(/<text[^>]*\sfill="[^"]+"/g)?.length ?? 0).toBe(beforeFilledTextCount + 1);
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
    // Fixture already has several filled rects (NOOP-224: counting must
    // isolate the newly inserted one, not just "some rect has fill", which
    // would already be true before the fix).
    const beforeFilledRectCount = before.match(/<rect[^>]*\sfill="[^"]+"/g)?.length ?? 0;

    await page.locator('.cmd:has-text("圖案")').click();
    const menuItems = page.locator(".ribbon-menu [role=\"menuitem\"]");
    await expect.poll(() => menuItems.count()).toBe(3);
    expect(await menuItems.allTextContents()).toEqual(["矩形", "橢圓", "線"]);

    await page.locator('.ribbon-menu [role="menuitem"]:has-text("矩形")').click();
    await expect.poll(async () => (await readSlide(registry, presentationId)).match(/<rect/g)?.length ?? 0).toBe(
      beforeRectCount + 1,
    );
    expect(await page.locator(".ribbon-menu").count()).toBe(0);
    const after = await readSlide(registry, presentationId);
    expect(after.match(/<rect[^>]*\sfill="[^"]+"/g)?.length ?? 0).toBe(beforeFilledRectCount + 1);
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

it("未選取任何元素點「複製」：canvasState.error 以 role=alert 顯示", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const alert = page.locator(".canvas-error-banner[role='alert']");
    expect(await alert.count()).toBe(0);

    await page.locator('.cmd:has-text("複製")').click();
    await expect.poll(() => alert.textContent()).toBe("元素清單不可為空");
  } finally {
    await cleanup();
  }
});

it("未選取任何元素點「剪下」：canvasState.error 以 role=alert 顯示", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const alert = page.locator(".canvas-error-banner[role='alert']");
    expect(await alert.count()).toBe(0);

    await page.locator('.cmd:has-text("剪下")').click();
    await expect.poll(() => alert.textContent()).toBe("元素清單不可為空");
  } finally {
    await cleanup();
  }
});

it("剪貼簿是空的時候點「貼上」：canvasState.error 以 role=alert 顯示", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const alert = page.locator(".canvas-error-banner[role='alert']");
    expect(await alert.count()).toBe(0);

    await page.locator('.cmd:has-text("貼上")').click();
    await expect.poll(() => alert.textContent()).toBe("剪貼簿是空的");
  } finally {
    await cleanup();
  }
});

it("一次成功命令會清掉先前的錯誤訊息", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const alert = page.locator(".canvas-error-banner[role='alert']");
    expect(await alert.count()).toBe(0);

    // 先用「貼上」製造一個錯誤，作為要被清除的舊狀態。
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
