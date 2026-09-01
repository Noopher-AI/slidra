import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

// Same per-test isolation as text-set.test.ts (ADR-0004, ticket #9 testing
// convention).
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

/** Opens a presentation built from hand-picked slide SVGs, one file per slide, in `slides/001.svg`, `slides/002.svg`, ... order. */
async function openPresentationWithSlides(
  name: string,
  slideSvgs: string[],
): Promise<{ id: string }> {
  const { zipSync } = await import("fflate");
  const { writeFile } = await import("node:fs/promises");
  const files: Record<string, Uint8Array> = {
    "project.json": new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        name,
        canvas: { width: 1280, height: 720 },
        slides: slideSvgs.map((_, i) => `slides/${String(i + 1).padStart(3, "0")}.svg`),
      }),
    ),
  };
  slideSvgs.forEach((svg, i) => {
    files[`slides/${String(i + 1).padStart(3, "0")}.svg`] = new TextEncoder().encode(svg);
  });
  const comotPath = path.join(comotDir, `fixture-${Math.random().toString(36).slice(2)}.comot`);
  await writeFile(comotPath, zipSync(files));
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

/** Overwrites `project.json` directly on disk to simulate a slide reorder, without needing a real "move slide" command to exist yet. */
async function overwriteProjectJson(id: string, project: unknown): Promise<void> {
  const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
  const registryRaw = await rf(path.join(coMotionHome, "projects.json"), "utf-8");
  const workDir = (JSON.parse(registryRaw) as Record<string, { workDir: string }>)[id].workDir;
  await wf(path.join(workDir, "project.json"), JSON.stringify(project), "utf-8");
}

describe("slide render — dynamic text substitution on the display path", () => {
  it("substitutes slide_number, slide_total and presentation_name", async () => {
    const { id } = await openPresentationWithSlides("我的簡報", [
      '<svg><text id="el-a">{{ slide_number }} / {{ slide_total }} — {{ presentation_name }}</text></svg>',
    ]);

    const result = await registry.dispatch<{ content: string }>("slide render", { id, path: "slides/001.svg" });

    expect(result.ok).toBe(true);
    expect(result.data!.content).toBe('<svg><text id="el-a">1 / 1 — 我的簡報</text></svg>');
  });

  it("does not persist the substitution — cat still returns the literal placeholder", async () => {
    const { id } = await openPresentationWithSlides("deck", [
      '<svg><text id="el-a">{{ slide_number }}</text></svg>',
    ]);

    await registry.dispatch("slide render", { id, path: "slides/001.svg" });
    const raw = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });

    expect(raw.data!.content).toBe('<svg><text id="el-a">{{ slide_number }}</text></svg>');
  });

  it("recomputes slide_number correctly after the slide order changes, with no dedicated 'reorder' step", async () => {
    const { id } = await openPresentationWithSlides("deck", [
      '<svg><text id="el-a">{{ slide_number }}</text></svg>',
      '<svg><text id="el-a">{{ slide_number }}</text></svg>',
    ]);

    const before = await registry.dispatch<{ content: string }>("slide render", { id, path: "slides/002.svg" });
    expect(before.data!.content).toBe('<svg><text id="el-a">2</text></svg>');

    // Reverse the slide order directly on disk (simulating whatever future
    // "move slide" command reorders project.json's slides array).
    await overwriteProjectJson(id, {
      formatVersion: 1,
      name: "deck",
      canvas: { width: 1280, height: 720 },
      slides: ["slides/002.svg", "slides/001.svg"],
    });

    const after = await registry.dispatch<{ content: string }>("slide render", { id, path: "slides/002.svg" });
    expect(after.data!.content).toBe('<svg><text id="el-a">1</text></svg>');
  });

  it("leaves an unknown placeholder exactly as written end to end, through the registry", async () => {
    const { id } = await openPresentationWithSlides("deck", ['<svg><text id="el-a">{{ mystery }}</text></svg>']);

    const result = await registry.dispatch<{ content: string }>("slide render", { id, path: "slides/001.svg" });

    expect(result.data!.content).toBe('<svg><text id="el-a">{{ mystery }}</text></svg>');
  });

  it("fails with a clear error for a path that is not a listed slide", async () => {
    const { id } = await openPresentationWithSlides("deck", ["<svg><text>x</text></svg>"]);

    const result = await registry.dispatch("slide render", { id, path: "project.json" });

    expect(result.ok).toBe(false);
  });
});
