import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import type { ConvertReport } from "../src/commands/convert.js";

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

/** Opens a presentation built from hand-written slide SVGs, keyed by virtual path. */
async function openDeck(slides: Record<string, string>): Promise<string> {
  const { zipSync } = await import("fflate");
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "project.json": encoder.encode(
      JSON.stringify({
        formatVersion: 1,
        name: "fixture",
        canvas: { width: 1280, height: 720 },
        slides: Object.keys(slides),
      }),
    ),
  };
  for (const [virtualPath, svg] of Object.entries(slides)) {
    files[virtualPath] = encoder.encode(svg);
  }
  const comotPath = path.join(comotDir, `fixture-${Math.random().toString(36).slice(2)}.comot`);
  await writeFile(comotPath, zipSync(files));
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function catSlide(id: string, virtualPath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: virtualPath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const bareSlide =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
  '  <rect x="0" y="0" width="1280" height="720" fill="#101418"/>\n' +
  '  <text id="el-title" data-comot-name="標題" x="640" y="330" font-size="86">驗收用簡報</text>\n' +
  "</svg>\n";

describe("convert", () => {
  it("wraps every bare primitive into a container, visible immediately through cat", async () => {
    const id = await openDeck({ "slides/001.svg": bareSlide });

    const result = await registry.dispatch<ConvertReport>("convert", { id });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("已轉換 1 張投影片");
    expect(result.data!.slides).toEqual([{ slidePath: "slides/001.svg", changed: true, wrapped: 2 }]);

    const converted = await catSlide(id, "slides/001.svg");
    expect(converted).toContain('<g id="el-title" data-comot-name="標題">\n    <text x="640" y="330" font-size="86">驗收用簡報</text>\n  </g>');
    expect(converted).toMatch(/<g id="el-[^"]+">\n {4}<rect x="0" y="0" width="1280" height="720" fill="#101418"\/>\n {2}<\/g>/);
  });

  it("is idempotent: running it a second time reports no change and rewrites no bytes", async () => {
    const id = await openDeck({ "slides/001.svg": bareSlide });
    await registry.dispatch("convert", { id });
    const afterFirst = await catSlide(id, "slides/001.svg");

    const second = await registry.dispatch<ConvertReport>("convert", { id });

    expect(second.message).toBe("已轉換 0 張投影片，1 張原本就合規");
    expect(second.data!.slides).toEqual([{ slidePath: "slides/001.svg", changed: false, wrapped: 0 }]);
    expect(sha256(await catSlide(id, "slides/001.svg"))).toBe(sha256(afterFirst));
  });

  it("refuses the whole presentation when one slide contains <script>, leaving every file byte-identical", async () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      "  <script>alert(1)</script>\n" +
      '  <rect x="0" y="0" width="10" height="10"/>\n' +
      "</svg>\n";
    const id = await openDeck({ "slides/001.svg": bareSlide, "slides/002.svg": hostile });
    const before = [sha256(await catSlide(id, "slides/001.svg")), sha256(await catSlide(id, "slides/002.svg"))];

    const result = await registry.dispatch("convert", { id });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
    expect(result.message).toContain("slides/002.svg");
    expect(result.message).toContain("<script> 不是合法元素");
    expect(result.message).toContain("整份簡報都沒有被修改。");
    // Slide 1 was perfectly convertible and still must not have been touched.
    expect([sha256(await catSlide(id, "slides/001.svg")), sha256(await catSlide(id, "slides/002.svg"))]).toEqual(before);
  });

  it("succeeds with an empty message when the presentation has no slides", async () => {
    const id = await openDeck({});
    const result = await registry.dispatch<ConvertReport>("convert", { id });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("沒有投影片需要轉換");
    expect(result.data!.slides).toEqual([]);
  });

  it("reports an unknown presentation id as not-found", async () => {
    const result = await registry.dispatch("convert", { id: "no-such-id" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });

  it("keeps a slide's leading BOM", async () => {
    const id = await openDeck({ "slides/001.svg": "﻿" + bareSlide });
    await registry.dispatch("convert", { id });
    expect((await catSlide(id, "slides/001.svg")).startsWith("﻿")).toBe(true);
  });

  // AC 2's structural guarantee: nothing on the read path can reach
  // normalisation. Opening a bare deck and reading it back must return the
  // exact bytes that were packed.
  it("opening and reading a non-compliant presentation does not rewrite it", async () => {
    const id = await openDeck({ "slides/001.svg": bareSlide });
    expect(sha256(await catSlide(id, "slides/001.svg"))).toBe(sha256(bareSlide));
  });
});
