import { mkdtemp, mkdir, rm, writeFile, readFile as rf } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import { parseArgv } from "../src/argv.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `table create / cell set / cell style set / merge / col width / col
 * insert / col delete / row insert / row delete / theme set / header set /
 * bind / refresh / set` (E2.T14, #203), driven end-to-end through the CLI's
 * own command registry — same pattern as `packages/cli/test/chart.test.ts`.
 */

let coMotionHome: string;
let comotDir: string;
let sourceDir: string;
let registry: CommandRegistry;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  sourceDir = await mkdtemp(path.join(tmpdir(), "co-motion-sources-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(sourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function readSlide(id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

async function openFreshPresentation(): Promise<{ id: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "table 測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const converted = await registry.dispatch("convert", { id });
  expect(converted.ok).toBe(true);
  return { id };
}

async function createTable(id: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await registry.dispatch<{ elementId: string }>("table create", {
    id,
    slidePath: "slides/001.svg",
    rows: 3,
    cols: 3,
    x: 100,
    y: 100,
    ...overrides,
  });
  expect(result.ok).toBe(true);
  return result.data!.elementId;
}

/** Writes a file directly into a presentation's real work directory — needed for `table bind`'s `--source` (a virtual path already inside the deck). */
async function writeRealAssetFile(id: string, virtualPath: string, content: string): Promise<void> {
  const registryRaw = await rf(path.join(coMotionHome, "projects.json"), "utf-8");
  const workDir = (JSON.parse(registryRaw) as Record<string, { workDir: string }>)[id].workDir;
  const destPath = path.join(workDir, ...virtualPath.split("/"));
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, content, "utf-8");
}

describe("table create", () => {
  it("寫入 data-comot-type=table 與正確的 cols/cell 數量", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    const svg = await readSlide(id);
    expect(svg).toContain('data-comot-type="table"');
    expect(svg).toContain(`id="${elementId}"`);
    expect((svg.match(/data-comot-cell="/g) ?? []).length).toBe(9);
  });

  it("--theme/--header 都生效", async () => {
    const { id } = await openFreshPresentation();
    await createTable(id, { theme: "light", header: false });
    const svg = await readSlide(id);
    expect(svg).toContain('data-comot-theme="light"');
    expect(svg).not.toContain("data-comot-header");
  });

  it("--rows/--cols 不合法時失敗", async () => {
    const { id } = await openFreshPresentation();
    const result = await registry.dispatch("table create", { id, slidePath: "slides/001.svg", rows: 0, cols: 3, x: 0, y: 0 });
    expect(result.ok).toBe(false);
  });
});

describe("table cell set / cell style set", () => {
  it("設定儲存格文字", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    await registry.dispatch("table cell set", { id, slidePath: "slides/001.svg", elementId, row: 0, col: 0, text: "指標" });
    expect(await readSlide(id)).toContain("指標");
  });

  it("設定儲存格範圍的樣式（align/fill/text-fill/font-weight）", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    const result = await registry.dispatch("table cell style set", {
      id, slidePath: "slides/001.svg", elementId, row: 0, col: 0, rowEnd: 1, colEnd: 1, attr: "fill", value: "#123456",
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('fill="#123456"');
  });

  it("A4/A5-style：不合法的 font-weight 報錯", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    const result = await registry.dispatch("table cell style set", {
      id, slidePath: "slides/001.svg", elementId, row: 0, col: 0, attr: "font-weight", value: "450",
    });
    expect(result.ok).toBe(false);
  });
});

describe("table merge / col / row", () => {
  it("合併儲存格產生 data-comot-span", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    await registry.dispatch("table merge", { id, slidePath: "slides/001.svg", elementId, row: 0, col: 0, rowSpan: 2, colSpan: 2 });
    expect(await readSlide(id)).toContain('data-comot-span="2,2"');
  });

  it("欄寬設定", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id, { colWidth: 100 });
    await registry.dispatch("table col width", { id, slidePath: "slides/001.svg", elementId, col: 1, width: 240 });
    expect(await readSlide(id)).toContain('data-comot-cols="100 240 100"');
  });

  it("插入與刪除欄", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    await registry.dispatch("table col insert", { id, slidePath: "slides/001.svg", elementId, at: 1 });
    expect((await readSlide(id)).match(/data-comot-cols="([^"]+)"/)![1].split(" ").length).toBe(4);
    await registry.dispatch("table col delete", { id, slidePath: "slides/001.svg", elementId, at: 0 });
    expect((await readSlide(id)).match(/data-comot-cols="([^"]+)"/)![1].split(" ").length).toBe(3);
  });

  it("插入與刪除列", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    await registry.dispatch("table row insert", { id, slidePath: "slides/001.svg", elementId, at: 1 });
    expect((await readSlide(id)).match(/data-comot-rows="([^"]+)"/)![1].split(" ").length).toBe(4);
    await registry.dispatch("table row delete", { id, slidePath: "slides/001.svg", elementId, at: 0 });
    expect((await readSlide(id)).match(/data-comot-rows="([^"]+)"/)![1].split(" ").length).toBe(3);
  });
});

describe("table theme set / header set", () => {
  it("切換主題", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    await registry.dispatch("table theme set", { id, slidePath: "slides/001.svg", elementId, theme: "zebra" });
    expect(await readSlide(id)).toContain('data-comot-theme="zebra"');
  });

  it("切換表頭", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id, { header: true });
    await registry.dispatch("table header set", { id, slidePath: "slides/001.svg", elementId, header: false });
    expect(await readSlide(id)).not.toContain("data-comot-header");
  });
});

describe("table bind / refresh", () => {
  it("綁定並展開 CSV，refresh 後列數隨資料改變", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id, { rows: 2, cols: 1, header: true });
    await registry.dispatch("table cell set", { id, slidePath: "slides/001.svg", elementId, row: 1, col: 0, text: "{{ name }}" });
    await writeRealAssetFile(id, "assets/data/x.csv", "name\nAlice\nBob\n");
    const bindResult = await registry.dispatch("table bind", { id, slidePath: "slides/001.svg", elementId, source: "assets/data/x.csv" });
    expect(bindResult.ok).toBe(true);
    expect(await readSlide(id)).toContain("Alice");

    await writeRealAssetFile(id, "assets/data/x.csv", "name\nAlice\nBob\nCarl\n");
    await registry.dispatch("table refresh", { id, slidePath: "slides/001.svg", elementId });
    expect(await readSlide(id)).toContain("Carl");
  });

  it("refresh 在未綁定的表格上報錯", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    const result = await registry.dispatch("table refresh", { id, slidePath: "slides/001.svg", elementId });
    expect(result.ok).toBe(false);
  });
});

describe("table set --from / --markdown", () => {
  it("--from 用 CSV 整表取代", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id, { rows: 1, cols: 1 });
    await writeRealAssetFile(id, "assets/data/x.csv", "a,b\n1,2\n");
    const result = await registry.dispatch("table set", { id, slidePath: "slides/001.svg", elementId, from: "assets/data/x.csv" });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain("1");
    expect(svg).not.toContain("comot:source");
  });

  it("--markdown 用字面文字整表取代", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id, { rows: 1, cols: 1 });
    const markdown = ["| a | b |", "|---|---|", "| x | y |"].join("\n");
    const result = await registry.dispatch("table set", { id, slidePath: "slides/001.svg", elementId, markdown });
    expect(result.ok).toBe(true);
    expect(await readSlide(id)).toContain("x");
  });
});

describe("表格容器與其他命令族的互動 (A4/A5)", () => {
  it("element style set / group / ungroup 對表格報錯；scale / resize 走容器 transform；move/delete 不受影響", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createTable(id);
    const before = await readSlide(id);

    const styleResult = await registry.dispatch("element style set", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], attr: "fill", value: "#000000",
    });
    expect(styleResult.ok).toBe(false);
    expect(styleResult.message).toContain("表格");

    const ungroupResult = await registry.dispatch("element ungroup", {
      id, slidePath: "slides/001.svg", elementIds: [elementId],
    });
    expect(ungroupResult.ok).toBe(false);

    expect(await readSlide(id)).toBe(before);

    const colsBefore = /data-comot-cols="([^"]+)"/.exec(before)![1];
    const scaleResult = await registry.dispatch("element scale", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], factor: 2,
    });
    expect(scaleResult.ok).toBe(true);
    const scaled = await readSlide(id);
    expect(scaled).toMatch(/scale\(2 2\)/);
    expect(/data-comot-cols="([^"]+)"/.exec(scaled)![1]).toBe(colsBefore);

    const resizeResult = await registry.dispatch("element resize", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], width: 100, height: 100, anchor: "nw",
    });
    expect(resizeResult.ok).toBe(true);

    const moveResult = await registry.dispatch("element move", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], dx: 5, dy: 5,
    });
    expect(moveResult.ok).toBe(true);

    const deleteResult = await registry.dispatch("element delete", {
      id, slidePath: "slides/001.svg", elementIds: [elementId],
    });
    expect(deleteResult.ok).toBe(true);
    expect(await readSlide(id)).not.toContain(elementId);
  });

  it("A6: 14 條 table 命令全部在 registry 裡", () => {
    const names = [
      "table create", "table cell set", "table cell style set", "table merge",
      "table col width", "table col insert", "table col delete",
      "table row insert", "table row delete", "table theme set", "table header set",
      "table bind", "table refresh", "table set",
    ];
    for (const name of names) {
      expect(() => registry.dispatch(name, {})).not.toThrow(/未知的命令/);
    }
  });
});

describe("argv: table", () => {
  it("table create 解析所有選填旗標", () => {
    const parsed = parseArgv([
      "table", "create", "pres-1", "slides/001.svg",
      "--rows", "3", "--cols", "4", "--x", "10", "--y", "20",
      "--col-width", "150", "--theme", "light", "--header", "false",
    ]);
    expect(parsed).toEqual({
      name: "table create",
      input: { id: "pres-1", slidePath: "slides/001.svg", rows: 3, cols: 4, x: 10, y: 20, colWidth: 150, theme: "light", header: false },
    });
  });

  it("table cell set 解析 --row/--col/--text", () => {
    const parsed = parseArgv(["table", "cell", "set", "pres-1", "slides/001.svg", "el-a", "--row", "0", "--col", "1", "--text", "hi"]);
    expect(parsed).toEqual({
      name: "table cell set",
      input: { id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a", row: 0, col: 1, text: "hi" },
    });
  });

  it("table cell style set 解析範圍與尾端 attr/value", () => {
    const parsed = parseArgv([
      "table", "cell", "style", "set", "pres-1", "slides/001.svg", "el-a",
      "--row", "0", "--col", "0", "--row-end", "1", "--col-end", "1", "align", "center",
    ]);
    expect(parsed).toEqual({
      name: "table cell style set",
      input: { id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a", row: 0, col: 0, rowEnd: 1, colEnd: 1, attr: "align", value: "center" },
    });
  });

  it("table merge 解析 --unmerge 布林旗標", () => {
    const parsed = parseArgv(["table", "merge", "pres-1", "slides/001.svg", "el-a", "--row", "0", "--col", "0", "--unmerge"]);
    expect(parsed).toEqual({
      name: "table merge",
      input: { id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a", row: 0, col: 0, rowSpan: undefined, colSpan: undefined, unmerge: true },
    });
  });

  it("table theme set / header set 解析位置參數", () => {
    expect(parseArgv(["table", "theme", "set", "pres-1", "slides/001.svg", "el-a", "zebra"]).input).toMatchObject({ theme: "zebra" });
    expect(parseArgv(["table", "header", "set", "pres-1", "slides/001.svg", "el-a", "true"]).input).toMatchObject({ header: true });
    expect(() => parseArgv(["table", "header", "set", "pres-1", "slides/001.svg", "el-a", "maybe"])).toThrow(/不支援的值/);
  });

  it("table bind 解析 --source/--template-row", () => {
    const parsed = parseArgv(["table", "bind", "pres-1", "slides/001.svg", "el-a", "--source", "assets/data/x.csv", "--template-row", "2"]);
    expect(parsed).toEqual({
      name: "table bind",
      input: { id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a", source: "assets/data/x.csv", templateRow: 2 },
    });
  });

  it("table set 三種資料來源必須恰好給一種", () => {
    expect(() => parseArgv(["table", "set", "pres-1", "slides/001.svg", "el-a"])).toThrow(/恰好提供一種資料來源/);
    expect(() =>
      parseArgv(["table", "set", "pres-1", "slides/001.svg", "el-a", "--from", "a.csv", "--markdown", "x"]),
    ).toThrow(/恰好提供一種資料來源/);
  });

  it("未知子命令拋錯", () => {
    expect(() => parseArgv(["table", "nope"])).toThrow(/未知的子命令：table nope/);
  });
});
