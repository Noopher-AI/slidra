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
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Opens a presentation with a hand-built slides/001.svg, for scanner-hostile fixtures. */
async function openFixturePresentation(slideSvg: string, registry: CommandRegistry, comotDir: string): Promise<{ id: string }> {
  const { zipSync } = await import("fflate");
  const { writeFile } = await import("node:fs/promises");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({ formatVersion: 1, name: "fixture", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
    ),
    "slides/001.svg": new TextEncoder().encode(slideSvg),
  });
  const comotPath = path.join(comotDir, `fixture-${Math.random().toString(36).slice(2)}.comot`);
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

/** Opens a presentation with a hand-built slides/001.svg given as raw bytes, for tests that need control over the exact byte sequence (e.g. invalid UTF-8, a BOM). */
async function openFixturePresentationBytes(
  slideSvgBytes: Uint8Array,
  registry: CommandRegistry,
  comotDir: string,
): Promise<{ id: string }> {
  const { zipSync } = await import("fflate");
  const { writeFile } = await import("node:fs/promises");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({ formatVersion: 1, name: "fixture", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
    ),
    "slides/001.svg": slideSvgBytes,
  });
  const comotPath = path.join(comotDir, `fixture-${Math.random().toString(36).slice(2)}.comot`);
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

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
    expect(after.data!.content).toContain(
      `id="${elementId}" data-comot-name="標題" x="640" y="360" text-anchor="middle" font-family="Noto Sans TC" font-size="48"></text>`,
    );
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
        JSON.stringify({ formatVersion: 1, name: "image test", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
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

  it("edits the element whose real id is el-a, not an earlier data-id/xml:id carrying the same string", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<rect data-id="el-a" x="0" y="0" width="1" height="1"></rect>' +
      '<g xml:id="el-a"><rect x="0" y="0" width="1" height="1"></rect></g>' +
      '<text id="el-a">old</text>' +
      "</svg>";
    const { id } = await openFixturePresentation(slideSvg, registry, comotDir);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "new",
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(slideSvg.replace(">old<", ">new<"));
  });

  it("edits the live element and leaves an earlier comment carrying the same id untouched", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<!-- <text id="el-a">old</text> -->' +
      '<text id="el-a">live</text>' +
      "</svg>";
    const { id } = await openFixturePresentation(slideSvg, registry, comotDir);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "new",
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<!-- <text id="el-a">old</text> -->' +
        '<text id="el-a">new</text>' +
        "</svg>",
    );
  });

  it("fails with a clear error when the id appears only inside a comment", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><!-- <text id="el-a">old</text> --></svg>';
    const { id } = await openFixturePresentation(slideSvg, registry, comotDir);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "new",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);

    // the untouched slide, including the comment, is byte-identical.
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(slideSvg);
  });

  it("does not select an element whose id attribute value is embedded inside another attribute's quoted value", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      "<text data-note=' id=\"el-a\"' id=\"el-b\">wrong</text>" +
      '<text id="el-a">right</text>' +
      "</svg>";
    const { id } = await openFixturePresentation(slideSvg, registry, comotDir);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "new",
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(slideSvg.replace(">right<", ">new<"));
  });

  it("fails naming the element when the target tag is not text-bearing (rect)", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-a" x="0" y="0" width="1" height="1"></rect></svg>';
    const { id } = await openFixturePresentation(slideSvg, registry, comotDir);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("el-a");
  });

  it("fails with a clear error when newText contains an XML-forbidden control character, and writes nothing", async () => {
    const { id, elementId, originalSlide } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: "badchar",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);

    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(originalSlide);
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

  it("fails with a clear error and writes nothing when the slide contains an invalid UTF-8 byte, even far from the target element", async () => {
    const { readFile } = await import("node:fs/promises");
    const prefix = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><!-- stray byte: ',
    );
    const invalidByte = new Uint8Array([0xff]); // never valid as a UTF-8 lead byte
    const suffix = new TextEncoder().encode(' --><text id="el-a">old</text></svg>');
    const slideBytes = new Uint8Array(prefix.length + invalidByte.length + suffix.length);
    slideBytes.set(prefix, 0);
    slideBytes.set(invalidByte, prefix.length);
    slideBytes.set(suffix, prefix.length + invalidByte.length);

    const { id } = await openFixturePresentationBytes(slideBytes, registry, comotDir);
    const realPath = path.join(coMotionHome, "work", id, "slides", "001.svg");
    const beforeBytes = await readFile(realPath);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "new",
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain(coMotionHome);

    const afterBytes = await readFile(realPath);
    expect(Buffer.compare(afterBytes, beforeBytes)).toBe(0);
    expect(Buffer.compare(afterBytes, Buffer.from(slideBytes))).toBe(0);
  });

  it("preserves a leading UTF-8 BOM untouched when editing a slide that starts with one", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const rest = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><text id="el-a">old</text></svg>',
    );
    const slideBytes = new Uint8Array(bom.length + rest.length);
    slideBytes.set(bom, 0);
    slideBytes.set(rest, bom.length);

    const { id } = await openFixturePresentationBytes(slideBytes, registry, comotDir);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-a",
      newText: "new",
    });

    expect(result.ok).toBe(true);
    const { readFile } = await import("node:fs/promises");
    const realPath = path.join(coMotionHome, "work", id, "slides", "001.svg");
    const afterBytes = await readFile(realPath);
    expect(afterBytes.subarray(0, 3)).toEqual(Buffer.from(bom));

    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(
      "\uFEFF<svg xmlns=\"http://www.w3.org/2000/svg\"><text id=\"el-a\">new</text></svg>",
    );
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

describe("text set on a converted (#72) slide — id lifted onto the <g> container", () => {
  it("edits the container's single <text> child; the container's id/data-comot-name/indentation stay byte-identical", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
      '  <g id="el-title" data-comot-name="標題"><text x="640" y="360" text-anchor="middle" font-size="48">驗收用簡報</text></g>\n' +
      "</svg>\n";
    const { id } = await openFixturePresentation(slideSvg, registry, comotDir);

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-title",
      newText: "改過的標題",
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(slideSvg.replace(">驗收用簡報<", ">改過的標題<"));
  });

  it("end-to-end: convert a slide with a bare primitive, then text set the resulting container", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text data-comot-name="標題" x="640" y="360">原始標題</text></svg>';
    const { id } = await openFixturePresentation(slideSvg, registry, comotDir);

    const converted = await registry.dispatch<{ slides: Array<{ changed: boolean }> }>("convert", { id });
    expect(converted.ok).toBe(true);
    expect(converted.data!.slides[0]!.changed).toBe(true);

    const afterConvert = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    // #72's normalisation wrapped the bare <text> in a <g> and lifted the id onto it.
    const match = /<g id="(el-[^"]+)"/.exec(afterConvert.data!.content);
    if (!match) throw new Error("test fixture: converted container id not found");
    const containerId = match[1];

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: containerId,
      newText: "改過的標題",
    });

    expect(result.ok).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toContain(">改過的標題</text>");
  });
});

describe("text set renderer", () => {
  it("has no bespoke renderer — falls back to the default status-line-plus-JSON output", () => {
    expect(registry.getRenderer("text set")).toBeUndefined();
  });
});
