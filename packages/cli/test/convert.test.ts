import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import type { ConvertReport } from "../src/commands/convert.js";

// A single-shot injection point for the "writeFile fails after it has
// already truncated the file" test below. Every other call passes straight
// through to the real implementation, so this has no effect on any other
// test in this file.
let truncateThenFailPath: string | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (file: unknown, data: unknown, options: unknown) => {
      if (typeof file === "string" && file === truncateThenFailPath) {
        truncateThenFailPath = null; // one-shot: only this call fails
        // Real writeFile truncates the file before writing the new bytes.
        // A disk that goes full mid-write leaves exactly this: the file
        // already emptied, then the call throws.
        await actual.writeFile(file, "", "utf-8");
        throw new Error("ENOSPC: simulated disk full mid-write");
      }
      return actual.writeFile(file as string, data as string, options as string);
    },
  };
});

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

/**
 * Gate round 1 (#72), [high] "convert can leave a presentation partially
 * converted after a write failure": reading and normalising every slide up
 * front only makes an UNCONVERTIBLE slide harmless. It says nothing about a
 * write that fails partway through, and the write loop originally had no
 * rollback — three slides were rewritten, the command reported failure, and
 * the presentation was left half in the container form.
 *
 * The injection is the real thing, not a mock: `chmod 0o444` on the second
 * slide inside the presentation's work directory. Slide 1 converts and is
 * written; slide 2's write is refused by the operating system; slide 1 must
 * come back.
 */
describe("convert 的寫入階段失敗", () => {
  it("前面幾張已寫成功、後面某一張寫失敗時，所有投影片都回到原始內容", async () => {
    const { chmod } = await import("node:fs/promises");
    const { resolveWorkDir } = await import("@co-motion/core");

    const secondSlide =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <text id="el-second" x="10" y="20" font-size="30">第二張</text>\n' +
      "</svg>\n";
    const id = await openDeck({ "slides/001.svg": bareSlide, "slides/002.svg": secondSlide });
    const before = {
      "slides/001.svg": sha256(await catSlide(id, "slides/001.svg")),
      "slides/002.svg": sha256(await catSlide(id, "slides/002.svg")),
    };

    const workDir = await resolveWorkDir(id);
    const readOnlySlide = path.join(workDir, "slides", "002.svg");
    await chmod(readOnlySlide, 0o444);
    try {
      const result = await registry.dispatch("convert", { id });

      expect(result.ok).toBe(false);
      // The disk first: this is the claim that matters, so it is asserted
      // before anything about the wording, which would otherwise
      // short-circuit the check that actually proves the rollback happened.
      expect({
        "slides/001.svg": sha256(await catSlide(id, "slides/001.svg")),
        "slides/002.svg": sha256(await catSlide(id, "slides/002.svg")),
      }).toEqual(before);
      expect(result.message).toContain("寫入投影片時發生錯誤：slides/002.svg");
      // And the message has to match that disk state, not paper over it.
      expect(result.message).toContain("整份簡報都沒有被修改。");
    } finally {
      await chmod(readOnlySlide, 0o644);
    }
  });
});

/**
 * The chmod test above proves rollback works when the failing write never
 * touches the disk (EACCES fires at `open()`, before any bytes move). It
 * does NOT prove anything about the other half of the defect: `writeFile`
 * truncates before it writes, so a write that fails partway through can
 * leave the FAILED slide itself sitting at 0 bytes — and that slide was
 * never added to the rollback list, because the code only pushed a slide
 * into `written` *after* its write succeeded.
 *
 * This test forces exactly that: the mocked `writeFile` (see the top of
 * this file) truncates slides/002.svg to empty and only then throws,
 * mimicking a disk that goes full mid-write. If the failed slide isn't
 * restored, it stays at 0 bytes forever even though the command claims
 * nothing was modified.
 */
describe("convert 的寫入在截斷之後才失敗", () => {
  it("失敗的那一張本身也要被還原回原始位元組，不只是它之前寫成功的那幾張", async () => {
    const secondSlide =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <text id="el-second" x="10" y="20" font-size="30">第二張</text>\n' +
      "</svg>\n";
    const id = await openDeck({ "slides/001.svg": bareSlide, "slides/002.svg": secondSlide });
    const before = {
      "slides/001.svg": sha256(await catSlide(id, "slides/001.svg")),
      "slides/002.svg": sha256(await catSlide(id, "slides/002.svg")),
    };

    const { resolveWorkDir } = await import("@co-motion/core");
    const workDir = await resolveWorkDir(id);
    truncateThenFailPath = path.join(workDir, "slides", "002.svg");

    const result = await registry.dispatch("convert", { id });

    expect(result.ok).toBe(false);
    // The disk first, at byte level (sha256), not just the message string:
    // slides/002.svg was truncated to 0 bytes by the injected failure and
    // must have been written back to its exact original bytes.
    expect({
      "slides/001.svg": sha256(await catSlide(id, "slides/001.svg")),
      "slides/002.svg": sha256(await catSlide(id, "slides/002.svg")),
    }).toEqual(before);
    expect(result.message).toContain("寫入投影片時發生錯誤：slides/002.svg");
    expect(result.message).toContain("整份簡報都沒有被修改。");
  });
});
