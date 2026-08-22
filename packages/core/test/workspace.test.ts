import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { CoMotionError } from "../src/errors.js";
import { openPresentation, packPresentation } from "../src/workspace.js";

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
  await rm(coMotionHome, { recursive: true, force: true });
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
      await rm(comotDir, { recursive: true, force: true });
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
      await rm(comotDir, { recursive: true, force: true });
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
        await rm(comotDir, { recursive: true, force: true });
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
      await rm(comotDir, { recursive: true, force: true });
    }
  });
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
