import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { openPresentation, packPresentation } from "../src/workspace.js";

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
