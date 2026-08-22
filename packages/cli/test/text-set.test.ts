import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

// Every test points CO_MOTION_HOME at its own temp directory so we never
// touch the real ~/.comotion (ADR-0004, ticket #9 testing convention).
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

/** Opens a freshly created presentation and returns its id and title element id. */
async function openFreshPresentation(): Promise<{ id: string; elementId: string; originalSlide: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const slide = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  const originalSlide = slide.data!.content;
  const match = /<text id="(el-[^"]+)"/.exec(originalSlide);
  if (!match) throw new Error("test fixture: title element id not found");
  return { id, elementId: match[1], originalSlide };
}

describe("text set", () => {
  it("changes the element's text, visible immediately through cat", async () => {
    const { id, elementId } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: "新標題",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe(`已更新 slides/001.svg 的元素 ${elementId}`);

    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toContain(`>新標題</text>`);
  });

  it("changes only the target text — every other byte of the slide stays identical", async () => {
    const { id, elementId, originalSlide } = await openFreshPresentation();

    await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: "改過的標題",
    });

    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    const updatedSlide = after.data!.content;

    expect(updatedSlide).toEqual(originalSlide.replace("測試簡報", "改過的標題"));
  });

  it("allows setting the text to an empty string (clearing text is legitimate)", async () => {
    const { id, elementId } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: "",
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toContain(`id="${elementId}" data-comot-name="標題" x="640" y="360" text-anchor="middle" font-size="48"></text>`);
  });

  it("escapes <, >, &, and quotes so reading it back yields the original characters", async () => {
    const { id, elementId } = await openFreshPresentation();
    const tricky = `<script> & "quoted" 'single'`;

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: tricky,
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    // Stored form is escaped, not raw.
    expect(after.data!.content).toContain("&lt;script&gt; &amp; \"quoted\" 'single'");
    // Reading it back through cat yields exactly the original characters —
    // simulated here the same way an XML parser would decode entities.
    const decoded = after.data!.content
      .match(/<text[^>]*>([\s\S]*?)<\/text>/)![1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(decoded).toBe(tricky);
  });

  it("allows a newline in the new text, stored escaped as a literal character", async () => {
    const { id, elementId } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: "第一行\n第二行",
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toContain("第一行\n第二行");
  });

  it("fails with a clear error when the slide path does not exist", async () => {
    const { id, elementId } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/does-not-exist.svg",
      elementId,
      newText: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("fails with a clear error when the path exists but is not a slide", async () => {
    const { id, elementId } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "project.json",
      elementId,
      newText: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);

    // project.json itself must remain byte-identical.
    const projectJson = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
    expect(JSON.parse(projectJson.data!.content).name).toBe("測試簡報");
  });

  it("fails with a clear error when the element id is not present on that slide", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-does-not-exist",
      newText: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("fails with a clear error when the element holds no text (e.g. an image)", async () => {
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "image test", slides: ["slides/001.svg"] }),
      ),
      "slides/001.svg": new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><image id="el-img1" href="assets/pic.png" x="0" y="0" width="10" height="10"/></svg>',
      ),
      "assets/": new Uint8Array(0),
    });
    const comotPath = path.join(comotDir, "image-fixture.comot");
    await writeFile(comotPath, zipped);
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-img1",
      newText: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("fails with a clear error for an unknown presentation id", async () => {
    const result = await registry.dispatch("text set", {
      id: "does-not-exist",
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("never leaks the real work directory path in success or error messages", async () => {
    const { id, elementId } = await openFreshPresentation();

    const success = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: "x",
    });
    expect(success.message).not.toContain(coMotionHome);

    const failure = await registry.dispatch("text set", {
      id,
      slidePath: "slides/does-not-exist.svg",
      elementId,
      newText: "x",
    });
    expect(failure.message).not.toContain(coMotionHome);
  });
});

describe("text set renderer", () => {
  it("has no bespoke renderer — falls back to the default status-line-plus-JSON output", () => {
    expect(registry.getRenderer("text set")).toBeUndefined();
  });
});
