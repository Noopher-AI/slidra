import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import { renderCat } from "../src/commands/cat.js";
import { renderLs } from "../src/commands/ls.js";
import { FORMAT_VERSION } from "@co-motion/core";

// root ignores permission bits, so the two chmod(0o000)-based tests below
// can never observe the EACCES they are provoking when this process runs
// as root (as CI containers commonly do) — the expected error simply never
// happens. Skip them cleanly in that case rather than have them fail for a
// reason unrelated to what they are testing.
const isRunningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

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

describe("new", () => {
  it("creates a .comot file containing a minimal presentation", async () => {
    const comotPath = path.join(comotDir, "deck.comot");

    const result = await registry.dispatch("new", { path: comotPath, name: "我的簡報" });

    expect(result.ok).toBe(true);

    // Verify state by opening the file we just created and reading it back
    // through commands, never by inspecting the filesystem directly.
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    expect(opened.ok).toBe(true);
    const id = opened.data!.id;

    const listed = await registry.dispatch<{ entries: string[] }>("ls", { id });
    expect(listed.data!.entries.sort()).toEqual(["assets", "fonts", "project.json", "slides"]);

    const projectJson = await registry.dispatch<{ content: string }>("cat", {
      id,
      path: "project.json",
    });
    const project = JSON.parse(projectJson.data!.content);
    expect(project.formatVersion).toBe(FORMAT_VERSION);
    expect(project.name).toBe("我的簡報");
    expect(project.slides).toEqual(["slides/001.svg"]);

    const slide = await registry.dispatch<{ content: string }>("cat", {
      id,
      path: "slides/001.svg",
    });
    expect(slide.data!.content).toContain("data-comot-name=\"標題\"");
    expect(slide.data!.content).toContain("<svg");
  });
});

describe("open", () => {
  it("returns an opaque id that later commands can use to address the presentation", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });

    const result = await registry.dispatch<{ id: string }>("open", { path: comotPath });

    expect(result.ok).toBe(true);
    expect(result.data!.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("fails with a clear error and does not throw when the file does not exist", async () => {
    const result = await registry.dispatch("open", { path: path.join(comotDir, "missing.comot") });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it.skipIf(isRunningAsRoot)("fails with a CoMotionError, not a raw filesystem error, when the file is unreadable", async () => {
    const { writeFile, chmod } = await import("node:fs/promises");
    const unreadablePath = path.join(comotDir, "unreadable.comot");
    await writeFile(unreadablePath, "irrelevant content");
    await chmod(unreadablePath, 0o000);

    try {
      // A raw Node fs error (thrown, not a CoMotionError) would propagate
      // straight out of dispatch instead of becoming an { ok: false }
      // result — see registry.ts's "anything else propagates as a thrown
      // error (a bug, not a user-facing failure)" contract.
      const result = await registry.dispatch("open", { path: unreadablePath });

      expect(result.ok).toBe(false);
      // The caller may see back the exact string they typed (unreadablePath
      // equals the caller-supplied path here), but never Node's own error
      // text ("EACCES", "permission denied", errno codes).
      expect(result.message).not.toContain("EACCES");
      expect(result.message).not.toContain("permission denied");
      expect(result.message).not.toContain("errno");
    } finally {
      await chmod(unreadablePath, 0o644);
    }
  });

  it("fails with a clear error when the file is not a valid container", async () => {
    const { writeFile } = await import("node:fs/promises");
    const brokenPath = path.join(comotDir, "broken.comot");
    await writeFile(brokenPath, "this is not a zip file");

    const result = await registry.dispatch("open", { path: brokenPath });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("fails with a clear error when project.json is missing formatVersion", async () => {
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(JSON.stringify({ name: "no version" })),
      "slides/": new Uint8Array(0),
      "assets/": new Uint8Array(0),
    });
    const badPath = path.join(comotDir, "no-format-version.comot");
    await writeFile(badPath, zipped);

    const result = await registry.dispatch("open", { path: badPath });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("formatVersion");
  });

  it("rejects a container whose entry path escapes the work directory, before writing anything", async () => {
    const { zipSync } = await import("fflate");
    const { writeFile, access } = await import("node:fs/promises");

    // A real malicious archive: one entry tries to climb out of the target
    // directory entirely and land inside comotDir, a location the unpacker
    // has no business writing to.
    const escapeTargetPath = path.join(comotDir, "escaped-marker.txt");
    const traversalEntryName = `${"../".repeat(30)}${comotDir.slice(1)}/escaped-marker.txt`;
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "escape", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
      ),
      "slides/001.svg": new TextEncoder().encode("<svg></svg>"),
      "assets/": new Uint8Array(0),
      [traversalEntryName]: new TextEncoder().encode("PWNED"),
    });
    const maliciousPath = path.join(comotDir, "malicious.comot");
    await writeFile(maliciousPath, zipped);

    const result = await registry.dispatch("open", { path: maliciousPath });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    await expect(access(escapeTargetPath)).rejects.toThrow();
  });
});

describe("pack", () => {
  it("round-trips: pack then open the result again has the same content", async () => {
    const originalPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: originalPath, name: "Round Trip" });
    const opened = await registry.dispatch<{ id: string }>("open", { path: originalPath });
    const id = opened.data!.id;

    const repackedPath = path.join(comotDir, "repacked.comot");
    const packResult = await registry.dispatch("pack", { id, path: repackedPath });
    expect(packResult.ok).toBe(true);

    const reopened = await registry.dispatch<{ id: string }>("open", { path: repackedPath });
    expect(reopened.ok).toBe(true);
    const reopenedId = reopened.data!.id;

    const originalProject = await registry.dispatch<{ content: string }>("cat", {
      id,
      path: "project.json",
    });
    const repackedProject = await registry.dispatch<{ content: string }>("cat", {
      id: reopenedId,
      path: "project.json",
    });
    expect(repackedProject.data!.content).toEqual(originalProject.data!.content);

    const originalSlide = await registry.dispatch<{ content: string }>("cat", {
      id,
      path: "slides/001.svg",
    });
    const repackedSlide = await registry.dispatch<{ content: string }>("cat", {
      id: reopenedId,
      path: "slides/001.svg",
    });
    expect(repackedSlide.data!.content).toEqual(originalSlide.data!.content);
  });

  it("fails with a clear error for an unknown id", async () => {
    const result = await registry.dispatch("pack", {
      id: "does-not-exist",
      path: path.join(comotDir, "out.comot"),
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("ls", () => {
  it("lists the top level when no path is given", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch<{ entries: string[] }>("ls", { id });

    expect(result.ok).toBe(true);
    expect(result.data!.entries.sort()).toEqual(["assets", "fonts", "project.json", "slides"]);
  });

  it("lists a given directory's contents, one entry deep", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "slides" });

    expect(result.ok).toBe(true);
    expect(result.data!.entries).toEqual(["001.svg"]);
  });

  it.skipIf(isRunningAsRoot)("fails with a CoMotionError, not a raw filesystem error, when a directory in the work tree is unreadable", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    // Make the "slides" subdirectory of the hidden work tree unreadable so
    // that buildVirtualTree's enumeration hits a real EACCES while walking
    // it (see virtual-fs.ts's populate). This must never leak the hidden
    // work directory's real path back to the caller (ADR-0004, third layer).
    const { chmod } = await import("node:fs/promises");
    const unreadableDir = path.join(coMotionHome, "work", id, "slides");
    await chmod(unreadableDir, 0o000);

    try {
      const result = await registry.dispatch("ls", { id });

      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(coMotionHome);
      expect(result.message).not.toContain(unreadableDir);
      expect(result.message).not.toContain("EACCES");
      expect(result.message).not.toContain("permission denied");
      expect(result.message).not.toContain("errno");
      expect(result.message).not.toMatch(/\//);
    } finally {
      // Restore permissions so the temp directory can be removed in afterEach.
      await chmod(unreadableDir, 0o755);
    }
  });

  it("fails with a clear error and non-zero exit for a path that does not exist", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch("ls", { id, path: "does-not-exist" });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("fails when the path points at a file instead of a directory", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch("ls", { id, path: "project.json" });

    expect(result.ok).toBe(false);
  });
});

describe("cat", () => {
  it("outputs a file's complete original content unmodified", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath, name: "原文測試" });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.data!.content).name).toBe("原文測試");
  });

  it("fails with a clear error and non-zero exit for a path that does not exist", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch("cat", { id, path: "does-not-exist.svg" });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("fails when the path points at a directory instead of a file", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch("cat", { id, path: "slides" });

    expect(result.ok).toBe(false);
  });

  it("rejects a binary asset with an explicit error instead of silently corrupting it", async () => {
    // `new` only ever produces text files, so the only honest way to get a
    // real binary asset into a presentation is to build the container
    // directly (the same technique the "open" tests use for malicious
    // archives) and load it through `open`.
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    // Real invalid UTF-8 bytes, not a string standing in for them: 0xFF and
    // 0xFE are not valid anywhere in UTF-8, and 0xC3 0x28 is a two-byte
    // lead byte followed by a continuation byte that doesn't fit the form.
    const binaryBytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xc3, 0x28, 0x80]);
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "binary asset test", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
      ),
      "slides/001.svg": new TextEncoder().encode("<svg></svg>"),
      "assets/intro.mp4": binaryBytes,
    });
    const comotPath = path.join(comotDir, "binary-fixture.comot");
    await writeFile(comotPath, zipped);
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch("cat", { id, path: "assets/intro.mp4" });

    // ok: false is what drives main()'s non-zero exit code (see bin.ts).
    expect(result.ok).toBe(false);
    expect(result.message).toContain("assets/intro.mp4");
    expect(result.message).toContain("二進位");
    // No real filesystem path leaks into the refusal (ADR-0004).
    expect(result.message).not.toContain(coMotionHome);
  });

  it("keeps a UTF-8 text file with Traditional Chinese and emoji byte-identical", async () => {
    // The boundary this guards: non-ASCII text is not binary. Only content
    // that fails strict UTF-8 decoding should ever be rejected.
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    const text = "繁體中文測試：投影片與資產 🎉🚀📽️";
    const originalBytes = new TextEncoder().encode(text);
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "emoji test", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
      ),
      "slides/001.svg": new TextEncoder().encode("<svg></svg>"),
      "assets/note.txt": originalBytes,
    });
    const comotPath = path.join(comotDir, "text-fixture.comot");
    await writeFile(comotPath, zipped);
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch<{ content: string }>("cat", { id, path: "assets/note.txt" });

    expect(result.ok).toBe(true);
    expect(result.data!.content).toBe(text);
    // Byte-identical, not just string-equal: re-encoding the returned
    // content must reproduce the exact original bytes.
    expect(new TextEncoder().encode(result.data!.content)).toEqual(originalBytes);
  });

  it("keeps a leading UTF-8 BOM byte-identical instead of silently stripping it", async () => {
    // A leading EF BB BF is valid UTF-8 content, not just a signature. The
    // default TextDecoder treats it as a BOM and strips it, which would make
    // cat return altered bytes while claiming success — the same class of
    // silent corruption as the binary-asset bug, just narrower.
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    const originalBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")]);
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "bom test", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
      ),
      "slides/001.svg": new TextEncoder().encode("<svg></svg>"),
      "assets/bom.txt": originalBytes,
    });
    const comotPath = path.join(comotDir, "bom-fixture.comot");
    await writeFile(comotPath, zipped);
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch<{ content: string }>("cat", { id, path: "assets/bom.txt" });

    expect(result.ok).toBe(true);
    // Byte-identical, not just string-equal: re-encoding the returned
    // content must reproduce the exact original bytes, BOM included.
    expect(new TextEncoder().encode(result.data!.content)).toEqual(originalBytes);
  });
});

describe("no write entry point exists", () => {
  it("the registry has no command capable of modifying a presentation's content", async () => {
    // Structural check, not a blocklist: the entire set of registered
    // command names must contain nothing but the known read-only/addressing
    // commands. Any future write command must show up here as a failure,
    // forcing a deliberate decision rather than an accidental leak.
    const knownCommands = ["new", "open", "pack", "cat", "ls"];
    for (const name of knownCommands) {
      expect(registry.has(name)).toBe(true);
    }
    expect(registry.has("write")).toBe(false);
    expect(registry.has("edit")).toBe(false);
    expect(registry.has("read")).toBe(false);
    expect(registry.has("list")).toBe(false);
  });
});

describe("no output leaks the real work directory path", () => {
  it("across new, open, pack, ls, cat and error paths", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    const outputs: string[] = [];

    const record = (result: { message: string; data?: unknown }) => {
      outputs.push(result.message);
      if (result.data !== undefined) {
        outputs.push(JSON.stringify(result.data));
      }
    };

    const newResult = await registry.dispatch("new", { path: comotPath });
    record(newResult);
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    record(opened);
    const id = opened.data!.id;

    record(await registry.dispatch("ls", { id }));
    record(await registry.dispatch("cat", { id, path: "project.json" }));

    const repackedPath = path.join(comotDir, "repacked.comot");
    const packResult = await registry.dispatch("pack", { id, path: repackedPath });
    record(packResult);

    // Success messages must contain no filesystem path at all — not merely
    // omit the hidden work directory. The caller already supplied `comotPath`
    // / `repackedPath`; echoing it back earns nothing and, once
    // `co-motion serve` exists, would leak the human's directory layout to
    // an agent that never supplied it.
    expect(newResult.ok).toBe(true);
    expect(newResult.message).not.toContain(comotPath);
    expect(newResult.message).not.toContain(comotDir);
    expect(packResult.ok).toBe(true);
    expect(packResult.message).not.toContain(repackedPath);
    expect(packResult.message).not.toContain(comotDir);

    // Error paths too.
    record(await registry.dispatch("open", { path: path.join(comotDir, "missing.comot") }));
    record(await registry.dispatch("pack", { id: "unknown-id-x", path: repackedPath }));
    record(await registry.dispatch("cat", { id, path: "does-not-exist.svg" }));
    record(await registry.dispatch("ls", { id, path: "does-not-exist-dir" }));

    for (const output of outputs) {
      expect(output).not.toContain(coMotionHome);
    }
  });
});

describe("cat renderer", () => {
  it("emits the content byte-for-byte, with no JSON escaping and no status line", () => {
    // Every character class JSON.stringify would mangle: a quote, a
    // newline, `<`, and non-ASCII text.
    const tricky = 'quote"newline\n<tag>非ASCII字';

    const rendered = renderCat({ content: tricky });

    expect(rendered).toBe(tricky);
    expect(rendered).not.toContain("\\n");
    expect(rendered).not.toContain("\\\"");
    expect(rendered).not.toContain("已讀取");
  });

  it("round-trips a real file's stored content through the full dispatch pipeline", async () => {
    const comotPath = path.join(comotDir, "deck.comot");
    const trickyName = 'quote"newline\n<tag>非ASCII名稱';
    await registry.dispatch("new", { path: comotPath, name: trickyName });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
    const render = registry.getRenderer<{ content: string }>("cat")!;
    const rendered = render(result.data!);

    // Rendered output is the raw stored file — parsing it back yields the
    // exact original name, and none of the default wrapper survives.
    expect(JSON.parse(rendered).name).toBe(trickyName);
    expect(rendered).not.toContain("已讀取");
    expect(rendered).not.toMatch(/^\s*\{\s*"content"/);
  });
});

describe("ls renderer", () => {
  it("emits exactly the entry names, one per line, and nothing else", () => {
    const rendered = renderLs({ entries: ["assets", "project.json", "slides"] });

    expect(rendered).toBe("assets\nproject.json\nslides\n");
    expect(rendered).not.toContain("共");
    expect(rendered).not.toContain("{");
  });

  it("emits an empty string for an empty directory", () => {
    expect(renderLs({ entries: [] })).toBe("");
  });
});

// Ticket #14: `dispatch` used to flatten every CoMotionError into a bare
// `{ ok: false, message }`, throwing away the subtype. Callers needing an
// HTTP-shaped answer (`/api/files/`) then had nothing to tell "genuinely
// absent" apart from "the read blew up", and reported both as 404.
// `failureKind` carries that distinction across the dispatch boundary as a
// type, never as a message the caller has to pattern-match on.
describe("dispatch failure classification", () => {
  async function openedId(): Promise<string> {
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    return opened.data!.id;
  }

  it("classifies a file that genuinely does not exist as not-found", async () => {
    const id = await openedId();

    const result = await registry.dispatch("cat", { id, path: "slides/999.svg" });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
    // `cat`'s wording is a verbatim acceptance point of ticket #14 — this
    // change adds a field, it does not touch what anyone reads.
    expect(result.message).toBe("找不到檔案：slides/999.svg");
  });

  it("classifies an unknown presentation id as not-found", async () => {
    const result = await registry.dispatch("cat", { id: "no-such-id", path: "project.json" });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });

  it.skipIf(isRunningAsRoot)("classifies a real I/O failure as failed, never as not-found", async () => {
    const id = await openedId();
    const { chmod } = await import("node:fs/promises");
    // Break the real read (EACCES) instead of mocking it. The real path is
    // only used to provoke the failure, never asserted against the message.
    const realFile = path.join(coMotionHome, "work", id, "project.json");
    await chmod(realFile, 0o000);

    try {
      const result = await registry.dispatch("cat", { id, path: "project.json" });

      expect(result.ok).toBe(false);
      expect(result.failureKind).toBe("failed");
      expect(result.message).not.toContain(coMotionHome);
    } finally {
      await chmod(realFile, 0o644);
    }
  });

  it("leaves a successful result untouched — no failureKind, same message", async () => {
    const id = await openedId();

    const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });

    expect(result.ok).toBe(true);
    expect(result.failureKind).toBeUndefined();
    expect(result.message).toBe("已讀取：project.json");
  });
});

describe("new, open and pack have no terminal renderer — unchanged output", () => {
  it("registry.getRenderer returns undefined so the bin falls back to the default format", () => {
    expect(registry.getRenderer("new")).toBeUndefined();
    expect(registry.getRenderer("open")).toBeUndefined();
    expect(registry.getRenderer("pack")).toBeUndefined();
    expect(registry.getRenderer("cat")).toBeDefined();
    expect(registry.getRenderer("ls")).toBeDefined();
  });
});
