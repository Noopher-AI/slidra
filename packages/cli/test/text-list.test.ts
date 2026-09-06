import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `text list set` (NOOP-65 §4.3, 決定 E), driven purely through the CLI's
 * own command registry against a real temp presentation — same seam and
 * fixture pattern as `text-style.test.ts`.
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

async function openFreshPresentation(): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "列表測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function readSlide(id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

async function addBox(id: string, text: string): Promise<string> {
  const result = await registry.dispatch<{ elementId: string }>("textbox add", {
    id,
    slidePath: "slides/001.svg",
    x: 0,
    y: 0,
    width: 400,
    text,
  });
  return result.data!.elementId;
}

describe("text list set (NOOP-65 §4.3, 決定 E)", () => {
  it("bullet on one paragraph adds a marker <text> with a • glyph, and indents that paragraph's content", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "一\n二");

    const result = await registry.dispatch<{ paragraphs: number }>("text list set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      paragraph: 0,
      kind: "bullet",
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ paragraphs: 2 });
    const svg = await readSlide(id);
    expect(svg).toContain('data-comot-list="bullet none"');
    expect(svg).toMatch(/<text data-comot-list-marker="true"[^>]*><tspan x="0" y="[^"]+">•<\/tspan><\/text>/);
    // The indented paragraph's own content tspan no longer starts at x=0.
    const firstTspanX = /<tspan x="([-0-9.]+)"[^>]*data-comot-break="1"/.exec(svg)?.[1];
    expect(Number(firstTspanX)).toBeGreaterThan(0);
  });

  it("number on every paragraph produces sequential 1./2./3., resetting after a non-number paragraph", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "a\nb\nc");

    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 0, kind: "number" });
    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 1, kind: "bullet" });
    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 2, kind: "number" });

    const svg = await readSlide(id);
    expect(svg).toContain('data-comot-list="number bullet number"');
    const markerText = /<text data-comot-list-marker="true"[^>]*>([\s\S]*?)<\/text>/.exec(svg)![1];
    const glyphs = Array.from(markerText.matchAll(/>([^<]*)<\/tspan>/g)).map((m) => m[1]);
    // Paragraph 2's "number" streak starts over at 1 because paragraph 1 was bullet.
    expect(glyphs).toEqual(["1.", "•", "1."]);
  });

  it("kind none on a paragraph that already has no list is a no-op — no write, no undo step", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "純文字");
    const before = await readSlide(id);

    const result = await registry.dispatch<{ paragraphs: number }>("text list set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      paragraph: 0,
      kind: "none",
    });

    expect(result.ok).toBe(true);
    expect(await readSlide(id)).toBe(before);
    // If the no-op had (wrongly) staged its own undo snapshot, one undo()
    // would revert IT (a no-op, so content stays the same) and the box
    // would still be there; a real "occupies no undo step" no-op means this
    // one undo() instead reverts the earlier `textbox add`, removing the box.
    await registry.dispatch("undo", { id });
    expect(await readSlide(id)).not.toContain(elementId);
  });

  it("setting every paragraph back to none removes the marker <text> and the data-comot-list attribute entirely", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "一");
    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 0, kind: "bullet" });
    expect(await readSlide(id)).toContain("data-comot-list-marker");

    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 0, kind: "none" });

    const svg = await readSlide(id);
    expect(svg).not.toContain("data-comot-list-marker");
    expect(svg).not.toContain("data-comot-list=");
  });

  it("textbox width re-wrap carries an existing list forward: marker count and glyphs survive a width change", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "第一段落文字比較長\n第二段");
    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 0, kind: "bullet" });
    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 1, kind: "bullet" });

    await registry.dispatch("textbox width", { id, slidePath: "slides/001.svg", elementId, width: 120 });

    const svg = await readSlide(id);
    expect(svg).toContain('data-comot-list="bullet bullet"');
    const markerCount = (svg.match(/<tspan x="0" y="[^"]+">•<\/tspan>/g) ?? []).length;
    expect(markerCount).toBe(2);
  });

  it("rejects a paragraph index at or past the paragraph count", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "只有一段");

    const result = await registry.dispatch("text list set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      paragraph: 1,
      kind: "bullet",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("第 1 段不存在，這個文字框有 1 段");
  });

  it("undo after text list set restores the previous SVG byte for byte", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "一");
    const before = await readSlide(id);

    await registry.dispatch("text list set", { id, slidePath: "slides/001.svg", elementId, paragraph: 0, kind: "bullet" });
    expect(await readSlide(id)).not.toBe(before);

    await registry.dispatch("undo", { id });
    expect(await readSlide(id)).toBe(before);
  });
});
