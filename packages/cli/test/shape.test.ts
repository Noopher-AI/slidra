import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSlideCompliance, parseSlide, resolveWorkDir } from "@co-motion/core";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `rect add` / `ellipse add` / `line add` / `path add` (#74), driven purely
 * through the CLI's own command registry against a real temp presentation,
 * with the SVG read back off disk via `cat` — the seam this unit's dispatch
 * names, following `packages/cli/test/textbox.test.ts`'s pattern.
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

async function openFreshPresentation(): Promise<{ id: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "圖形測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

async function readSlide(id: string, slidePath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  return result.data!.content;
}

/** A hand-written, ADR-0012-compliant fixture slide — NOT the fresh deck's slide 2, which is a bare <text>. */
const COMPLIANT_SLIDE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <g id="el-existing"><rect width="10" height="10"/></g>
</svg>
`;

/**
 * Opens a fresh presentation and overwrites its slide 1 with a hand-written,
 * ADR-0012-compliant fixture — never the fresh deck's slide 2, which is a
 * bare `<text>` non-compliant by construction and unrelated to this unit.
 * There is no registry command that writes an arbitrary slide body, so this
 * writes the fixture straight to the work directory (`resolveWorkDir` is
 * the same id-to-path lookup `cat`/`ls` use internally) — a test-setup-only
 * step; the insert command itself is still dispatched through the real
 * registry and read back through `cat`, which is the seam under test.
 */
async function openWithCompliantSlide(): Promise<{ id: string; slidePath: string }> {
  const { id } = await openFreshPresentation();
  const slidePath = "slides/001.svg";
  const workDir = await resolveWorkDir(id);
  await writeFile(path.join(workDir, slidePath), COMPLIANT_SLIDE, "utf-8");
  return { id, slidePath };
}

describe("rect add / ellipse add / line add / path add (#74)", () => {
  it("rect add writes <g id=... transform=...><rect .../></g>", async () => {
    const { id } = await openFreshPresentation();
    const result = await registry.dispatch<{ elementId: string }>("rect add", {
      id,
      slidePath: "slides/001.svg",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: "#ff0000",
    });
    expect(result.ok).toBe(true);
    const elementId = result.data!.elementId;
    expect(elementId).toMatch(/^el-/);

    const svg = await readSlide(id, "slides/001.svg");
    const pattern = new RegExp(`<g id="${elementId}" transform="translate\\(10 20\\)"><rect width="100" height="50" fill="#ff0000"/></g>`);
    expect(svg).toMatch(pattern);
  });

  it("ellipse add writes <g id=... transform=...><ellipse .../></g>", async () => {
    const { id } = await openFreshPresentation();
    const result = await registry.dispatch<{ elementId: string }>("ellipse add", {
      id,
      slidePath: "slides/001.svg",
      x: 5,
      y: 6,
      rx: 30,
      ry: 15,
    });
    expect(result.ok).toBe(true);
    const elementId = result.data!.elementId;
    const svg = await readSlide(id, "slides/001.svg");
    expect(svg).toContain(`<g id="${elementId}" transform="translate(5 6)"><ellipse rx="30" ry="15"/></g>`);
  });

  it("line add writes <g id=... transform=...><line .../></g>, and requires --stroke", async () => {
    const { id } = await openFreshPresentation();
    const missingStroke = await registry.dispatch("line add", {
      id,
      slidePath: "slides/001.svg",
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 10,
      stroke: "",
    });
    expect(missingStroke.ok).toBe(false);
    expect(missingStroke.message).toContain("--stroke");

    const before = await readSlide(id, "slides/001.svg");
    const result = await registry.dispatch<{ elementId: string }>("line add", {
      id,
      slidePath: "slides/001.svg",
      x1: 100,
      y1: 200,
      x2: 150,
      y2: 260,
      stroke: "#000000",
    });
    expect(result.ok).toBe(true);
    const elementId = result.data!.elementId;
    const svg = await readSlide(id, "slides/001.svg");
    expect(svg).toContain(
      `<g id="${elementId}" transform="translate(100 200)"><line x1="0" y1="0" x2="50" y2="60" stroke="#000000"/></g>`,
    );
    // The rejected call above never touched the file.
    expect(before).not.toContain('stroke=""');
  });

  it("path add accepts --d verbatim (AC5), and no node-editing command exists in the registry", async () => {
    const { id } = await openFreshPresentation();
    const result = await registry.dispatch<{ elementId: string }>("path add", {
      id,
      slidePath: "slides/001.svg",
      x: 0,
      y: 0,
      d: "M0 0 L10 10",
    });
    expect(result.ok).toBe(true);
    const elementId = result.data!.elementId;
    const svg = await readSlide(id, "slides/001.svg");
    expect(svg).toContain(`<g id="${elementId}" transform="translate(0 0)"><path d="M0 0 L10 10"/></g>`);

    expect(registry.has("path node add")).toBe(false);
    expect(registry.has("path node")).toBe(false);
    expect(registry.has("path edit")).toBe(false);
  });

  it("--width 0.00004 (positive but rounds to 0) throws and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const before = await readSlide(id, "slides/001.svg");
    const result = await registry.dispatch("rect add", {
      id,
      slidePath: "slides/001.svg",
      x: 0,
      y: 0,
      width: 0.00004,
      height: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("四捨五入後不是大於 0");
    expect(await readSlide(id, "slides/001.svg")).toBe(before);
  });

  it.each([
    ["rect add", { x: 0, y: 0, width: 10, height: 10 }, "rect"],
    ["ellipse add", { x: 0, y: 0, rx: 10, ry: 5 }, "ellipse"],
    ["line add", { x1: 0, y1: 0, x2: 10, y2: 10, stroke: "#000" }, "line"],
    ["path add", { x: 0, y: 0, d: "M0 0 L10 10" }, "path"],
  ] as const)(
    "AC1: %s on a hand-written compliant fixture lands compliant, and the new element's kind is %s",
    async (commandName, extra, expectedKind) => {
      const { id, slidePath } = await openWithCompliantSlide();
      expect(checkSlideCompliance(COMPLIANT_SLIDE)).toEqual([]);

      const result = await registry.dispatch(commandName, { id, slidePath, ...extra });
      expect(result.ok).toBe(true);

      const after = await readSlide(id, slidePath);
      expect(checkSlideCompliance(after)).toEqual([]);
      expect(parseSlide(after).elements.at(-1)!.kind).toBe(expectedKind);
    },
  );
});
