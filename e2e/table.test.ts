import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp, requireBuilt, startServerFor } from "./helpers/launch.js";
import { compareScreenshot, settleForScreenshot, settledBox } from "./helpers/screenshot.js";

/**
 * E2.T14/E2.T14r2's real-Chromium acceptance tests (plan §5/§6) — the one
 * new e2e file this round adds (原 Plan §7 決定 14, 本輪不變): B1–B2 (single
 * SVG open, ADR-0001), E1–E13 + E12b (GUI operations, including the
 * keyboard cell-range shortcuts this round's plan exists for), and F1–F4
 * (6 screenshots). Every fixture table below is built through the live
 * `registry` (`table create`/`table cell set`/`table bind`), never
 * hand-written markup (NOOP-237's lesson, plan §6.3) — the SVG on disk is
 * always whatever core actually produces.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/table-deck");
const baselineDir = path.join(e2eDir, "__screenshots__/table");
const SLIDE_PATH = "slides/001.svg";

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function openPage(server: RunningServer): Promise<Page> {
  const page = await openApp(browser, server);
  openPages.push(page);
  return page;
}

interface TableCreateOptions {
  rows?: number;
  cols?: number;
  theme?: "dark" | "light" | "zebra";
  header?: boolean;
}

/** Packs `table-deck` and creates one table via the live registry (plan §6.3) — the shared starting point every test below builds on unless noted otherwise. */
async function newTableDeck(prefix: string, options: TableCreateOptions = {}) {
  const started = await startServerFor({ deckDir, prefix });
  const created = await started.registry.dispatch<{ elementId: string }>("table create", {
    id: started.presentationId,
    slidePath: SLIDE_PATH,
    rows: options.rows ?? 2,
    cols: options.cols ?? 2,
    x: 100,
    y: 100,
    theme: options.theme ?? "dark",
    header: options.header ?? true,
  });
  const elementId = created.data!.elementId;
  return { ...started, elementId };
}

/** Binds `elementId` (2 cols, last row as template) to the fixture CSV — 3 data rows × 2 cols = 6 generated cells (plan §6.3/§6.4, verified against the real CLI chain). */
async function bindToSalesCsv(
  registry: Awaited<ReturnType<typeof newTableDeck>>["registry"],
  presentationId: string,
  elementId: string,
  templateRow: number,
): Promise<void> {
  await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: templateRow, col: 0, text: "{{ 產品 }}" });
  await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: templateRow, col: 1, text: "{{ 銷量 }}" });
  await registry.dispatch("table bind", { id: presentationId, slidePath: SLIDE_PATH, elementId, source: "assets/data/sales.csv" });
}

async function catSlide(registry: Awaited<ReturnType<typeof newTableDeck>>["registry"], presentationId: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: SLIDE_PATH });
  return result.data!.content;
}

/** `<COMOTION_HOME>/history/<presentationId>/stack.json`'s `undo` array length — same direct read `e2e/direct-manipulation.test.ts`'s own `undoCount` uses, for "single history entry" assertions without depending on the Undo button's own UI state. */
async function undoCount(presentationId: string): Promise<number> {
  const home = process.env.COMOTION_HOME!;
  try {
    const raw = await readFile(path.join(home, "history", presentationId, "stack.json"), "utf8");
    return (JSON.parse(raw).undo ?? []).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** The single cell `<g data-comot-cell="row,col">…</g>` block's raw markup, for regex assertions against a `cat` dump. */
function cellMarkup(svg: string, row: number, col: number): string {
  const match = new RegExp(`<g data-comot-cell="${row},${col}"[^>]*>[\\s\\S]*?</g>`).exec(svg);
  if (!match) throw new Error(`找不到儲存格 (${row},${col})`);
  return match[0];
}

it("B1: 單獨用 file:// 開啟 workdir 的 slides/001.svg，無 parsererror，rect 數量等於實際格數", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("b1", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const svgContent = await catSlide(registry, presentationId);
    const expectedCells = (svgContent.match(/data-comot-cell="/g) ?? []).length;
    expect(expectedCells).toBeGreaterThan(0);

    const workDir = path.join(process.env.COMOTION_HOME!, "work", presentationId);
    const page = await browser.newPage();
    openPages.push(page);
    await page.goto(`file://${path.join(workDir, SLIDE_PATH)}`);

    expect(await page.locator("parsererror").count()).toBe(0);
    expect(await page.locator("[data-comot-type=table] rect").count()).toBe(expectedCells);
  } finally {
    await cleanup();
  }
});

it("B2: 模板列的儲存格 display:none，generated 儲存格不是 none", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("b2", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);

    const workDir = path.join(process.env.COMOTION_HOME!, "work", presentationId);
    const page = await browser.newPage();
    openPages.push(page);
    await page.goto(`file://${path.join(workDir, SLIDE_PATH)}`);

    const templateDisplay = await page.locator('[data-comot-repeat="row"]').first().evaluate((el) => getComputedStyle(el).display);
    expect(templateDisplay).toBe("none");

    const generatedCount = await page.locator('[data-comot-generated="1"]').count();
    expect(generatedCount).toBe(6);
    const generatedDisplays = await page.locator('[data-comot-generated="1"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
    for (const display of generatedDisplays) expect(display).not.toBe("none");
  } finally {
    await cleanup();
  }
});

it("E1: Dock 的 Table 按鈕開出插入面板；hover 預覽格數；click 鎖定；Insert 後投影片多一個表格並成為選取", async () => {
  const { server, cleanup } = await startServerFor({ deckDir, prefix: "e1" });
  try {
    const page = await openPage(server);

    await page.getByRole("button", { name: "Table" }).click();
    const panel = page.locator(".table-panel");
    expect(await panel.isVisible()).toBe(true);
    expect(await panel.locator(".table-panel-cell").count()).toBe(48);

    // Hover the cell at row index 2, col index 3 (0-based) — a 3×4 preview.
    await panel.locator('.table-panel-cell[aria-label="3 × 4"]').hover();
    expect(await panel.locator('[role="grid"]').getAttribute("aria-label")).toBe("Table size：3 × 4");

    await panel.locator('.table-panel-cell[aria-label="3 × 4"]').click();
    const insertButton = panel.locator(".table-panel-insert");
    expect(await insertButton.isEnabled()).toBe(true);
    await insertButton.click();

    const slideFrame = page.frameLocator("iframe.slide-frame");
    await expect.poll(() => slideFrame.locator("[data-comot-type=table]").count()).toBe(1);
    expect(await page.locator(".status-selection-chip").isVisible()).toBe(true);
  } finally {
    await cleanup();
  }
});

it("E2: 面板的三個主題按鈕各按一次後 Insert，產出的 data-comot-theme 對應正確", async () => {
  for (const theme of ["dark", "light", "zebra"] as const) {
    const { server, registry, presentationId, cleanup } = await startServerFor({ deckDir, prefix: `e2-${theme}` });
    try {
      const page = await openPage(server);
      await page.getByRole("button", { name: "Table" }).click();
      const panel = page.locator(".table-panel");
      await panel.locator('.table-panel-cell[aria-label="1 × 1"]').click();
      const label = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Zebra";
      await panel.locator(".table-panel-theme", { hasText: label }).click();
      await panel.locator(".table-panel-insert").click();

      await expect.poll(() => catSlide(registry, presentationId)).toContain(`data-comot-theme="${theme}"`);
    } finally {
      await cleanup();
    }
  }
});

it("E3: 面板的表頭開關關掉後 Insert，產出沒有 data-comot-header", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor({ deckDir, prefix: "e3" });
  try {
    const page = await openPage(server);
    await page.getByRole("button", { name: "Table" }).click();
    const panel = page.locator(".table-panel");
    await panel.locator('.table-panel-cell[aria-label="1 × 1"]').click();
    await panel.locator(".table-panel-header-toggle input[type=checkbox]").uncheck();
    await panel.locator(".table-panel-insert").click();

    await expect.poll(() => catSlide(registry, presentationId)).toContain("data-comot-type=\"table\"");
    expect(await catSlide(registry, presentationId)).not.toContain("data-comot-header");
  } finally {
    await cleanup();
  }
});

it("E4: 點一格出現單格範圍框；⇧點另一格範圍框涵蓋兩格圍出的矩形", async () => {
  const { server, cleanup } = await newTableDeck("e4", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    const rangeBox = page.locator(".table-range-box");
    await expect.poll(() => rangeBox.count()).toBe(1);
    const singleBox = await rangeBox.boundingBox();

    await slideFrame.locator('[data-comot-cell="1,1"]').click({ modifiers: ["Shift"] });
    await expect.poll(async () => {
      const box = await rangeBox.boundingBox();
      return box && singleBox ? box.width > singleBox.width && box.height > singleBox.height : false;
    }).toBe(true);
  } finally {
    await cleanup();
  }
});

it("E5: 範圍作用中按 Tab 移到下一格；按 Esc 範圍框消失但表格仍被選取", async () => {
  const { server, cleanup } = await newTableDeck("e5", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    const rangeBox = page.locator(".table-range-box");
    await expect.poll(() => rangeBox.count()).toBe(1);
    const beforeTab = await rangeBox.boundingBox();

    await page.keyboard.press("Tab");
    const targetCellBox = await slideFrame.locator('[data-comot-cell="0,1"]').boundingBox();
    await expect.poll(async () => {
      const box = await rangeBox.boundingBox();
      return box && targetCellBox ? Math.abs(box.x - targetCellBox.x) < 2 && Math.abs(box.y - targetCellBox.y) < 2 : false;
    }).toBe(true);
    const afterTab = await rangeBox.boundingBox();
    expect(afterTab).not.toEqual(beforeTab);

    const chip = page.locator(".status-selection-chip");
    const chipTextWhileRanging = await chip.textContent();

    await page.keyboard.press("Escape");
    await expect.poll(() => rangeBox.count()).toBe(0);
    expect(await chip.textContent()).toBe(chipTextWhileRanging);
  } finally {
    await cleanup();
  }
});

it("E6: 範圍作用中按 ⌘B，重載後該格 font-weight=700", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e6", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-comot-cell="1,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await page.keyboard.press("Meta+b");

    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return /font-weight="(\d+)"/.exec(cellMarkup(svg, 1, 0))?.[1] ?? null;
    }).toBe("700");
  } finally {
    await cleanup();
  }
});

it("E7: 範圍涵蓋 2 格時按 Delete，兩格文字變空且投影片仍有同樣數量的儲存格", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e7", { rows: 2, cols: 2 });
  try {
    await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: 0, col: 0, text: "A" });
    await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: 0, col: 1, text: "B" });
    const before = await catSlide(registry, presentationId);
    const cellCountBefore = (before.match(/data-comot-cell="/g) ?? []).length;
    expect(cellMarkup(before, 0, 0)).toContain(">A<");

    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    await slideFrame.locator('[data-comot-cell="0,1"]').click({ modifiers: ["Shift"] });
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await page.keyboard.press("Delete");

    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return cellMarkup(svg, 0, 0).includes(">A<") || cellMarkup(svg, 0, 1).includes(">B<");
    }, { timeout: 5_000 }).toBe(false);

    const after = await catSlide(registry, presentationId);
    expect((after.match(/data-comot-cell="/g) ?? []).length).toBe(cellCountBefore);
  } finally {
    await cleanup();
  }
});

it("E8: 雙擊一格出現編輯輸入框；Enter 提交後重載顯示新文字，只產生一筆歷史，undo 還原", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e8", { rows: 2, cols: 2 });
  try {
    const before = await catSlide(registry, presentationId);
    const beforeUndo = await undoCount(presentationId);

    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    // A plain click first, so `TableOverlay` has already mounted and its
    // `subscribeTable` effect has flushed — dblclicking a cell that has
    // NEVER been selected before races the very first render's effects
    // (verified directly: the table-cell-dblclick message can arrive
    // before React has run the mount effect at all, landing on zero
    // listeners) — an artifact of this test's cold start, not of the
    // dblclick feature itself.
    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-comot-cell="0,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    await editor.fill("哈囉");
    await editor.press("Enter");

    await expect.poll(async () => cellMarkup(await catSlide(registry, presentationId), 0, 0)).toContain(">哈囉<");
    expect(await undoCount(presentationId)).toBe(beforeUndo + 1);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await catSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("E8b: 表格在群組裡時，直接雙擊一格就進入編輯（同一次雙擊鑽入＋開編輯器），不需要先點一下", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e8b", { rows: 2, cols: 2 });
  try {
    const grouped = await registry.dispatch("element group", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: [elementId, "el-caption"],
    });
    expect(grouped.ok).toBe(true);

    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-comot-cell="0,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    await editor.fill("群內");
    await editor.press("Enter");

    await expect.poll(async () => cellMarkup(await catSlide(registry, presentationId), 0, 0)).toContain(">群內<");
  } finally {
    await cleanup();
  }
});

it("E9: 雙擊一個 generated 格，input 初值是含 {{ }} 的模板原文（架構：雙擊編輯的是模板列）", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e9", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    // Header(row 0) + template(row 1) + 3 generated rows (2,3,4) — (2,0) is
    // the first generated cell in column 0. A plain click first — see E8's
    // comment on why a cold dblclick on a never-selected table races
    // TableOverlay's own mount effect.
    await slideFrame.locator('[data-comot-cell="2,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-comot-cell="2,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    expect(await editor.inputValue()).toBe("{{ 產品 }}");
    // Drawn over the generated cell the author double-clicked — the template
    // row it edits is display:none and has no rect (was: a 12×12 input at
    // the slide's top-left corner, read as "cannot edit" in manual review).
    const clicked = await slideFrame.locator('[data-comot-cell="2,0"]').boundingBox();
    const editorBox = await editor.boundingBox();
    expect(editorBox!.width).toBeGreaterThan(40);
    expect(Math.abs(editorBox!.y - clicked!.y)).toBeLessThan(4);
  } finally {
    await cleanup();
  }
});

// F-09 (NOOP-399): Tab used to have no handler at all inside the cell
// editor's <input>, so it fell through to the browser default — focus
// jumped clean out of the table to the dock's hand-tool button, and
// whatever the user typed next went nowhere. This proves Tab now commits
// the current cell, moves editing to the next one, and — critically —
// keeps focus on the SAME <input> element the whole time (no
// blur-then-remount cycle), so typing can continue immediately.
it("F-09: 儲存格編輯中按 Tab，焦點留在同一個 input.table-cell-editor 並移到下一格，兩格都能寫入", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("f9", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-comot-cell="0,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    const editorHandle = await editor.elementHandle();
    await editor.fill("A1");
    const leftBeforeTab = await editor.evaluate((el) => (el as HTMLElement).style.left);

    await editor.press("Tab");

    // 沒有重新 mount：同一個 DOM 節點還在、還是 document.activeElement。
    expect(await editorHandle!.evaluate((el) => el === document.activeElement)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("INPUT");
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className))
      .toContain("table-cell-editor");
    // Tab 之後編輯器已經移到下一格：rect 的 left 改變了。
    await expect.poll(() => editor.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(leftBeforeTab);
    expect(await editor.inputValue()).toBe("");

    await editor.type("B1");
    await editor.press("Enter");

    await expect.poll(async () => cellMarkup(await catSlide(registry, presentationId), 0, 0)).toContain(">A1<");
    await expect.poll(async () => cellMarkup(await catSlide(registry, presentationId), 0, 1)).toContain(">B1<");
  } finally {
    await cleanup();
  }
});

// F-09 迴歸（Reviewer, NOOP-400）：Tab 落在 generated 格時，編輯框的初值必須
// 是「同欄模板列的原文」，跟 E9 的雙擊路徑同一個契約——因為 `editing.row`
// 已經被 `nextTableTabCell` 解析成模板列，寫回去的就是模板列。若初值取的是
// generated 格自己的「已算好的值」，接著任何一次提交（Enter／blur／再按一次
// Tab）都會把 `{{ }}` 模板表達式覆蓋成那個字面值，整欄的資料繫結當場消失。
it("F-09b: Tab 落在 generated 格，input 初值是同欄模板原文，提交後模板列的 {{ }} 不被覆蓋", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("f9b", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-comot-cell="2,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-comot-cell="2,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    expect(await editor.inputValue()).toBe("{{ 產品 }}");

    await editor.press("Tab");

    expect(await editor.inputValue()).toBe("{{ 銷量 }}");

    await editor.press("Enter");
    await expect
      .poll(async () => cellMarkup(await catSlide(registry, presentationId), 1, 1))
      .toContain("{{ 銷量 }}");
  } finally {
    await cleanup();
  }
});

it("E10: 拖曳欄界把手，拖曳期間即時改變寬度；放開後只產生一筆歷史，undo 還原", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e10", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-comot-cell="0,0"]').click();

    const handle = page.locator(".table-col-handle").first();
    await expect.poll(() => handle.count()).toBe(1);
    const box = await handle.boundingBox();
    if (!box) throw new Error("量不到欄界把手的邊界框");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    const beforeUndo = await undoCount(presentationId);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 60, startY, { steps: 5 });

    const liveWidth = Number(await slideFrame.locator('[data-comot-cell="0,0"] rect').getAttribute("width"));
    expect(liveWidth).toBeGreaterThan(200); // default column width is 160; +60px drag should read well above it mid-drag

    await page.mouse.up();
    await page.waitForTimeout(150);

    expect(await undoCount(presentationId)).toBe(beforeUndo + 1);
    const svg = await catSlide(registry, presentationId);
    const cols = /data-comot-cols="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
    expect(cols[0]).toBeGreaterThan(200);
    expect(cols[0]).toBeLessThan(400); // a 60px drag must not also swallow the well's left offset (was 160 -> ~900)
    expect(cols[0] + cols[1]).toBeCloseTo(320, 3); // the boundary moved: the right column absorbed the difference

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(Number(/data-comot-cols="([^"]+)"/.exec(await catSlide(registry, presentationId))![1].split(" ")[0])).toBe(160);
  } finally {
    await cleanup();
  }
});

it("E11: 在格上按右鍵出現選單（Edit／Bold／插列插欄／Merge／刪列刪欄／Clear）；點 Merge 後左上格 span=2,2，其餘三格消失", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e11", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    await slideFrame.locator('[data-comot-cell="1,1"]').click({ modifiers: ["Shift"] });
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);

    await slideFrame.locator('[data-comot-cell="0,0"]').click({ button: "right" });
    const menu = page.locator('[data-testid="table-cell-menu"]');
    await expect.poll(() => menu.count()).toBe(1);
    const items = await menu.locator(".table-cell-menu-item").allTextContents();
    expect(items).toEqual([
      "Edit",
      "Bold",
      "Insert row above",
      "Insert row below",
      "Insert column left",
      "Insert column right",
      "Merge cells",
      "Delete row",
      "Delete column",
      "Clear",
    ]);

    await menu.getByText("Merge cells", { exact: true }).click();

    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return (svg.match(/data-comot-cell="/g) ?? []).length;
    }).toBe(1);
    const svg = await catSlide(registry, presentationId);
    expect(cellMarkup(svg, 0, 0)).toContain('data-comot-span="2,2"');
  } finally {
    await cleanup();
  }
});

it("E12: 選取表格時右欄 Style › Object 顯示 table-section；點主題後重載主題改變；綁定表格按 Refresh 後 generated 數與 CSV 一致", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e12", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-comot-cell="0,0"]').click();

    await page.locator("#side-panel-tab-style").click();
    const section = page.locator(".table-section");
    await expect.poll(() => section.isVisible()).toBe(true);

    await section.locator(".table-section-theme", { hasText: "Light" }).click();
    await expect.poll(() => catSlide(registry, presentationId)).toContain('data-comot-theme="light"');

    const refreshButton = section.locator(".table-section-refresh");
    await expect.poll(() => refreshButton.count()).toBe(1);
    await refreshButton.click();
    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return (svg.match(/data-comot-generated="1"/g) ?? []).length;
    }).toBe(6);
  } finally {
    await cleanup();
  }
});

it('E12b: 點一格後出現 table-section-cell；點 align center 後重載該格有 data-comot-align="center"；Esc 離開範圍後消失', async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e12b", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await page.locator("#side-panel-tab-style").click();

    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    const cellSection = page.locator(".table-section-cell");
    await expect.poll(() => cellSection.count()).toBe(1);

    await cellSection.locator('.table-section-align[data-align="center"]').click();
    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return cellMarkup(svg, 0, 0).includes('data-comot-align="center"');
    }).toBe(true);

    await page.keyboard.press("Escape");
    await expect.poll(() => cellSection.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("E13: 選取表格時顯示四角縮放與旋轉把手（表格靠容器 transform 縮放），文字框寬度把手不顯示", async () => {
  const { server, cleanup } = await newTableDeck("e13", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-comot-cell="0,0"]').click();

    for (const name of ["nw", "ne", "sw", "se", "rotate"]) {
      const handle = slideFrame.locator(`[data-comot-handle="${name}"]`);
      const display = await handle.evaluate((el) => getComputedStyle(el).display);
      expect(display, name).not.toBe("none");
    }
    for (const name of ["width-left", "width-right"]) {
      const handle = slideFrame.locator(`[data-comot-handle="${name}"]`);
      const display = await handle.evaluate((el) => getComputedStyle(el).display);
      expect(display, name).toBe("none");
    }
  } finally {
    await cleanup();
  }
});

// F1–F4: 6 baselines under `e2e/__screenshots__/table/` (plan §5 F1–F4 —
// each one preceded by a behaviour assertion, per the AGENTS.md "硬條件":
// a `compareScreenshot` call with SKIP_APPEARANCE_BASELINES=1 and no
// preceding assertion is zero verification (#224 r3's own lesson).
//
// Header rect fill/fill-opacity per theme (plan §3.10, `theme.ts`'s
// `THEMES.<name>.head` — not exported from core's public barrel, so these
// are the literal values read directly off that source).
const HEADER_PAINT: Record<"dark" | "light" | "zebra", { fill: string; fillOpacity: string | null }> = {
  dark: { fill: "#ffffff", fillOpacity: "0.06" },
  light: { fill: "#f5f1ef", fillOpacity: null },
  zebra: { fill: "#ffffff", fillOpacity: "0.08" },
};

type Box = { x: number; y: number; width: number; height: number };

/**
 * 把 boundingBox 取整並夾在 viewport 內——尺寸不符是 compareScreenshot 的無容忍硬失敗
 * （helpers/screenshot.ts）。角落各自四捨五入（而不是 x/y 與 width/height 分開四捨五入）
 * 是刻意的：後者在 box 邊界落在 .5 附近時，x 與 width 可能各自進位到不同方向，兩次執行
 * 算出的尺寸就會差 1px（實測 F4 出現過 203x288 vs 204x289）。從角落算可以消掉這個誤差。
 */
function snapClip(box: Box): Box {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const right = Math.min(1440, Math.round(box.x + box.width));
  const bottom = Math.min(900, Math.round(box.y + box.height));
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) throw new Error(`clip 尺寸無效：${width}x${height}`);
  return { x, y, width, height };
}

/** 多個 boundingBox 的聯集；任一為 null 或陣列為空都明確報錯，絕不回退成整個視窗。 */
function unionBox(label: string, boxes: (Box | null)[]): Box {
  if (boxes.length === 0 || boxes.some((b) => b === null)) throw new Error(`找不到 ${label} 的版面框`);
  const list = boxes as Box[];
  const left = Math.min(...list.map((b) => b.x));
  const top = Math.min(...list.map((b) => b.y));
  const right = Math.max(...list.map((b) => b.x + b.width));
  const bottom = Math.max(...list.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

it("F1: table-panel 基準截圖", async () => {
  const { server, cleanup } = await startServerFor({ deckDir, prefix: "f1" });
  try {
    const page = await openPage(server);
    // `.table-panel` carries `.floating-layer`'s `scale(0.96)→scale(1)` entrance
    // animation (dock.css) — suppress it so the clip below measures the settled
    // box, not a mid-animation one (NOOP-198's F1 flake).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Table" }).click();
    const panel = page.locator(".table-panel");
    const cells = panel.locator(".table-panel-cell");
    expect(await cells.count()).toBe(48);
    expect(await cells.first().isEnabled()).toBe(true);

    await settleForScreenshot(page);
    const clip = snapClip(unionBox("插入面板", [await settledBox(panel, "插入面板")]));
    await compareScreenshot(page, { name: "table-panel", baselineDir, clip });
  } finally {
    await cleanup();
  }
});

// F2 的固定文字（3×3，第 0 列是表頭）——`table create` 預設是空表格，而空表格在
// pixelmatch 的門檻下無論背景深淺都低於可辨識界線（本輪 Plan 已用 pixelmatch@7
// 逐色值量測驗證）；文字是唯一能跨過門檻、讓這 3 張基準真的守住表格渲染的圖元。
const F2_TEXT: Record<string, string> = {
  "0,0": "產品",
  "0,1": "區域",
  "0,2": "銷量",
  "1,0": "甲",
  "1,1": "北區",
  "1,2": "120",
  "2,0": "乙",
  "2,1": "南區",
  "2,2": "340",
};

for (const theme of ["dark", "light", "zebra"] as const) {
  it(`F2: theme-${theme} 基準截圖`, async () => {
    const { server, registry, presentationId, elementId, cleanup } = await newTableDeck(`f2-${theme}`, { rows: 3, cols: 3, theme });
    try {
      for (const [addr, text] of Object.entries(F2_TEXT)) {
        const [row, col] = addr.split(",").map(Number);
        await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row, col, text });
      }

      const page = await openPage(server);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const svg = await catSlide(registry, presentationId);
      expect(svg).toContain(`data-comot-theme="${theme}"`);
      const headerCell = cellMarkup(svg, 0, 0);
      const paint = HEADER_PAINT[theme];
      expect(headerCell).toContain(`fill="${paint.fill}"`);
      if (paint.fillOpacity !== null) expect(headerCell).toContain(`fill-opacity="${paint.fillOpacity}"`);
      else expect(headerCell).not.toContain("fill-opacity");
      expect(headerCell).toContain(">產品<");

      await settleForScreenshot(page);
      const slideFrame = page.frameLocator("iframe.slide-frame");
      const cellAddrs = [
        ["0,0"], ["0,1"], ["0,2"],
        ["1,0"], ["1,1"], ["1,2"],
        ["2,0"], ["2,1"], ["2,2"],
      ];
      const rects = await Promise.all(
        cellAddrs.map(([addr]) => slideFrame.locator(`[data-comot-cell="${addr}"] rect`).boundingBox()),
      );
      const clip = snapClip(unionBox("表格", rects));
      await compareScreenshot(page, { name: `theme-${theme}`, baselineDir, clip });
    } finally {
      await cleanup();
    }
  });
}

it("F3: cell-range 基準截圖", async () => {
  const { server, cleanup } = await newTableDeck("f3", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    // `.context-bar` carries `context-bar-in`'s `translateY` entrance animation
    // (stage-overlays.css) — suppress it so the clip below measures the
    // settled box (NOOP-198's root-cause table found this affects F3 too,
    // just masked by the `waitForTimeout(200)` below).
    await page.emulateMedia({ reducedMotion: "reduce" });
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    await slideFrame.locator('[data-comot-cell="1,1"]').click({ modifiers: ["Shift"] });

    const rangeBox = page.locator(".table-range-box");
    await expect.poll(() => rangeBox.count()).toBe(1);
    // `rangeRect` is computed from the LAST `table-cells` reply
    // (`requestTableCells`'s async round trip) — `.count() === 1` only
    // proves the element exists, not that its geometry has settled onto
    // the final (both-cells) reply yet.
    await page.waitForTimeout(200);
    const rangeBoxBox = await rangeBox.boundingBox();
    const rects = await Promise.all(
      [
        ["0,0"],
        ["0,1"],
        ["1,0"],
        ["1,1"],
      ].map(([addr]) => slideFrame.locator(`[data-comot-cell="${addr}"] rect`).boundingBox()),
    );
    expect(rangeBoxBox).not.toBeNull();
    for (const rect of rects) expect(rect).not.toBeNull();
    const left = Math.min(...rects.map((r) => r!.x));
    const top = Math.min(...rects.map((r) => r!.y));
    const right = Math.max(...rects.map((r) => r!.x + r!.width));
    const bottom = Math.max(...rects.map((r) => r!.y + r!.height));
    expect(Math.abs(rangeBoxBox!.x - left)).toBeLessThan(3);
    expect(Math.abs(rangeBoxBox!.y - top)).toBeLessThan(3);
    expect(Math.abs(rangeBoxBox!.x + rangeBoxBox!.width - right)).toBeLessThan(3);
    expect(Math.abs(rangeBoxBox!.y + rangeBoxBox!.height - bottom)).toBeLessThan(3);

    await settleForScreenshot(page);
    const contextBar = page.locator(".context-bar");
    const clip = snapClip(
      unionBox("範圍框與情境列", [await settledBox(rangeBox, "範圍框"), await settledBox(contextBar, "情境列")]),
    );
    await compareScreenshot(page, { name: "cell-range", baselineDir, clip });
  } finally {
    await cleanup();
  }
});

it("F4: cell-menu 基準截圖", async () => {
  const { server, cleanup } = await newTableDeck("f4", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    // `.table-cell-menu` carries the same `floating-layer-in` entrance
    // animation as `.table-panel` (table.css:191) — suppress it so the clip
    // below measures the settled box (NOOP-198's F4 flake).
    await page.emulateMedia({ reducedMotion: "reduce" });
    const slideFrame = page.frameLocator("iframe.slide-frame");
    // A plain click first — same "let TableOverlay's own subscription
    // settle before the interaction that needs it" reasoning as E8/E9's
    // dblclick fix; a cold right-click on a never-selected table races the
    // component's mount effect the same way a cold dblclick does.
    await slideFrame.locator('[data-comot-cell="0,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-comot-cell="0,0"]').click({ button: "right" });

    const menu = page.locator('[data-testid="table-cell-menu"]');
    await expect.poll(() => menu.count()).toBe(1);
    const items = menu.locator(".table-cell-menu-item");
    expect(await items.count()).toBe(9); // 2×2 selection: no Merge/Unmerge (single cell) — Edit/Bold/×4 insert/Delete row/Delete col/Clear
    for (const text of await items.allTextContents()) {
      expect(await items.filter({ hasText: text }).first().isEnabled()).toBe(true);
    }

    await settleForScreenshot(page);
    const clip = snapClip(unionBox("儲存格右鍵選單", [await settledBox(menu, "儲存格右鍵選單")]));
    await compareScreenshot(page, { name: "cell-menu", baselineDir, clip });
  } finally {
    await cleanup();
  }
});
