import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `text style set` (NOOP-65 §4.2), driven purely through the CLI's own
 * command registry against a real temp presentation, SVG read back off
 * disk via `cat` — same seam and fixture pattern as `textbox.test.ts`.
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
  await registry.dispatch("new", { path: comotPath, name: "富文字測試" });
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

describe("text style set (NOOP-65 §4.2)", () => {
  it("sets font-weight on a range, producing exactly one nested run tspan", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "Hello");

    const result = await registry.dispatch<{ runs: number }>("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      rangeStart: 1,
      rangeEnd: 3,
      fontWeight: "bold",
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ runs: 1 });
    const svg = await readSlide(id);
    expect(svg).toContain('<tspan font-weight="bold">el</tspan>');
  });

  it("sets font-style, independent of font-weight", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "Hello");

    await registry.dispatch("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      rangeStart: 0,
      rangeEnd: 5,
      fontStyle: "italic",
    });

    const svg = await readSlide(id);
    expect(svg).toContain('<tspan font-style="italic">Hello</tspan>');
  });

  it("bakes data-comot-text-height onto the container after a style change", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "Hello");

    await registry.dispatch("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      rangeStart: 0,
      rangeEnd: 1,
      fontWeight: "bold",
    });

    const svg = await readSlide(id);
    expect(svg).toMatch(new RegExp(`<g id="${elementId}"[^>]*data-comot-text-height="[0-9.]+"`));
  });

  it("normal clears a previously set attribute", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "Hello");
    await registry.dispatch("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      rangeStart: 0,
      rangeEnd: 5,
      fontWeight: "bold",
    });

    await registry.dispatch("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      rangeStart: 0,
      rangeEnd: 5,
      fontWeight: "normal",
    });

    const svg = await readSlide(id);
    expect(svg).not.toContain("font-weight");
  });

  it("rejects a range beyond the content length, naming the actual length", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "Hi");

    const result = await registry.dispatch("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      rangeStart: 0,
      rangeEnd: 10,
      fontWeight: "bold",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("2");
  });

  it("rejects a target that is not a text box", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("convert", { id });
    const rect = await registry.dispatch<{ elementId: string }>("element insert", {
      id,
      slidePath: "slides/001.svg",
      kind: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(rect.ok).toBe(true);

    const result = await registry.dispatch("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId: rect.data!.elementId,
      rangeStart: 0,
      rangeEnd: 1,
      fontWeight: "bold",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("元素不是文字框");
  });

  it("undo restores the previous run state byte for byte", async () => {
    const id = await openFreshPresentation();
    const elementId = await addBox(id, "Hello");
    const before = await readSlide(id);

    await registry.dispatch("text style set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      rangeStart: 0,
      rangeEnd: 2,
      fontWeight: "bold",
    });
    await registry.dispatch("undo", { id });

    expect(await readSlide(id)).toBe(before);
  });
});
