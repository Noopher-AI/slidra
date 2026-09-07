import { mkdtemp, rm, writeFile, readFile as rf } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import { parseArgv } from "../src/argv.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `chart create / data set / type set / palette set / axis set / stack
 * set / legend set / option set` (E2.T12, #204), driven end-to-end through
 * the CLI's own command registry — same pattern as `packages/cli/test/effect.test.ts`.
 * Public boundary under test: dispatch a command, read the slide bytes back
 * through `cat`.
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
  await registry.dispatch("new", { path: comotPath, name: "chart 測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const converted = await registry.dispatch("convert", { id });
  expect(converted.ok).toBe(true);
  return { id };
}

async function createChart(id: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await registry.dispatch<{ elementId: string }>("chart create", {
    id,
    slidePath: "slides/001.svg",
    ...overrides,
  });
  expect(result.ok).toBe(true);
  return result.data!.elementId;
}

/** Writes a file directly into a presentation's real work directory — the same test-only shortcut `asset-import.test.ts`'s `readRealAssetBytes` uses, needed here because `--csv-asset` reads a file already inside the deck, and `asset import` only ever accepts media (plan §0.1 G3). */
async function writeRealAssetFile(id: string, virtualPath: string, content: string): Promise<void> {
  const registryRaw = await rf(path.join(coMotionHome, "projects.json"), "utf-8");
  const workDir = (JSON.parse(registryRaw) as Record<string, { workDir: string }>)[id].workDir;
  const destPath = path.join(workDir, ...virtualPath.split("/"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, content, "utf-8");
}

describe("chart create", () => {
  it("預設值：bar、1 系列、6 類別、brand 調色盤，容器帶 data-comot-type=chart", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    const svg = await readSlide(id);
    expect(svg).toContain(`data-comot-type="chart"`);
    expect(svg).toContain(`id="${elementId}"`);
    expect(svg).toContain('type="bar"');
    expect(svg).toContain('palette="brand"');
    expect((svg.match(/<comot:series/g) ?? []).length).toBe(1);
    expect(svg).toMatch(/<comot:categories values="C1,C2,C3,C4,C5,C6"\/>/);
  });

  it("--type/--series/--categories/--palette 都生效", async () => {
    const { id } = await openFreshPresentation();
    await createChart(id, { type: "line", seriesCount: 3, categoriesCount: 4, palette: "cool" });
    const svg = await readSlide(id);
    expect(svg).toContain('type="line"');
    expect(svg).toContain('palette="cool"');
    expect((svg.match(/<comot:series/g) ?? []).length).toBe(3);
    expect(svg).toMatch(/<comot:categories values="C1,C2,C3,C4"\/>/);
  });

  it("--x/--y/--width/--height 都生效", async () => {
    const { id } = await openFreshPresentation();
    await createChart(id, { x: 10, y: 20, width: 300, height: 200 });
    const svg = await readSlide(id);
    expect(svg).toContain('transform="translate(10 20)"');
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="200"');
  });

  it("--series 超過上限時失敗", async () => {
    const { id } = await openFreshPresentation();
    const result = await registry.dispatch("chart create", {
      id, slidePath: "slides/001.svg", seriesCount: 5,
    });
    expect(result.ok).toBe(false);
  });
});

describe("chart data set", () => {
  it("--categories/--series 整份取代資料", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    const result = await registry.dispatch("chart data set", {
      id, slidePath: "slides/001.svg", elementId,
      categories: ["Q1", "Q2", "Q3"],
      series: [{ name: "Revenue", values: [120, 150, 170] }],
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('<comot:categories values="Q1,Q2,Q3"/>');
    expect(svg).toContain('name="Revenue" values="120,150,170"');
  });

  it("既有系列的 axis/color 依名稱沿用", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id, { seriesCount: 1 });
    await registry.dispatch("chart palette set", {
      id, slidePath: "slides/001.svg", elementId, palette: "brand", colors: [{ name: "Series 1", color: "#5B6DEA" }],
    });
    await registry.dispatch("chart data set", {
      id, slidePath: "slides/001.svg", elementId,
      categories: ["A", "B"], series: [{ name: "Series 1", values: [1, 2] }],
    });
    const svg = await readSlide(id);
    expect(svg).toContain('name="Series 1" values="1,2" axis="left" color="#5B6DEA"');
  });

  it("--csv：從本機路徑匯入", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    const csvPath = path.join(sourceDir, "quarterly.csv");
    await writeFile(csvPath, "Quarter,Revenue,Cost\nQ1,120,80\nQ2,150,90\n", "utf-8");
    const result = await registry.dispatch("chart data set", {
      id, slidePath: "slides/001.svg", elementId, csv: csvPath,
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('<comot:categories values="Q1,Q2"/>');
    expect(svg).toContain('name="Revenue" values="120,150"');
    expect(svg).toContain('name="Cost" values="80,90"');
  });

  it("--csv-asset：從簡報內的虛擬路徑匯入", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    await writeRealAssetFile(id, "assets/data/quarterly.csv", "Quarter,Revenue\nQ1,120\nQ2,150\n");
    const result = await registry.dispatch("chart data set", {
      id, slidePath: "slides/001.svg", elementId, csvAsset: "assets/data/quarterly.csv",
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('<comot:categories values="Q1,Q2"/>');
    expect(svg).toContain('name="Revenue" values="120,150"');
  });

  it("NOOP-159r2 FAIL 2：CSV 類別名稱含逗號時明確報錯，不寫入損壞資料（Reviewer 重現步驟）", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    const before = await readSlide(id);
    const csvPath = path.join(sourceDir, "commacat.csv");
    await writeFile(csvPath, 'Region,Revenue\n"Taipei, TW",120\n"Kaohsiung",90\n', "utf-8");
    const result = await registry.dispatch("chart data set", {
      id, slidePath: "slides/001.svg", elementId, csv: csvPath,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/逗號/);
    // Rejected before the write — the element's data is exactly what it was before the attempt, not a desynced half-write.
    expect(await readSlide(id)).toBe(before);
  });

  it("--csv 指向不存在的檔案時回報 not-found", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    const result = await registry.dispatch("chart data set", {
      id, slidePath: "slides/001.svg", elementId, csv: path.join(sourceDir, "nope.csv"),
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });
});

describe("chart type set / palette set / axis set / stack set / legend set / option set", () => {
  it("chart type set 切換類型", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    await registry.dispatch("chart type set", { id, slidePath: "slides/001.svg", elementId, type: "donut" });
    expect(await readSlide(id)).toContain('type="donut"');
  });

  it("chart type set 切到 pie 時，若目前是 stacked 就報錯", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    await registry.dispatch("chart stack set", { id, slidePath: "slides/001.svg", elementId, stacked: true });
    const result = await registry.dispatch("chart type set", { id, slidePath: "slides/001.svg", elementId, type: "pie" });
    expect(result.ok).toBe(false);
  });

  it("chart palette set 改調色盤與個別系列顏色", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    await registry.dispatch("chart palette set", {
      id, slidePath: "slides/001.svg", elementId, palette: "warm", colors: [{ name: "Series 1", color: "#123456" }],
    });
    const svg = await readSlide(id);
    expect(svg).toContain('palette="warm"');
    expect(svg).toContain('color="#123456"');
  });

  it("chart axis set 切換 dual 並指定 --right", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id, { seriesCount: 2 });
    const result = await registry.dispatch("chart axis set", {
      id, slidePath: "slides/001.svg", elementId, axes: "dual", right: ["Series 2"],
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('axes="dual"');
    expect(svg).toContain('name="Series 1" values="');
    expect(svg).toMatch(/name="Series 2"[^/]*axis="right"/);
  });

  it("chart axis set dual 但沒給 --right 時報錯", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id, { seriesCount: 2 });
    const result = await registry.dispatch("chart axis set", { id, slidePath: "slides/001.svg", elementId, axes: "dual", right: [] });
    expect(result.ok).toBe(false);
  });

  it("chart stack set on/off", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    await registry.dispatch("chart stack set", { id, slidePath: "slides/001.svg", elementId, stacked: true });
    expect(await readSlide(id)).toContain('stacked="true"');
    await registry.dispatch("chart stack set", { id, slidePath: "slides/001.svg", elementId, stacked: false });
    expect(await readSlide(id)).toContain('stacked="false"');
  });

  it("chart legend set", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    await registry.dispatch("chart legend set", { id, slidePath: "slides/001.svg", elementId, legend: "right" });
    expect(await readSlide(id)).toContain('legend="right"');
  });

  it("chart option set grid/labels/x-title/y-title", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    await registry.dispatch("chart option set", { id, slidePath: "slides/001.svg", elementId, key: "grid", value: "false" });
    await registry.dispatch("chart option set", { id, slidePath: "slides/001.svg", elementId, key: "labels", value: "false" });
    await registry.dispatch("chart option set", { id, slidePath: "slides/001.svg", elementId, key: "x-title", value: "Week" });
    await registry.dispatch("chart option set", { id, slidePath: "slides/001.svg", elementId, key: "y-title", value: "ms" });
    const svg = await readSlide(id);
    expect(svg).toContain('grid="false"');
    expect(svg).toContain('labels="false"');
    expect(svg).toContain('x-title="Week"');
    expect(svg).toContain('y-title="ms"');
  });
});

describe("圖表容器與其他命令族的互動 (AC-11, AC-13)", () => {
  it("AC-11: effect add 可以指向圖表容器 id", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);
    const result = await registry.dispatch("effect add", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], family: "enter", effect: "fade",
    });
    expect(result.ok).toBe(true);
    expect(await readSlide(id)).toContain("comot:effect");
  });

  it("AC-13: element style set 對圖表報錯；scale / resize 重繪成新尺寸；move/order/delete 不受影響", async () => {
    const { id } = await openFreshPresentation();
    const elementId = await createChart(id);

    const styleResult = await registry.dispatch("element style set", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], attr: "fill", value: "#000000",
    });
    expect(styleResult.ok).toBe(false);
    expect(styleResult.message).toContain("圖表");

    const scaleResult = await registry.dispatch("element scale", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], factor: 2,
    });
    expect(scaleResult.ok).toBe(true);
    const widthAfterScale = Number(/<comot:chart[^>]*\swidth="([^"]+)"/.exec(await readSlide(id))![1]);

    const resizeResult = await registry.dispatch("element resize", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], width: 100, height: 100, anchor: "nw",
    });
    expect(resizeResult.ok).toBe(true);
    const resized = await readSlide(id);
    expect(resized).toMatch(/<comot:chart[^>]*\swidth="100"[^>]*\sheight="100"/);
    expect(widthAfterScale).not.toBe(100);

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
});

describe("argv: chart", () => {
  it("chart create 解析所有選填旗標", () => {
    const parsed = parseArgv([
      "chart", "create", "pres-1", "slides/001.svg",
      "--type", "line", "--series", "2", "--categories", "4", "--palette", "cool",
      "--x", "10", "--y", "20", "--width", "300", "--height", "200",
    ]);
    expect(parsed).toEqual({
      name: "chart create",
      input: {
        id: "pres-1", slidePath: "slides/001.svg", type: "line",
        seriesCount: 2, categoriesCount: 4, palette: "cool", x: 10, y: 20, width: 300, height: 200,
      },
    });
  });

  it("chart data set 解析多個 --series（單引號在 shell 層已被剝除，argv 收到的是含空白與括號的原始字串）", () => {
    const parsed = parseArgv([
      "chart", "data", "set", "pres-1", "slides/001.svg", "el-a",
      "--categories", "W1,W2,W3",
      "--series", "TTFB (ms)=840,760,610",
      "--series", "Errors=12,9,7",
    ]);
    expect(parsed).toEqual({
      name: "chart data set",
      input: {
        id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a",
        categories: ["W1", "W2", "W3"],
        series: [
          { name: "TTFB (ms)", values: [840, 760, 610] },
          { name: "Errors", values: [12, 9, 7] },
        ],
      },
    });
  });

  it("chart data set 三種資料來源必須恰好給一種", () => {
    expect(() => parseArgv(["chart", "data", "set", "pres-1", "slides/001.svg", "el-a"])).toThrow(/恰好提供一種資料來源/);
    expect(() =>
      parseArgv(["chart", "data", "set", "pres-1", "slides/001.svg", "el-a", "--categories", "A,B", "--csv", "/tmp/x.csv"]),
    ).toThrow(/恰好提供一種資料來源/);
  });

  it("chart palette set 解析多個 --color（含 # 的單引號字串）", () => {
    const parsed = parseArgv([
      "chart", "palette", "set", "pres-1", "slides/001.svg", "el-a", "warm",
      "--color", "Errors=#5B6DEA",
    ]);
    expect(parsed).toEqual({
      name: "chart palette set",
      input: { id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a", palette: "warm", colors: [{ name: "Errors", color: "#5B6DEA" }] },
    });
  });

  it("chart axis set 解析多個 --right", () => {
    const parsed = parseArgv(["chart", "axis", "set", "pres-1", "slides/001.svg", "el-a", "dual", "--right", "Cost", "--right", "Errors"]);
    expect(parsed).toEqual({
      name: "chart axis set",
      input: { id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a", axes: "dual", right: ["Cost", "Errors"] },
    });
  });

  it("chart stack set 只接受 on/off", () => {
    expect(parseArgv(["chart", "stack", "set", "pres-1", "slides/001.svg", "el-a", "on"]).input).toMatchObject({ stacked: true });
    expect(() => parseArgv(["chart", "stack", "set", "pres-1", "slides/001.svg", "el-a", "sideways"])).toThrow(/不支援的值/);
  });

  it("chart option set 解析 key/value", () => {
    const parsed = parseArgv(["chart", "option", "set", "pres-1", "slides/001.svg", "el-a", "x-title", "Week"]);
    expect(parsed).toEqual({
      name: "chart option set",
      input: { id: "pres-1", slidePath: "slides/001.svg", elementId: "el-a", key: "x-title", value: "Week" },
    });
  });

  it("未知子命令拋錯", () => {
    expect(() => parseArgv(["chart", "nope"])).toThrow(/未知的子命令：chart nope/);
  });
});
