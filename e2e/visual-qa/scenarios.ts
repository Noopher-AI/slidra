import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { Page } from "playwright";
import type { CommandRegistry } from "@co-motion/cli";
import type { RunningServer } from "../../packages/server/src/serve.js";
// NOOP-60/#197（New v3 殼重建）刪除了 ribbon-commands.ts，`RibbonCmdId` 已
// 不存在——這整份 scenarios.ts 是針對舊殼（ribbon-menu／template-dialog／
// 插入選單）寫的，且新殼對應的插入面板／Shape／Arrange 選單目前都是空容器
// （本票明確排除的範圍，見 PR 報告），沒有東西可截圖比對。完整重寫這份
// scenario 表格是後續票的範圍，不在這張骨架票；這裡只把型別改成
// `Record<string, Scenario[]>` 讓 `npm run typecheck` 保持綠燈，不代表下
// 面任何一個 scenario 在新殼上還有效——`npm run visual-qa`（非自動化必經
// 關卡）在新殼插入面板真的有內容之前執行這份表格會全部失敗。

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A small, decodable image fixture distinct from the byte-assertion-only 1x1 PNG in ribbon-transitions.test.ts. */
export const photoPngPath = path.join(e2eDir, "fixtures/media-deck/assets/photo.png");
export const clipWebmPath = path.join(e2eDir, "fixtures/media-deck/assets/clip.webm");
export const narrationOgaPath = path.join(e2eDir, "fixtures/media-deck/assets/narration.oga");

export interface ScenarioContext {
  page: Page;
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
}

export interface Scenario {
  /** Screenshot filename and manifest primary key, kebab-case, unique across the whole table. */
  id: string;
  /** One-sentence description of what this scenario does, written verbatim into the manifest. */
  description: string;
  /** Explains a headless-only limitation, e.g. "not observable under headless". Omitted when there is none. */
  note?: string;
  /** Starting from "app open, on slide 1", perform the operations and settle on the frame to screenshot. */
  run(ctx: ScenarioContext): Promise<void>;
}

async function readSlide(ctx: ScenarioContext, slidePath = "slides/001.svg"): Promise<string> {
  const result = await ctx.registry.dispatch<{ content: string }>("cat", { id: ctx.presentationId, path: slidePath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

async function readProject(ctx: ScenarioContext): Promise<{ slides: string[] }> {
  const result = await ctx.registry.dispatch<{ content: string }>("cat", { id: ctx.presentationId, path: "project.json" });
  if (!result.ok) throw new Error(result.message);
  return JSON.parse(result.data!.content);
}

/** `project.json`'s `templates`, already normalized to `{ file, name }` since every deck this suite opens is written post-[E4.T7]. */
async function readProjectTemplates(ctx: ScenarioContext): Promise<{ file: string; name: string }[]> {
  const result = await ctx.registry.dispatch<{ content: string }>("cat", { id: ctx.presentationId, path: "project.json" });
  if (!result.ok) throw new Error(result.message);
  const project = JSON.parse(result.data!.content) as { templates?: unknown };
  return Array.isArray(project.templates) ? (project.templates as { file: string; name: string }[]) : [];
}

/** Adds one template directly through the registry (setup for a 範本管理 scenario that needs an existing template, bypassing the UI it isn't testing). */
async function addTemplateFixture(ctx: ScenarioContext, name: string): Promise<void> {
  const result = await ctx.registry.dispatch<{ templatePath: string }>("template add", {
    id: ctx.presentationId,
    from: "slides/001.svg",
    name,
  });
  if (!result.ok) throw new Error(result.message);
}

/**
 * `translate(x y)` -> `{x, y}`. An element with no `transform` attribute at
 * all is legitimately at its untransformed position (`element-arrange.ts`'s
 * `buildTransformSplice` omits the attribute outright when a delta is
 * zero) — that is `{x: 0, y: 0}`, not an error.
 */
function readTranslate(svg: string, elementId: string): { x: number; y: number } {
  if (!new RegExp(`<g id="${elementId}"[^>]*>`).test(svg)) throw new Error(`找不到元素：${elementId}`);
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  if (!elementMatch) return { x: 0, y: 0 };
  const translateMatch = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(elementMatch[1]);
  if (!translateMatch) return { x: 0, y: 0 };
  return { x: Number(translateMatch[1]), y: Number(translateMatch[2]) };
}

async function goToTab(page: Page, label: "常用" | "插入" | "切換" | "投影片放映"): Promise<void> {
  await page.locator(`.tab:has-text("${label}")`).click();
}

async function clickCmd(page: Page, label: string): Promise<void> {
  await page.locator(`.cmd:has-text("${label}")`).click();
}

/**
 * Waits for the exact request `canvas.ts`'s `reload()` issues to repaint
 * the slide iframe (`render()`'s own `fetchText(`/api/files/${slidePath}`)`)
 * — the live-reload round trip a registry-only file check cannot see, so a
 * screenshot taken right after only the registry assertion can still catch
 * the canvas mid-repaint (see `new-slide-blank`'s equivalent overview-rail
 * wait for the one mutation that does not touch this endpoint).
 */
function waitForSlideRepaint(page: Page, slidePath = "slides/001.svg"): Promise<unknown> {
  return page.waitForResponse((response) => response.url().endsWith(`/api/files/${slidePath}`) && response.status() === 200);
}

async function pickFile(page: Page, buttonLabel: string, filePath: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await clickCmd(page, buttonLabel);
  const fileChooser = await chooser;
  await Promise.all([waitForSlideRepaint(page), fileChooser.setFiles(filePath)]);
}

function gCount(svg: string): number {
  return svg.match(/<g /g)?.length ?? 0;
}

function elementIds(svg: string): string[] {
  return [...svg.matchAll(/<g id="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Waits for play mode's own iframe.slide-frame (canvas.ts's `renderPlay()`
 * reuses the same class) to have real content, not the `#000` loading
 * placeholder canvas.ts's own comments document — entering play mode via
 * `.titlebar` count alone proves the mode switched, not that the slide
 * itself has painted yet.
 */
async function waitForPlayContent(page: Page): Promise<void> {
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null)).not.toBeNull();
}

/** Inserts a rectangle via 常用分頁「圖案」→「矩形」and returns its generated element id (diffed from the id set before/after). */
async function insertRectAndGetId(ctx: ScenarioContext): Promise<string> {
  const beforeIds = new Set(elementIds(await readSlide(ctx)));
  await clickCmd(ctx.page, "圖案");
  const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
  await expect.poll(() => menuItems.count()).toBe(3);
  await Promise.all([
    waitForSlideRepaint(ctx.page),
    ctx.page.locator('.ribbon-menu [role="menuitem"]:has-text("矩形")').click(),
  ]);
  const newId = elementIds(await readSlide(ctx)).find((id) => !beforeIds.has(id));
  if (!newId) throw new Error("找不到新增矩形的元素 id");
  return newId;
}

/** 見上方檔頭的 NOOP-60/#197 註解：內容已針對舊殼過時，型別只求編譯得過。 */
export const SCENARIOS: Record<string, Scenario[]> = {
  "new-slide": [
    {
      id: "new-slide-menu",
      description: "常用分頁點「新增投影片」，開啟樣板選單（僅「空白」一項，中間狀態不判讀）",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "新增投影片");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(1);
      },
    },
    {
      id: "new-slide-blank",
      description: "選單選「空白」後新增一張投影片",
      async run(ctx) {
        const before = await readProject(ctx);
        const overviewItems = ctx.page.locator("li.overview-item");
        const beforeItemCount = await overviewItems.count();
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "新增投影片");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(1);
        await menuItems.first().click();
        await expect.poll(async () => (await readProject(ctx)).slides.length).toBe(before.slides.length + 1);
        // The file write above only proves the server-side state changed —
        // the overview rail (driven by its own `/api/events` live-reload
        // push, not this polling) needs its own confirmation, or the
        // screenshot can be taken mid-race against a still-stale UI.
        await expect.poll(() => overviewItems.count()).toBe(beforeItemCount + 1);
      },
    },
  ],
  template: [
    {
      id: "template-dialog-empty",
      description: "沒有任何範本時開啟範本管理對話框，顯示空狀態文字（A2）",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "範本");
        const dialog = ctx.page.locator(".template-dialog");
        await expect.poll(() => dialog.locator(".template-dialog-empty").count()).toBe(1);
      },
    },
    {
      id: "template-dialog-open",
      description: "開啟範本管理對話框，清單顯示既有範本的縮圖與名稱（A1/A2）",
      async run(ctx) {
        await addTemplateFixture(ctx, "封面");
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "範本");
        const dialog = ctx.page.locator(".template-dialog");
        await expect.poll(() => dialog.locator(".template-dialog-item").count()).toBe(1);
        await expect.poll(() => dialog.locator(".template-dialog-name").first().textContent()).toBe("封面");
      },
    },
    {
      id: "template-save-current",
      description: "對話框內把目前這頁存成範本，清單與 project.json 各多一筆（A3）",
      async run(ctx) {
        const before = await readProjectTemplates(ctx);
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "範本");
        const dialog = ctx.page.locator(".template-dialog");
        await dialog.locator(".template-dialog-save-open").click();
        await dialog.locator(".template-dialog-save input").fill("我的範本");
        await Promise.all([
          ctx.page.waitForResponse((response) => response.url().endsWith("/api/command") && response.status() === 200),
          dialog.locator('.template-dialog-save button:has-text("確定")').click(),
        ]);
        await expect.poll(async () => (await readProjectTemplates(ctx)).length).toBe(before.length + 1);
        await expect.poll(() => dialog.locator(".template-dialog-item").count()).toBe(before.length + 1);
      },
    },
    {
      id: "template-rename",
      description: "清單上把範本改名，關閉對話框後「新增投影片」選單顯示新名字（A7）",
      async run(ctx) {
        await addTemplateFixture(ctx, "封面");
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "範本");
        const dialog = ctx.page.locator(".template-dialog");
        await expect.poll(() => dialog.locator(".template-dialog-item").count()).toBe(1);
        await dialog.locator('.template-dialog-item button:has-text("改名")').click();
        await dialog.locator(".template-dialog-rename input").fill("封面（新）");
        await Promise.all([
          ctx.page.waitForResponse((response) => response.url().endsWith("/api/command") && response.status() === 200),
          dialog.locator('.template-dialog-rename button:has-text("確定")').click(),
        ]);
        await expect.poll(async () => (await readProjectTemplates(ctx))[0]?.name).toBe("封面（新）");
        // 「新增投影片」選單的內容是點擊當下對 presentationInfo 的一次性快照
        // （ribbonHandlers 既有的設計），不是隨後續更新重新計算的即時清單——
        // 所以要等對話框自己（會隨 presentationInfo 重繪）先顯示新名字，
        // 確認 live-reload 真的落地了，才能關閉對話框、重新開這個選單。
        await expect.poll(() => dialog.locator(".template-dialog-name").first().textContent()).toBe("封面（新）");
        await dialog.locator(".template-dialog-close").click();
        await clickCmd(ctx.page, "新增投影片");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.filter({ hasText: "封面（新）" }).count()).toBe(1);
      },
    },
    {
      id: "template-delete-confirm",
      description: "刪除範本前顯示確認文字，確認後範本從清單與 project.json 消失（A8）",
      async run(ctx) {
        await addTemplateFixture(ctx, "封面");
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "範本");
        const dialog = ctx.page.locator(".template-dialog");
        await expect.poll(() => dialog.locator(".template-dialog-item").count()).toBe(1);
        await dialog.locator('.template-dialog-item button:has-text("刪除")').click();
        await expect
          .poll(() => dialog.locator(".template-dialog-confirm-delete").textContent())
          .toContain("已用此範本建立的投影片不受影響");
        await Promise.all([
          ctx.page.waitForResponse((response) => response.url().endsWith("/api/command") && response.status() === 200),
          dialog.locator('.template-dialog-confirm-delete button:has-text("確定刪除")').click(),
        ]);
        await expect.poll(async () => (await readProjectTemplates(ctx)).length).toBe(0);
      },
    },
  ],
  paste: [
    {
      id: "paste",
      description: "選取「標題」→ 複製 → 貼上，該頁多出一個元素",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        const slideFrame = ctx.page.frameLocator("iframe.slide-frame");
        await slideFrame.locator("#el-title").click();
        const before = await readSlide(ctx);
        await clickCmd(ctx.page, "複製");
        await Promise.all([waitForSlideRepaint(ctx.page), clickCmd(ctx.page, "貼上")]);
        await expect.poll(async () => gCount(await readSlide(ctx))).toBe(gCount(before) + 1);
      },
    },
  ],
  cut: [
    {
      id: "cut",
      description: "選取「副標」→ 剪下，該頁少一個元素",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        const slideFrame = ctx.page.frameLocator("iframe.slide-frame");
        await slideFrame.locator("#el-subtitle").click();
        const before = await readSlide(ctx);
        await Promise.all([waitForSlideRepaint(ctx.page), clickCmd(ctx.page, "剪下")]);
        await expect.poll(async () => gCount(await readSlide(ctx))).toBe(gCount(before) - 1);
      },
    },
  ],
  copy: [
    {
      id: "copy",
      description: "選取「標題」→ 複製（不改檔案，看有無視覺回饋）",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        const slideFrame = ctx.page.frameLocator("iframe.slide-frame");
        await slideFrame.locator("#el-title").click();
        await clickCmd(ctx.page, "複製");
        // Copy never writes a file — there is nothing to poll for. This
        // fixed wait proves the (nonexistent) mutation really did not
        // happen before the screenshot, the one case the plan allows it.
        await ctx.page.waitForTimeout(150);
      },
    },
  ],
  textbox: [
    {
      id: "textbox",
      description: "常用分頁新增文字方塊",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        const before = await readSlide(ctx);
        await Promise.all([waitForSlideRepaint(ctx.page), clickCmd(ctx.page, "文字方塊")]);
        await expect.poll(async () => gCount(await readSlide(ctx))).toBe(gCount(before) + 1);
      },
    },
  ],
  shape: [
    {
      id: "shape-menu",
      description: "常用分頁點「圖案」，開啟圖案選單（中間狀態不判讀）",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "圖案");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(3);
      },
    },
    {
      id: "shape-rect",
      description: "選單選「矩形」新增矩形圖案",
      async run(ctx) {
        const before = await readSlide(ctx);
        const beforeRectCount = before.match(/<rect/g)?.length ?? 0;
        await goToTab(ctx.page, "常用");
        await clickCmd(ctx.page, "圖案");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(3);
        await Promise.all([
          waitForSlideRepaint(ctx.page),
          ctx.page.locator('.ribbon-menu [role="menuitem"]:has-text("矩形")').click(),
        ]);
        await expect.poll(async () => (await readSlide(ctx)).match(/<rect/g)?.length ?? 0).toBe(beforeRectCount + 1);
      },
    },
  ],
  arrange: [
    {
      id: "arrange-menu",
      description: "新增一個矩形，多選它與背景後點「排列」，開啟排列選單（中間狀態不判讀）",
      async run(ctx) {
        await goToTab(ctx.page, "常用");
        const rectId = await insertRectAndGetId(ctx);
        const slideFrame = ctx.page.frameLocator("iframe.slide-frame");
        await slideFrame.locator(`#${rectId}`).click();
        await slideFrame.locator("#el-VDJP6MD9hs3N").click({ modifiers: ["Shift"], position: { x: 10, y: 10 } });
        await clickCmd(ctx.page, "排列");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(12);
      },
    },
    {
      id: "arrange-align-left",
      description: "多選新矩形與背景後選「靠左對齊」，矩形貼齊背景左緣",
      async run(ctx) {
        // `demo/`'s el-title/el-subtitle are bare `<text>` — geometry/bbox.ts
        // has no bounding box for those yet ("尚無法計算文字元素的邊界框：待
        // #76 的字型度量落地"), so `element align` 500s on them. A newly
        // inserted rect (measurable) aligned against the full-bleed
        // background rect (also measurable, and always at x=0) is the
        // closest equivalent that both actually succeeds and visibly moves.
        await goToTab(ctx.page, "常用");
        const rectId = await insertRectAndGetId(ctx);
        const slideFrame = ctx.page.frameLocator("iframe.slide-frame");
        await slideFrame.locator(`#${rectId}`).click();
        await slideFrame.locator("#el-VDJP6MD9hs3N").click({ modifiers: ["Shift"], position: { x: 10, y: 10 } });
        await clickCmd(ctx.page, "排列");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(12);
        await Promise.all([
          waitForSlideRepaint(ctx.page),
          ctx.page.locator('.ribbon-menu [role="menuitem"]:has-text("靠左對齊")').click(),
        ]);
        await expect
          .poll(async () => {
            const svg = await readSlide(ctx);
            return readTranslate(svg, rectId).x === readTranslate(svg, "el-VDJP6MD9hs3N").x;
          })
          .toBe(true);
      },
    },
  ],
  "insert-image": [
    {
      id: "insert-image",
      description: "插入分頁匯入圖片，畫面出現對應圖片",
      async run(ctx) {
        await goToTab(ctx.page, "插入");
        await pickFile(ctx.page, "圖片", photoPngPath);
        await expect.poll(async () => (await readSlide(ctx)).includes('href="../assets/photo.png"')).toBe(true);
      },
    },
  ],
  "insert-video": [
    {
      id: "insert-video",
      description: "插入分頁匯入影片，畫面出現對應媒體佔位",
      async run(ctx) {
        await goToTab(ctx.page, "插入");
        await pickFile(ctx.page, "影片", clipWebmPath);
        await expect.poll(async () => (await readSlide(ctx)).includes('data-comot-media="../assets/clip.webm"')).toBe(true);
      },
    },
  ],
  "insert-audio": [
    {
      id: "insert-audio",
      description: "插入分頁匯入音訊，畫面出現對應媒體佔位",
      async run(ctx) {
        await goToTab(ctx.page, "插入");
        await pickFile(ctx.page, "音訊", narrationOgaPath);
        // demo/assets/ already has a narration.oga (決定 1's fixture, unrelated
        // to this scenario's own fixture file) — the importer resolves the
        // name collision with a "-1" suffix, so the assertion below matches
        // any narration*.oga rather than the exact original filename.
        await expect
          .poll(async () => /data-comot-media="\.\.\/assets\/narration[^"]*\.oga"/.test(await readSlide(ctx)))
          .toBe(true);
      },
    },
  ],
  "insert-shape": [
    {
      id: "insert-shape-menu",
      description: "插入分頁點「圖案」，開啟圖案選單（中間狀態不判讀）",
      async run(ctx) {
        await goToTab(ctx.page, "插入");
        await clickCmd(ctx.page, "圖案");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(3);
      },
    },
    {
      id: "insert-shape-ellipse",
      description: "插入分頁選單選「橢圓」新增橢圓圖案",
      async run(ctx) {
        const before = await readSlide(ctx);
        const beforeEllipseCount = before.match(/<ellipse/g)?.length ?? 0;
        await goToTab(ctx.page, "插入");
        await clickCmd(ctx.page, "圖案");
        const menuItems = ctx.page.locator('.ribbon-menu [role="menuitem"]');
        await expect.poll(() => menuItems.count()).toBe(3);
        await Promise.all([
          waitForSlideRepaint(ctx.page),
          ctx.page.locator('.ribbon-menu [role="menuitem"]:has-text("橢圓")').click(),
        ]);
        await expect.poll(async () => (await readSlide(ctx)).match(/<ellipse/g)?.length ?? 0).toBe(beforeEllipseCount + 1);
      },
    },
  ],
  "insert-textbox": [
    {
      id: "insert-textbox",
      description: "插入分頁新增文字方塊",
      async run(ctx) {
        await goToTab(ctx.page, "插入");
        const before = await readSlide(ctx);
        await Promise.all([waitForSlideRepaint(ctx.page), clickCmd(ctx.page, "文字方塊")]);
        await expect.poll(async () => gCount(await readSlide(ctx))).toBe(gCount(before) + 1);
      },
    },
  ],
  "slide-number": [
    {
      id: "slide-number",
      description: "插入分頁新增頁碼變數，畫面顯示第 1 頁的頁碼",
      async run(ctx) {
        await goToTab(ctx.page, "插入");
        await Promise.all([waitForSlideRepaint(ctx.page), clickCmd(ctx.page, "頁碼")]);
        await expect.poll(async () => (await readSlide(ctx)).includes("{{ slide_number }}")).toBe(true);
        const slideFrame = ctx.page.frameLocator("iframe.slide-frame");
        await expect.poll(async () => (await slideFrame.locator("svg").innerHTML().catch(() => "")).includes(">1<")).toBe(true);
      },
    },
  ],
  "transition-none": [
    {
      id: "transition-none",
      description: "切換分頁設定轉場效果為「無」",
      async run(ctx) {
        await goToTab(ctx.page, "切換");
        await Promise.all([
          ctx.page.waitForResponse((response) => response.url().endsWith("/api/presentation") && response.status() === 200),
          clickCmd(ctx.page, "無"),
        ]);
      },
    },
  ],
  "transition-fade": [
    {
      id: "transition-fade",
      description: "切換分頁設定轉場效果為「淡入淡出」",
      async run(ctx) {
        await goToTab(ctx.page, "切換");
        await Promise.all([
          ctx.page.waitForResponse((response) => response.url().endsWith("/api/presentation") && response.status() === 200),
          clickCmd(ctx.page, "淡入淡出"),
        ]);
      },
    },
  ],
  "play-from-start": [
    {
      id: "play-from-start",
      description: "從頭播放投影片",
      async run(ctx) {
        await goToTab(ctx.page, "投影片放映");
        await clickCmd(ctx.page, "從頭播放");
        await expect.poll(() => ctx.page.locator(".titlebar").count()).toBe(0);
        await waitForPlayContent(ctx.page);
      },
    },
  ],
  "play-from-current": [
    {
      id: "play-from-current",
      description: "先切到第 3 頁，再從目前投影片開始播放",
      async run(ctx) {
        const thirdItem = ctx.page.locator('li.overview-item[data-index="2"]');
        await thirdItem.locator("button.overview-thumb").click();
        await expect
          .poll(async () => (await thirdItem.getAttribute("class")) ?? "")
          .toContain("overview-item-current");

        await goToTab(ctx.page, "投影片放映");
        await clickCmd(ctx.page, "從目前投影片");
        await expect.poll(() => ctx.page.locator(".titlebar").count()).toBe(0);
        await waitForPlayContent(ctx.page);
      },
    },
  ],
  "toggle-fullscreen": [
    {
      id: "toggle-fullscreen",
      description: "點「全螢幕」切換至全螢幕模式",
      async run(ctx) {
        await goToTab(ctx.page, "投影片放映");
        await clickCmd(ctx.page, "全螢幕");
        await expect
          .poll(() =>
            ctx.page.evaluate(() => {
              const container = document.querySelector(".canvas-area");
              return document.fullscreenElement !== null && document.fullscreenElement === container;
            }),
          )
          .toBe(true);
      },
    },
  ],
};
