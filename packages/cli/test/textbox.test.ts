import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `textbox add` / `textbox width` / `text set` (on a text box) / `undo`,
 * driven purely through the CLI's own command registry against a real
 * temp presentation, with the SVG read back off disk via `cat` — the seam
 * this unit's dispatch names, following `packages/cli/test/commands.test.ts`'s
 * pattern (per-test `CO_MOTION_HOME`).
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
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

async function openFreshPresentation(): Promise<{ id: string; originalSlide: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "文字框測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const slide = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return { id, originalSlide: slide.data!.content };
}

async function readSlide(id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

/** Extracts one text box container's declared width and its tspans, straight out of the raw SVG text. */
function extractTextBox(svg: string, elementId: string): { width: string; tspans: { y: string; text: string }[] } {
  const containerPattern = new RegExp(
    `<g id="${elementId}"[^>]*data-comot-text-width="([^"]*)"[^>]*>(<text[\\s\\S]*?</text>)</g>`,
  );
  const containerMatch = containerPattern.exec(svg);
  if (!containerMatch) {
    throw new Error(`test helper: text box ${elementId} not found in: ${svg}`);
  }
  const [, width, textElement] = containerMatch;
  // No whitespace anywhere between <text> and the first tspan, or between
  // tspans (xml:space="preserve" makes indentation rendered content) — a
  // strict full match, not a loose scan, is what actually proves this.
  const strict = /^<text[^>]*>(?:<tspan x="0" y="[^"]+">[^<]*<\/tspan>)*<\/text>$/;
  expect(textElement).toMatch(strict);
  const tspans = Array.from(textElement.matchAll(/<tspan x="0" y="([^"]+)">([^<]*)<\/tspan>/g)).map((m) => ({
    y: m[1],
    text: m[2],
  }));
  return { width, tspans };
}

const SAMPLE = "文字框有寬度，文字寫滿就折到下一行。";

describe("textbox add / textbox width / text set / undo (#76)", () => {
  it("textbox add writes a container with data-comot-text-width and N ascending-y tspans", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch<{ elementId: string; lines: number }>("textbox add", {
      id,
      slidePath: "slides/001.svg",
      x: 100,
      y: 200,
      width: 440,
      text: SAMPLE,
      fontSize: 40,
      fontFamily: "Noto Sans TC",
    });

    expect(result.ok).toBe(true);
    expect(result.data!.lines).toBe(2);
    const elementId = result.data!.elementId;

    const svg = await readSlide(id);
    const box = extractTextBox(svg, elementId);
    expect(box.width).toBe("440");
    expect(box.tspans).toHaveLength(2);
    expect(box.tspans.map((t) => t.text)).toEqual(["文字框有寬度，文字寫滿", "就折到下一行。"]);
    // Ascending y.
    expect(Number(box.tspans[0].y)).toBeLessThan(Number(box.tspans[1].y));
    expect(svg).toContain('transform="translate(100 200)"');
  });

  it("textbox width with a smaller width yields more tspans", async () => {
    const { id } = await openFreshPresentation();
    const added = await registry.dispatch<{ elementId: string; lines: number }>("textbox add", {
      id,
      slidePath: "slides/001.svg",
      x: 0,
      y: 0,
      width: 440,
      text: SAMPLE,
      fontSize: 40,
      fontFamily: "Noto Sans TC",
    });
    const elementId = added.data!.elementId;
    expect(added.data!.lines).toBe(2);

    const narrowed = await registry.dispatch<{ lines: number }>("textbox width", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      width: 280,
    });

    expect(narrowed.ok).toBe(true);
    expect(narrowed.data!.lines).toBe(3);
    expect(narrowed.data!.lines).toBeGreaterThan(added.data!.lines);

    const svg = await readSlide(id);
    const box = extractTextBox(svg, elementId);
    expect(box.width).toBe("280");
    expect(box.tspans).toHaveLength(3);
    // Concatenating the tspans reproduces the original text: resizing
    // re-wraps, it never loses or duplicates a character.
    expect(box.tspans.map((t) => t.text).join("")).toBe(SAMPLE);
  });

  it("text set on a text box re-wraps its content at the box's existing width", async () => {
    const { id } = await openFreshPresentation();
    const added = await registry.dispatch<{ elementId: string }>("textbox add", {
      id,
      slidePath: "slides/001.svg",
      x: 0,
      y: 0,
      width: 280,
      text: SAMPLE,
      fontSize: 40,
      fontFamily: "Noto Sans TC",
    });
    const elementId = added.data!.elementId;
    const before = extractTextBox(await readSlide(id), elementId);
    expect(before.tspans).toHaveLength(3);

    const newText = SAMPLE + SAMPLE; // longer text, same declared width -> more lines
    const setResult = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText,
    });
    expect(setResult.ok).toBe(true);

    const svg = await readSlide(id);
    const after = extractTextBox(svg, elementId);
    expect(after.width).toBe("280"); // text set never changes the declared width
    expect(after.tspans.length).toBeGreaterThan(before.tspans.length);
    expect(after.tspans.map((t) => t.text).join("")).toBe(newText);
  });

  it("undo after textbox add, textbox width and text set each restores the previous SVG byte for byte", async () => {
    const { id, originalSlide } = await openFreshPresentation();

    const added = await registry.dispatch<{ elementId: string }>("textbox add", {
      id,
      slidePath: "slides/001.svg",
      x: 0,
      y: 0,
      width: 440,
      text: SAMPLE,
      fontSize: 40,
      fontFamily: "Noto Sans TC",
    });
    const elementId = added.data!.elementId;
    const afterAdd = await readSlide(id);
    expect(afterAdd).not.toBe(originalSlide);

    await registry.dispatch("textbox width", { id, slidePath: "slides/001.svg", elementId, width: 280 });
    const afterWidth = await readSlide(id);
    expect(afterWidth).not.toBe(afterAdd);

    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: SAMPLE + SAMPLE });
    const afterTextSet = await readSlide(id);
    expect(afterTextSet).not.toBe(afterWidth);

    const undoTextSet = await registry.dispatch("undo", { id });
    expect(undoTextSet.ok).toBe(true);
    expect(await readSlide(id)).toBe(afterWidth);

    const undoWidth = await registry.dispatch("undo", { id });
    expect(undoWidth.ok).toBe(true);
    expect(await readSlide(id)).toBe(afterAdd);

    const undoAdd = await registry.dispatch("undo", { id });
    expect(undoAdd.ok).toBe(true);
    expect(await readSlide(id)).toBe(originalSlide);
  });
});
