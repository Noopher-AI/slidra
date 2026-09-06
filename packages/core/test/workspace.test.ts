import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { CoMotionError, CoMotionNotFoundError } from "../src/errors.js";
import {
  openPresentation,
  packPresentation,
  readSaveState,
  reopenPresentationInPlace,
  resolveWorkDir,
  savePresentation,
} from "../src/workspace.js";

// root ignores permission bits, so the chmod-based failure below can never
// be observed when this process runs as root (CI containers commonly do
// this) — the expected EACCES simply never happens. Skip cleanly rather
// than fail for a reason unrelated to what the test checks.
const isRunningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Every test points CO_MOTION_HOME at its own temp directory so we never
// touch the real ~/.comotion (ADR-0004, ticket #9 testing convention).
let coMotionHome: string;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  process.env.CO_MOTION_HOME = coMotionHome;
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function registryPath(): string {
  return path.join(coMotionHome, "projects.json");
}

describe("a missing registry", () => {
  it("is treated as empty — opening a presentation succeeds and creates the file", async () => {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const comotPath = path.join(comotDir, "deck.comot");
      const { createNewPresentation } = await import("../src/workspace.js");
      await createNewPresentation(comotPath, "測試簡報");

      const { id } = await openPresentation(comotPath);

      expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
      const raw = await readFile(registryPath(), "utf-8");
      expect(JSON.parse(raw)[id]).toBeDefined();
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("a corrupt registry", () => {
  it("raises a CoMotionError instead of being silently replaced, and leaves the file untouched", async () => {
    await mkdir(coMotionHome, { recursive: true });
    await writeFile(registryPath(), "{ not valid json");
    const before = await readFile(registryPath(), "utf-8");

    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const comotPath = path.join(comotDir, "deck.comot");
      const { createNewPresentation } = await import("../src/workspace.js");
      await createNewPresentation(comotPath, "測試簡報");

      await expect(openPresentation(comotPath)).rejects.toThrow(CoMotionError);

      // Previously opened presentations must not become unreachable: the
      // corrupt file must not be overwritten by the failed open.
      const after = await readFile(registryPath(), "utf-8");
      expect(after).toBe(before);
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("inherited property names as ids", () => {
  it.each(["toString", "constructor", "__proto__"])(
    "reports %s as an unknown id instead of crashing",
    async (id) => {
      await expect(packPresentation(id, path.join(coMotionHome, "out.comot"))).rejects.toThrow(CoMotionError);
      await expect(packPresentation(id, path.join(coMotionHome, "out.comot"))).rejects.toThrow(id);
    },
  );
});

describe("a registry write that fails partway through", () => {
  it.skipIf(isRunningAsRoot)(
    "leaves the existing registry byte-identical, never truncated or half-written",
    async () => {
      const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
      try {
        const comotPath = path.join(comotDir, "deck.comot");
        const { createNewPresentation } = await import("../src/workspace.js");
        await createNewPresentation(comotPath, "第一份");

        // A real, successfully-registered presentation already on disk —
        // this is exactly what a failed later write must not lose.
        await openPresentation(comotPath);
        const before = await readFile(registryPath(), "utf-8");
        const workEntriesBefore = await readdir(path.join(coMotionHome, "work"));
        expect(workEntriesBefore).toHaveLength(1);

        // Make CO_MOTION_HOME itself unwritable. writeRegistry must create
        // its temp file directly inside it before renaming, so this blocks
        // exactly that step — while the pre-existing "work" subdirectory
        // (already created by the first open, permissions untouched by this
        // chmod) still accepts the second container's unpack. That isolates
        // the induced failure to the registry write, the same failure a
        // crash or full disk mid-write would cause.
        await chmod(coMotionHome, 0o500);

        try {
          await expect(openPresentation(comotPath)).rejects.toThrow(CoMotionError);
        } finally {
          await chmod(coMotionHome, 0o700);
        }

        // Byte-identical, not merely "still parses": a silent replacement
        // with different-but-valid JSON would pass a looser assertion.
        const after = await readFile(registryPath(), "utf-8");
        expect(after).toBe(before);

        // The second open's unpack succeeded before the registry write
        // failed. Its work directory must have been rolled back, not left
        // behind as an orphan nobody can reach through the registry.
        const workEntriesAfter = await readdir(path.join(coMotionHome, "work"));
        expect(workEntriesAfter).toHaveLength(1);
      } finally {
        await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
});

describe("an invalid container opened repeatedly", () => {
  it("never accumulates orphan work directories on disk", async () => {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      // A real zip whose project.json is missing formatVersion: the unpack
      // itself succeeds and writes real files before validation fails, so
      // this exercises the post-write cleanup path, not just "never wrote
      // anything to begin with".
      const zipped = zipSync({
        "project.json": new TextEncoder().encode(JSON.stringify({ name: "no version" })),
        "slides/": new Uint8Array(0),
        "assets/": new Uint8Array(0),
      });
      const badPath = path.join(comotDir, "no-format-version.comot");
      await writeFile(badPath, zipped);

      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(openPresentation(badPath)).rejects.toThrow(CoMotionError);
      }

      // Every attempt failed before ever registering anything, so "work"
      // may not exist at all — but if it does, it must be empty: no
      // per-attempt orphan directory left behind.
      const workEntries = await readdir(path.join(coMotionHome, "work")).catch(() => []);
      expect(workEntries).toEqual([]);
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("a registry that exists but cannot be read", () => {
  it.skipIf(isRunningAsRoot)(
    "raises a plain CoMotionError, not CoMotionNotFoundError, so callers know this is not a 'not found'",
    async () => {
      const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
      try {
        const comotPath = path.join(comotDir, "deck.comot");
        const { createNewPresentation } = await import("../src/workspace.js");
        await createNewPresentation(comotPath, "測試簡報");
        const { id } = await openPresentation(comotPath);

        // A real permission failure on projects.json itself — not a mock of
        // readFile — the same EACCES class of failure the
        // CoMotionNotFoundError distinction (ticket #11, fourth fix round)
        // must NOT be granted: this is an operational failure, one layer
        // above virtual-fs.ts's tree walk, every id-to-workDir lookup reads
        // this file before any virtual path is ever resolved.
        await chmod(registryPath(), 0o000);

        try {
          const failure = packPresentation(id, path.join(coMotionHome, "out.comot"));
          await expect(failure).rejects.toThrow(CoMotionError);
          await expect(failure).rejects.not.toBeInstanceOf(CoMotionNotFoundError);
        } finally {
          await chmod(registryPath(), 0o644);
        }
      } finally {
        await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
});

describe("a malformed registry entry", () => {
  it("raises a CoMotionError at lookup time instead of surfacing as undefined later", async () => {
    await mkdir(coMotionHome, { recursive: true });
    // A shape a hand-edited or partially-written projects.json could have:
    // the key exists, but the value has no usable workDir.
    await writeFile(registryPath(), JSON.stringify({ "malformed-id-000000": { notWorkDir: true } }));

    await expect(packPresentation("malformed-id-000000", path.join(coMotionHome, "out.comot"))).rejects.toThrow(
      CoMotionError,
    );
  });
});

describe("readSaveState (NOOP-93)", () => {
  it("reports known:false for a pre-existing registry entry with no sourcePath/savedAt", async () => {
    await mkdir(coMotionHome, { recursive: true });
    await writeFile(registryPath(), JSON.stringify({ "legacy-id-000000": { workDir: "/irrelevant" } }));

    await expect(readSaveState("legacy-id-000000")).resolves.toEqual({ known: false });
  });

  it("is clean right after open, dirty after an on-disk change, and clean again after packing back to sourcePath", async () => {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const comotPath = path.join(comotDir, "deck.comot");
      const { createNewPresentation } = await import("../src/workspace.js");
      await createNewPresentation(comotPath, "測試簡報");
      const { id } = await openPresentation(comotPath);

      await expect(readSaveState(id)).resolves.toEqual({ known: true, dirty: false, fileName: "deck.comot" });

      const workDir = await resolveWorkDir(id);
      await writeFile(path.join(workDir, "slides", "001.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
      await expect(readSaveState(id)).resolves.toEqual({ known: true, dirty: true, fileName: "deck.comot" });

      await packPresentation(id, comotPath);
      await expect(readSaveState(id)).resolves.toEqual({ known: true, dirty: false, fileName: "deck.comot" });
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("stays dirty after packing to a different path than sourcePath", async () => {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const comotPath = path.join(comotDir, "deck.comot");
      const otherPath = path.join(comotDir, "elsewhere.comot");
      const { createNewPresentation } = await import("../src/workspace.js");
      await createNewPresentation(comotPath, "測試簡報");
      const { id } = await openPresentation(comotPath);

      const workDir = await resolveWorkDir(id);
      await writeFile(path.join(workDir, "slides", "001.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
      await packPresentation(id, otherPath);

      await expect(readSaveState(id)).resolves.toEqual({ known: true, dirty: true, fileName: "deck.comot" });
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("reopenPresentationInPlace (NOOP-93)", () => {
  it("swaps the work directory's content in place, keeps the same id, and clears undo history", async () => {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const firstPath = path.join(comotDir, "first.comot");
      const secondPath = path.join(comotDir, "second.comot");
      const { createNewPresentation } = await import("../src/workspace.js");
      await createNewPresentation(firstPath, "第一份簡報");
      await createNewPresentation(secondPath, "第二份簡報");
      const { id } = await openPresentation(firstPath);
      const workDir = await resolveWorkDir(id);

      // Simulate existing undo history for this id — reopen must delete it.
      const historyDir = path.join(coMotionHome, "history", id);
      await mkdir(historyDir, { recursive: true });
      await writeFile(path.join(historyDir, "stack.json"), "[]");

      await reopenPresentationInPlace(id, secondPath);

      // Same id, same work directory path, new content.
      expect(await resolveWorkDir(id)).toBe(workDir);
      const projectJson = JSON.parse(await readFile(path.join(workDir, "project.json"), "utf-8"));
      expect(projectJson.name).toBe("第二份簡報");

      await expect(readSaveState(id)).resolves.toEqual({ known: true, dirty: false, fileName: "second.comot" });
      await expect(readdir(historyDir).catch(() => null)).resolves.toBeNull();
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("leaves the work directory's existing content untouched when the replacement container is invalid", async () => {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const firstPath = path.join(comotDir, "first.comot");
      const brokenPath = path.join(comotDir, "broken.comot");
      const { createNewPresentation } = await import("../src/workspace.js");
      await createNewPresentation(firstPath, "第一份簡報");
      await writeFile(brokenPath, "not a zip file");
      const { id } = await openPresentation(firstPath);
      const workDir = await resolveWorkDir(id);

      await expect(reopenPresentationInPlace(id, brokenPath)).rejects.toThrow(CoMotionError);

      const projectJson = JSON.parse(await readFile(path.join(workDir, "project.json"), "utf-8"));
      expect(projectJson.name).toBe("第一份簡報");
      await expect(readSaveState(id)).resolves.toEqual({ known: true, dirty: false, fileName: "first.comot" });
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("savePresentation (NOOP-93)", () => {
  it("packs back to sourcePath and clears dirty", async () => {
    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const comotPath = path.join(comotDir, "deck.comot");
      const { createNewPresentation } = await import("../src/workspace.js");
      await createNewPresentation(comotPath, "測試簡報");
      const { id } = await openPresentation(comotPath);
      const workDir = await resolveWorkDir(id);
      await writeFile(path.join(workDir, "slides", "001.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");

      await expect(savePresentation(id)).resolves.toEqual({ fileName: "deck.comot" });
      await expect(readSaveState(id)).resolves.toEqual({ known: true, dirty: false, fileName: "deck.comot" });

      const raw = await readFile(comotPath);
      expect(raw.length).toBeGreaterThan(0);
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refuses without writing when the registry entry has no sourcePath", async () => {
    await mkdir(coMotionHome, { recursive: true });
    const workDir = path.join(coMotionHome, "work", "no-source-id");
    await mkdir(path.join(workDir, "slides"), { recursive: true });
    await mkdir(path.join(workDir, "assets"), { recursive: true });
    await mkdir(path.join(workDir, "fonts"), { recursive: true });
    await writeFile(registryPath(), JSON.stringify({ "no-source-id": { workDir } }));

    await expect(savePresentation("no-source-id")).rejects.toThrow(CoMotionError);
    await expect(savePresentation("no-source-id")).rejects.toThrow("沒有可寫回的檔案路徑");
  });
});
