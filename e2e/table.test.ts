import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp, requireBuilt, startServerFor } from "./helpers/launch.js";

/**
 * Real-Chromium acceptance tests: B1-B2 (single SVG open, ADR-0001), E1-E13
 * + E12b (GUI operations, including keyboard cell-range shortcuts), and
 * F1-F4 (panel/menu geometry and state). Every fixture table below is
 * built through the live `registry` (`table create`/`table cell set`/
 * `table bind`), never hand-written markup — the SVG on disk is always
 * whatever core actually produces.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/table-deck");
const SLIDE_PATH = "slides/001.svg";

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
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

/** Packs `table-deck` and creates one table via the live registry — the shared starting point every test below builds on unless noted otherwise. */
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

/** Binds `elementId` (2 cols, last row as template) to the fixture CSV — 3 data rows × 2 cols = 6 generated cells, verified against the real CLI chain. */
async function bindToSalesCsv(
  registry: Awaited<ReturnType<typeof newTableDeck>>["registry"],
  presentationId: string,
  elementId: string,
  templateRow: number,
): Promise<void> {
  await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: templateRow, col: 0, text: "{{ Product }}" });
  await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: templateRow, col: 1, text: "{{ Sales }}" });
  await registry.dispatch("table bind", { id: presentationId, slidePath: SLIDE_PATH, elementId, source: "assets/data/sales.csv" });
}

async function catSlide(registry: Awaited<ReturnType<typeof newTableDeck>>["registry"], presentationId: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: SLIDE_PATH });
  return result.data!.content;
}

/** `<SLIDRA_HOME>/history/<presentationId>/stack.json`'s `undo` array length — same direct read `e2e/direct-manipulation.test.ts`'s own `undoCount` uses, for "single history entry" assertions without depending on the Undo button's own UI state. */
async function undoCount(presentationId: string): Promise<number> {
  const home = process.env.SLIDRA_HOME!;
  try {
    const raw = await readFile(path.join(home, "history", presentationId, "stack.json"), "utf8");
    return (JSON.parse(raw).undo ?? []).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** The single cell `<g data-slidra-cell="row,col">…</g>` block's raw markup, for regex assertions against a `cat` dump. */
function cellMarkup(svg: string, row: number, col: number): string {
  const match = new RegExp(`<g data-slidra-cell="${row},${col}"[^>]*>[\\s\\S]*?</g>`).exec(svg);
  if (!match) throw new Error(`could not find cell (${row},${col})`);
  return match[0];
}

it("B1: opening workdir's slides/001.svg directly via file:// produces no parsererror, and the rect count matches the actual cell count", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("b1", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const svgContent = await catSlide(registry, presentationId);
    const expectedCells = (svgContent.match(/data-slidra-cell="/g) ?? []).length;
    expect(expectedCells).toBeGreaterThan(0);

    const workDir = path.join(process.env.SLIDRA_HOME!, "work", presentationId);
    const page = await browser.newPage();
    openPages.push(page);
    await page.goto(`file://${path.join(workDir, SLIDE_PATH)}`);

    expect(await page.locator("parsererror").count()).toBe(0);
    expect(await page.locator("[data-slidra-type=table] rect").count()).toBe(expectedCells);
  } finally {
    await cleanup();
  }
});

it("B2: template row cells are display:none, generated cells are not", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("b2", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);

    const workDir = path.join(process.env.SLIDRA_HOME!, "work", presentationId);
    const page = await browser.newPage();
    openPages.push(page);
    await page.goto(`file://${path.join(workDir, SLIDE_PATH)}`);

    const templateDisplay = await page.locator('[data-slidra-repeat="row"]').first().evaluate((el) => getComputedStyle(el).display);
    expect(templateDisplay).toBe("none");

    const generatedCount = await page.locator('[data-slidra-generated="1"]').count();
    expect(generatedCount).toBe(6);
    const generatedDisplays = await page.locator('[data-slidra-generated="1"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
    for (const display of generatedDisplays) expect(display).not.toBe("none");
  } finally {
    await cleanup();
  }
});

it("E1: the Dock's Table button opens the insert panel; hovering previews the cell count; clicking locks it in; after Insert the slide gains one more table and it becomes selected", async () => {
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
    await expect.poll(() => slideFrame.locator("[data-slidra-type=table]").count()).toBe(1);
    expect(await page.locator(".status-selection-chip").isVisible()).toBe(true);
  } finally {
    await cleanup();
  }
});

it("E2: clicking each of the panel's three theme buttons once then Insert produces the matching data-slidra-theme", async () => {
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

      await expect.poll(() => catSlide(registry, presentationId)).toContain(`data-slidra-theme="${theme}"`);
    } finally {
      await cleanup();
    }
  }
});

it("E3: turning off the panel's header toggle then Insert produces no data-slidra-header", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor({ deckDir, prefix: "e3" });
  try {
    const page = await openPage(server);
    await page.getByRole("button", { name: "Table" }).click();
    const panel = page.locator(".table-panel");
    await panel.locator('.table-panel-cell[aria-label="1 × 1"]').click();
    await panel.locator(".table-panel-header-toggle input[type=checkbox]").uncheck();
    await panel.locator(".table-panel-insert").click();

    await expect.poll(() => catSlide(registry, presentationId)).toContain("data-slidra-type=\"table\"");
    expect(await catSlide(registry, presentationId)).not.toContain("data-slidra-header");
  } finally {
    await cleanup();
  }
});

it("E4: clicking one cell shows a single-cell range box; shift-clicking another cell expands the range box to the rectangle spanning both cells", async () => {
  const { server, cleanup } = await newTableDeck("e4", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    const rangeBox = page.locator(".table-range-box");
    await expect.poll(() => rangeBox.count()).toBe(1);
    const singleBox = await rangeBox.boundingBox();

    await slideFrame.locator('[data-slidra-cell="1,1"]').click({ modifiers: ["Shift"] });
    await expect.poll(async () => {
      const box = await rangeBox.boundingBox();
      return box && singleBox ? box.width > singleBox.width && box.height > singleBox.height : false;
    }).toBe(true);
  } finally {
    await cleanup();
  }
});

it("E5: pressing Tab while a range is active moves to the next cell; pressing Esc dismisses the range box but the table stays selected", async () => {
  const { server, cleanup } = await newTableDeck("e5", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    const rangeBox = page.locator(".table-range-box");
    await expect.poll(() => rangeBox.count()).toBe(1);
    const beforeTab = await rangeBox.boundingBox();

    await page.keyboard.press("Tab");
    const targetCellBox = await slideFrame.locator('[data-slidra-cell="0,1"]').boundingBox();
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

it("E6: pressing ⌘B while a range is active sets that cell's font-weight to 700 after reload", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e6", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-slidra-cell="1,0"]').click();
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

it("E7: pressing Delete with a 2-cell range selected clears both cells' text while the slide keeps the same number of cells", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e7", { rows: 2, cols: 2 });
  try {
    await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: 0, col: 0, text: "A" });
    await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row: 0, col: 1, text: "B" });
    const before = await catSlide(registry, presentationId);
    const cellCountBefore = (before.match(/data-slidra-cell="/g) ?? []).length;
    expect(cellMarkup(before, 0, 0)).toContain(">A<");

    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    await slideFrame.locator('[data-slidra-cell="0,1"]').click({ modifiers: ["Shift"] });
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await page.keyboard.press("Delete");

    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return cellMarkup(svg, 0, 0).includes(">A<") || cellMarkup(svg, 0, 1).includes(">B<");
    }, { timeout: 5_000 }).toBe(false);

    const after = await catSlide(registry, presentationId);
    expect((after.match(/data-slidra-cell="/g) ?? []).length).toBe(cellCountBefore);
  } finally {
    await cleanup();
  }
});

it("E8: double-clicking a cell opens an edit input; pressing Enter commits it, reload shows the new text, exactly one history entry is created, and undo restores it", async () => {
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
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-slidra-cell="0,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    await editor.fill("Hello");
    await editor.press("Enter");

    await expect.poll(async () => cellMarkup(await catSlide(registry, presentationId), 0, 0)).toContain(">Hello<");
    expect(await undoCount(presentationId)).toBe(beforeUndo + 1);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await catSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("E8b: when the table is inside a group, double-clicking a cell directly enters edit mode (the same double-click both drills into the group and opens the editor), no initial click needed first", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e8b", { rows: 2, cols: 2 });
  try {
    const grouped = await registry.dispatch("element group", {
      id: presentationId, slidePath: "slides/001.svg", elementIds: [elementId, "el-caption"],
    });
    expect(grouped.ok).toBe(true);

    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-slidra-cell="0,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    await editor.fill("In group");
    await editor.press("Enter");

    await expect.poll(async () => cellMarkup(await catSlide(registry, presentationId), 0, 0)).toContain(">In group<");
  } finally {
    await cleanup();
  }
});

it("E9: double-clicking a generated cell, the input's initial value is the raw template text with {{ }} (by design, double-click edits the template row)", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e9", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    // Header(row 0) + template(row 1) + 3 generated rows (2,3,4) — (2,0) is
    // the first generated cell in column 0. A plain click first — see E8's
    // comment on why a cold dblclick on a never-selected table races
    // TableOverlay's own mount effect.
    await slideFrame.locator('[data-slidra-cell="2,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-slidra-cell="2,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    expect(await editor.inputValue()).toBe("{{ Product }}");
    // Drawn over the generated cell the author double-clicked — the template
    // row it edits is display:none and has no rect (was: a 12×12 input at
    // the slide's top-left corner, read as "cannot edit" in manual review).
    const clicked = await slideFrame.locator('[data-slidra-cell="2,0"]').boundingBox();
    const editorBox = await editor.boundingBox();
    expect(editorBox!.width).toBeGreaterThan(40);
    expect(Math.abs(editorBox!.y - clicked!.y)).toBeLessThan(4);
  } finally {
    await cleanup();
  }
});

// Tab used to have no handler at all inside the cell
// editor's <input>, so it fell through to the browser default — focus
// jumped clean out of the table to the dock's hand-tool button, and
// whatever the user typed next went nowhere. This proves Tab now commits
// the current cell, moves editing to the next one, and — critically —
// keeps focus on the SAME <input> element the whole time (no
// blur-then-remount cycle), so typing can continue immediately.
it("F-09: pressing Tab while editing a cell keeps focus on the same input.table-cell-editor and moves it to the next cell; both cells can be written to", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("f9", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-slidra-cell="0,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    const editorHandle = await editor.elementHandle();
    await editor.fill("A1");
    const leftBeforeTab = await editor.evaluate((el) => (el as HTMLElement).style.left);

    await editor.press("Tab");

    // No remount: it's the same DOM node, still document.activeElement.
    expect(await editorHandle!.evaluate((el) => el === document.activeElement)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("INPUT");
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className))
      .toContain("table-cell-editor");
    // After Tab the editor has moved to the next cell: rect's left changed.
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

// Regression check: when Tab lands on a generated cell, the edit box's
// initial value must be the same column's template-row text — the same
// contract as E9's dblclick path — because `editing.row` has already been
// resolved to the template row by `nextTableTabCell`, so that's what gets
// written back. If the initial value were the generated cell's own
// computed value instead, any commit (Enter/blur/another Tab) would
// overwrite the `{{ }}` template expression with that literal value,
// destroying the whole column's data binding on the spot.
it("F-09b: Tab landing on a generated cell has an input initial value of the same column's template text, and committing does not overwrite the template row's {{ }}", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("f9b", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-slidra-cell="2,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-slidra-cell="2,0"]').dblclick();
    const editor = page.locator("input.table-cell-editor");
    await expect.poll(() => editor.count()).toBe(1);
    expect(await editor.inputValue()).toBe("{{ Product }}");

    await editor.press("Tab");

    expect(await editor.inputValue()).toBe("{{ Sales }}");

    await editor.press("Enter");
    await expect
      .poll(async () => cellMarkup(await catSlide(registry, presentationId), 1, 1))
      .toContain("{{ Sales }}");
  } finally {
    await cleanup();
  }
});

it("E10: dragging a column-boundary handle changes the width live during the drag; releasing produces exactly one history entry, and undo restores it", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e10", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();

    const handle = page.locator(".table-col-handle").first();
    await expect.poll(() => handle.count()).toBe(1);
    const box = await handle.boundingBox();
    if (!box) throw new Error("could not measure the column-boundary handle's bounding box");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    const beforeUndo = await undoCount(presentationId);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 60, startY, { steps: 5 });

    const liveWidth = Number(await slideFrame.locator('[data-slidra-cell="0,0"] rect').getAttribute("width"));
    expect(liveWidth).toBeGreaterThan(200); // default column width is 160; +60px drag should read well above it mid-drag

    await page.mouse.up();
    await page.waitForTimeout(150);

    expect(await undoCount(presentationId)).toBe(beforeUndo + 1);
    const svg = await catSlide(registry, presentationId);
    const cols = /data-slidra-cols="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
    expect(cols[0]).toBeGreaterThan(200);
    expect(cols[0]).toBeLessThan(400); // a 60px drag must not also swallow the well's left offset (was 160 -> ~900)
    expect(cols[0] + cols[1]).toBeCloseTo(320, 3); // the boundary moved: the right column absorbed the difference

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(Number(/data-slidra-cols="([^"]+)"/.exec(await catSlide(registry, presentationId))![1].split(" ")[0])).toBe(160);
  } finally {
    await cleanup();
  }
});

it("E11: right-clicking a cell shows a menu (Edit/Bold/insert row-column/Merge/delete row-column/Clear); clicking Merge sets the top-left cell's span to 2,2 and removes the other three cells", async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e11", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");

    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    await slideFrame.locator('[data-slidra-cell="1,1"]').click({ modifiers: ["Shift"] });
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);

    await slideFrame.locator('[data-slidra-cell="0,0"]').click({ button: "right" });
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
      return (svg.match(/data-slidra-cell="/g) ?? []).length;
    }).toBe(1);
    const svg = await catSlide(registry, presentationId);
    expect(cellMarkup(svg, 0, 0)).toContain('data-slidra-span="2,2"');
  } finally {
    await cleanup();
  }
});

it("E12: selecting the table shows table-section under the right panel's Style › Object; clicking a theme changes the theme after reload; clicking Refresh on a bound table makes the generated count match the CSV", async () => {
  const { server, registry, presentationId, elementId, cleanup } = await newTableDeck("e12", { rows: 2, cols: 2 });
  try {
    await bindToSalesCsv(registry, presentationId, elementId, 1);
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();

    await page.locator("#side-panel-tab-style").click();
    const section = page.locator(".table-section");
    await expect.poll(() => section.isVisible()).toBe(true);

    await section.locator(".table-section-theme", { hasText: "Light" }).click();
    await expect.poll(() => catSlide(registry, presentationId)).toContain('data-slidra-theme="light"');

    const refreshButton = section.locator(".table-section-refresh");
    await expect.poll(() => refreshButton.count()).toBe(1);
    await refreshButton.click();
    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return (svg.match(/data-slidra-generated="1"/g) ?? []).length;
    }).toBe(6);
  } finally {
    await cleanup();
  }
});

it('E12b: clicking a cell shows table-section-cell; clicking align center gives that cell data-slidra-align="center" after reload; pressing Esc to leave the range makes it disappear', async () => {
  const { server, registry, presentationId, cleanup } = await newTableDeck("e12b", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await page.locator("#side-panel-tab-style").click();

    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    const cellSection = page.locator(".table-section-cell");
    await expect.poll(() => cellSection.count()).toBe(1);

    await cellSection.locator('.table-section-align[data-align="center"]').click();
    await expect.poll(async () => {
      const svg = await catSlide(registry, presentationId);
      return cellMarkup(svg, 0, 0).includes('data-slidra-align="center"');
    }).toBe(true);

    await page.keyboard.press("Escape");
    await expect.poll(() => cellSection.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("E13: selecting the table shows the four corner resize handles and the rotate handle (the table scales via its container transform); text-box width handles are not shown", async () => {
  const { server, cleanup } = await newTableDeck("e13", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();

    for (const name of ["nw", "ne", "sw", "se", "rotate"]) {
      const handle = slideFrame.locator(`[data-slidra-handle="${name}"]`);
      const display = await handle.evaluate((el) => getComputedStyle(el).display);
      expect(display, name).not.toBe("none");
    }
    for (const name of ["width-left", "width-right"]) {
      const handle = slideFrame.locator(`[data-slidra-handle="${name}"]`);
      const display = await handle.evaluate((el) => getComputedStyle(el).display);
      expect(display, name).toBe("none");
    }
  } finally {
    await cleanup();
  }
});

// Header rect fill/fill-opacity per theme (`theme.ts`'s
// `THEMES.<name>.head` — not exported from core's public barrel, so these
// are the literal values read directly off that source).
const HEADER_PAINT: Record<"dark" | "light" | "zebra", { fill: string; fillOpacity: string | null }> = {
  dark: { fill: "#ffffff", fillOpacity: "0.06" },
  light: { fill: "#f5f1ef", fillOpacity: null },
  zebra: { fill: "#ffffff", fillOpacity: "0.08" },
};

it("F1: the table-panel insert panel's cell count and enabled state", async () => {
  const { server, cleanup } = await startServerFor({ deckDir, prefix: "f1" });
  try {
    const page = await openPage(server);
    await page.getByRole("button", { name: "Table" }).click();
    const panel = page.locator(".table-panel");
    const cells = panel.locator(".table-panel-cell");
    expect(await cells.count()).toBe(48);
    expect(await cells.first().isEnabled()).toBe(true);
  } finally {
    await cleanup();
  }
});

// F2's fixed text (3×3, row 0 is the header).
const F2_TEXT: Record<string, string> = {
  "0,0": "Product",
  "0,1": "Region",
  "0,2": "Sales",
  "1,0": "Alpha",
  "1,1": "North",
  "1,2": "120",
  "2,0": "Beta",
  "2,1": "South",
  "2,2": "340",
};

for (const theme of ["dark", "light", "zebra"] as const) {
  it(`F2: theme-${theme}'s header fill color and text`, async () => {
    const { registry, presentationId, elementId, cleanup } = await newTableDeck(`f2-${theme}`, { rows: 3, cols: 3, theme });
    try {
      for (const [addr, text] of Object.entries(F2_TEXT)) {
        const [row, col] = addr.split(",").map(Number);
        await registry.dispatch("table cell set", { id: presentationId, slidePath: SLIDE_PATH, elementId, row, col, text });
      }

      const svg = await catSlide(registry, presentationId);
      expect(svg).toContain(`data-slidra-theme="${theme}"`);
      const headerCell = cellMarkup(svg, 0, 0);
      const paint = HEADER_PAINT[theme];
      expect(headerCell).toContain(`fill="${paint.fill}"`);
      if (paint.fillOpacity !== null) expect(headerCell).toContain(`fill-opacity="${paint.fillOpacity}"`);
      else expect(headerCell).not.toContain("fill-opacity");
      expect(headerCell).toContain(">Product<");
    } finally {
      await cleanup();
    }
  });
}

it("F3: cell-range selection box geometry and the status bar boundary", async () => {
  const { server, cleanup } = await newTableDeck("f3", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    await slideFrame.locator('[data-slidra-cell="1,1"]').click({ modifiers: ["Shift"] });

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
      ].map(([addr]) => slideFrame.locator(`[data-slidra-cell="${addr}"] rect`).boundingBox()),
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
  } finally {
    await cleanup();
  }
});

it("F4: cell-menu right-click menu's item count and enabled state", async () => {
  const { server, cleanup } = await newTableDeck("f4", { rows: 2, cols: 2 });
  try {
    const page = await openPage(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    // A plain click first — same "let TableOverlay's own subscription
    // settle before the interaction that needs it" reasoning as E8/E9's
    // dblclick fix; a cold right-click on a never-selected table races the
    // component's mount effect the same way a cold dblclick does.
    await slideFrame.locator('[data-slidra-cell="0,0"]').click();
    await expect.poll(() => page.locator(".table-range-box").count()).toBe(1);
    await slideFrame.locator('[data-slidra-cell="0,0"]').click({ button: "right" });

    const menu = page.locator('[data-testid="table-cell-menu"]');
    await expect.poll(() => menu.count()).toBe(1);
    const items = menu.locator(".table-cell-menu-item");
    expect(await items.count()).toBe(9); // 2×2 selection: no Merge/Unmerge (single cell) — Edit/Bold/×4 insert/Delete row/Delete col/Clear
    for (const text of await items.allTextContents()) {
      expect(await items.filter({ hasText: text }).first().isEnabled()).toBe(true);
    }
  } finally {
    await cleanup();
  }
});
