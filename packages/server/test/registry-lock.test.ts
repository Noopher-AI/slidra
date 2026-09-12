import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withProjectsRegistryLock } from "../src/comotion/home.js";

// The advisory lock around a `projects.json` read-modify-write. It exists
// because two `co-motion serve` processes (or a `serve` and a CLI run) can
// write the registry at the same moment: both sides write through temp file
// + rename, so the file is never torn, but the second writer's whole-map
// write silently drops the first writer's new entry.

/** The one name this lock is allowed to have — the Rust crate hardcodes the same string. */
const LOCK_FILE = ".projects.json.lock";

let coMotionHome: string;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-lock-home-"));
  process.env.CO_MOTION_HOME = coMotionHome;
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
});

const lockPath = (): string => path.join(coMotionHome, LOCK_FILE);

describe("withProjectsRegistryLock", () => {
  it("uses the exact lock filename the Rust crate also hardcodes — the two must never drift", async () => {
    let seen: string[] = [];
    await withProjectsRegistryLock(async () => {
      seen = await readdir(coMotionHome);
    });
    expect(seen).toEqual([LOCK_FILE]);
  });

  it("serialises two overlapping holders — neither sees the other's critical section", async () => {
    const order: string[] = [];
    const hold = (name: string) =>
      withProjectsRegistryLock(async () => {
        order.push(`${name}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(`${name}:exit`);
      });

    await Promise.all([hold("a"), hold("b")]);

    // Whoever went first, the two sections never interleave.
    expect(order).toEqual(
      order[0] === "a:enter"
        ? ["a:enter", "a:exit", "b:enter", "b:exit"]
        : ["b:enter", "b:exit", "a:enter", "a:exit"],
    );
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withProjectsRegistryLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(stat(lockPath())).rejects.toThrow();
    // And the next caller gets in.
    expect(await withProjectsRegistryLock(async () => "second")).toBe("second");
  });

  it("steals a lock left behind by a process that died holding it", async () => {
    await writeFile(lockPath(), "");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath(), longAgo, longAgo);

    expect(await withProjectsRegistryLock(async () => "got in")).toBe("got in");
  });

  it("gives up with a readable error when a live holder never lets go", async () => {
    await writeFile(lockPath(), "");

    await expect(withProjectsRegistryLock(async () => "never runs")).rejects.toThrow(
      "另一個 co-motion 正在寫入簡報登記資料，請稍後再試",
    );
  }, 15_000);
});
