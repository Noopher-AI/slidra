import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createTableElement, parseFont, readTableModel, setTableCellText, type FontMetrics } from "@co-motion/core";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `table cell copy / cut / paste` ([E2.T18], soft dependency on [E2.T14]'s
 * table container shape) at the dispatch layer — this file only exercises
 * `registry.dispatch(...)`, never the handler internals, same posture as
 * `element.test.ts`/`element-group.test.ts`. Deliberately not named
 * `table.test.ts`: that name is left for [E2.T14]'s own command family.
 */

let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function readSlide(id: string, slidePath = "slides/001.svg"): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  return result.data!.content;
}

const BLANK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>';
const bundledFontPath = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@co-motion/core")),
  "assets/fonts/NotoSansTC-Presentation.ttf",
);
let fonts: Map<string, FontMetrics>;
beforeAll(async () => {
  fonts = new Map([["Noto Sans TC", parseFont(new Uint8Array(await readFile(bundledFontPath)))]]);
});

async function textAt(id: string, row: number, col: number): Promise<string> {
  return readTableModel(await readSlide(id), "tbl-1").cells.find((cell) => cell.row === row && cell.col === col)!.text;
}

/** A real [E2.T14] 2x3 table (`table create` + `table cell set` shape), cell text `r{r}c{c}`. */
async function openTablePresentation(): Promise<{ id: string }> {
  let slide = createTableElement(BLANK, "slides/001.svg", "tbl-1", { rows: 2, cols: 3, x: 100, y: 100 }, fonts);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      slide = setTableCellText(slide, "slides/001.svg", "tbl-1", r, c, `r${r}c${c}`, fonts);
    }
  }
  const { zipSync } = await import("fflate");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        name: "table clipboard fixture",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode(slide),
  });
  const comotPath = path.join(comotDir, "table.comot");
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

describe("table cell copy", () => {
  it("reads a range into TSV, row-major, never mutating the slide", async () => {
    const { id } = await openTablePresentation();
    const before = await readSlide(id);

    const result = await registry.dispatch<{ tsv: string }>("table cell copy", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", range: "0,0:1,2",
    });

    expect(result.ok).toBe(true);
    expect(result.data!.tsv).toBe("r0c0\tr0c1\tr0c2\nr1c0\tr1c1\tr1c2");
    expect(await readSlide(id)).toBe(before);
  });

  it("rejects a malformed --range", async () => {
    const { id } = await openTablePresentation();
    const result = await registry.dispatch("table cell copy", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", range: "bogus",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a range exceeding the table's actual size", async () => {
    const { id } = await openTablePresentation();
    const result = await registry.dispatch("table cell copy", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", range: "0,0:9,9",
    });
    expect(result.ok).toBe(false);
  });
});

describe("table cell cut", () => {
  it("returns the same TSV a copy would and clears the range, keeping the cells (one undo step)", async () => {
    const { id } = await openTablePresentation();

    const result = await registry.dispatch<{ tsv: string }>("table cell cut", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", range: "0,0:0,1",
    });

    expect(result.ok).toBe(true);
    expect(result.data!.tsv).toBe("r0c0\tr0c1");
    const after = await readSlide(id);
    expect(readTableModel(after, "tbl-1").cells).toHaveLength(6);
    expect(await textAt(id, 0, 0)).toBe("");
    expect(await textAt(id, 0, 2)).toBe("r0c2");

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    expect(await textAt(id, 0, 0)).toBe("r0c0");
  });
});

describe("table cell paste", () => {
  it("writes TSV content passed inline via `tsv`", async () => {
    const { id } = await openTablePresentation();

    const result = await registry.dispatch<{ cells: number }>("table cell paste", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", at: "0,0", tsv: "x\ty",
    });

    expect(result.ok).toBe(true);
    expect(result.data!.cells).toBe(2);
    expect(await textAt(id, 0, 0)).toBe("x");
    expect(await textAt(id, 0, 1)).toBe("y");
  });

  it("reads TSV content from --tsv-file when tsv is not given", async () => {
    const { id } = await openTablePresentation();
    const tsvFile = path.join(comotDir, "cells.tsv");
    await writeFile(tsvFile, "z1\tz2\tz3", "utf-8");

    const result = await registry.dispatch<{ cells: number }>("table cell paste", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", at: "1,0", tsvFile,
    });

    expect(result.ok).toBe(true);
    expect(result.data!.cells).toBe(3);
    expect(await textAt(id, 1, 1)).toBe("z2");
  });

  it("clips to the table's remaining space and reports the actual count written", async () => {
    const { id } = await openTablePresentation();

    const result = await registry.dispatch<{ cells: number }>("table cell paste", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", at: "0,0", tsv: "a\tb\tc\td",
    });

    expect(result.ok).toBe(true);
    expect(result.data!.cells).toBe(3); // clipped to the table's 3 columns
  });

  it("rejects an empty TSV, leaving the slide unchanged", async () => {
    const { id } = await openTablePresentation();
    const before = await readSlide(id);

    const result = await registry.dispatch("table cell paste", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", at: "0,0", tsv: "",
    });

    expect(result.ok).toBe(false);
    expect(await readSlide(id)).toBe(before);
  });

  it("fails when neither tsv nor tsvFile is given", async () => {
    const { id } = await openTablePresentation();
    const result = await registry.dispatch("table cell paste", {
      id, slidePath: "slides/001.svg", elementId: "tbl-1", at: "0,0",
    });
    expect(result.ok).toBe(false);
  });
});
