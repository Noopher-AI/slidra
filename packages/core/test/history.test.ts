import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// root ignores permission bits, so the chmod-based write failure below can
// never be observed when this process runs as root (CI containers commonly
// do this) — the expected EACCES simply never happens. Skip cleanly rather
// than fail for a reason unrelated to what the test checks.
const isRunningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Every test points CO_MOTION_HOME at its own temp directory so we never
// touch the real ~/.comotion (ADR-0004, ticket #9 testing convention).
let coMotionHome: string;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.doUnmock("../src/history.js");
  vi.resetModules();
});

// NOOP-337: e2e/direct-manipulation.test.ts's "雙擊進入群組後拖曳群組內的單一
// 子元素" hit undo `ok: false` on CI ~20% of the time. Root cause, confirmed
// by widening the window locally: `writePresentationFile` used to make the
// new content visible on disk (`writeFile(realPath, ...)`) *before*
// `commitSnapshotEntries` made the matching undo group durable — a caller
// that reads the new content and then immediately calls undo (exactly what
// the e2e test's fixed-delay `dragBy` + `readSlide` + `undo` sequence does)
// could land in the gap and see "沒有可復原的操作". This test proves the
// invariant structurally, at `commitSnapshotEntries`'s call boundary, rather
// than relying on the e2e test's timing to happen to hit the old window.
describe("writePresentationFile: undo commit vs content visibility ordering", () => {
  it("the file on disk still holds the OLD content at the exact moment the undo group is committed", async () => {
    const diskContentAtCommitTime: string[] = [];

    vi.doMock("../src/history.js", async () => {
      const real = await vi.importActual<typeof import("../src/history.js")>("../src/history.js");
      return {
        ...real,
        commitSnapshotEntries: async (id: string, entries: Parameters<typeof real.commitSnapshotEntries>[1]) => {
          const { readPresentationFile } = await import("../src/workspace.js");
          for (const entry of entries) {
            diskContentAtCommitTime.push(await readPresentationFile(id, entry.virtualPath));
          }
          return real.commitSnapshotEntries(id, entries);
        },
      };
    });

    const { createNewPresentation, openPresentation, writePresentationFile, readPresentationFile } = await import(
      "../src/workspace.js"
    );
    const { SLIDE_FILE_NAME } = await import("../src/presentation.js");

    const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    try {
      const comotPath = path.join(comotDir, "deck.comot");
      await createNewPresentation(comotPath, "測試簡報");
      const { id } = await openPresentation(comotPath);
      const before = await readPresentationFile(id, SLIDE_FILE_NAME);
      const after = before.replace("<svg", '<svg data-noop-337-probe="1"');
      expect(after).not.toBe(before);

      await writePresentationFile(id, SLIDE_FILE_NAME, after);

      expect(diskContentAtCommitTime).toEqual([before]);
      expect(diskContentAtCommitTime[0]).not.toBe(after);
    } finally {
      await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

// NOOP-333 Fix.7r2 (Review NOOP-336 FAIL finding c): `writePresentationFile`
// commits the undo group (clearing redo, possibly evicting the oldest undo
// group) *before* the content write, per NOOP-337 above. If that write then
// fails, the commit must be fully reverted, including the redo/eviction it
// already cleared — not just the group it pushed. The earlier fix only
// undid the push, so a write failure right after an undo (which had just
// populated redo) silently destroyed that redo entry even though the edit
// that cleared it never took visible effect.
describe("writePresentationFile: commit rollback on write failure", () => {
  it.skipIf(isRunningAsRoot)(
    "a write failure after undo does not lose the redo entry it would have cleared",
    async () => {
      const { createNewPresentation, openPresentation, writePresentationFile, readPresentationFile } = await import(
        "../src/workspace.js"
      );
      const { undoLastGroup, redoLastGroup } = await import("../src/history.js");
      const { SLIDE_FILE_NAME } = await import("../src/presentation.js");
      const { CoMotionError } = await import("../src/errors.js");

      const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
      try {
        const comotPath = path.join(comotDir, "deck.comot");
        await createNewPresentation(comotPath, "測試簡報");
        const { id } = await openPresentation(comotPath);

        const original = await readPresentationFile(id, SLIDE_FILE_NAME);
        const edited = original.replace("<svg", '<svg data-noop-333-r2="1"');
        expect(edited).not.toBe(original);

        // A successful edit, then undo — this populates the redo stack with
        // exactly one entry that would restore `edited`.
        await writePresentationFile(id, SLIDE_FILE_NAME, edited);
        await undoLastGroup(id);
        expect(await readPresentationFile(id, SLIDE_FILE_NAME)).toBe(original);

        // Make the slide file read-only so the next writePresentationFile's
        // content write fails after it has already committed (and thereby
        // would have cleared) the redo entry above.
        const slidePath = path.join(coMotionHome, "work", id, SLIDE_FILE_NAME);
        await chmod(slidePath, 0o400);
        try {
          await expect(writePresentationFile(id, SLIDE_FILE_NAME, "<svg>unreachable</svg>")).rejects.toThrow(
            CoMotionError,
          );
        } finally {
          await chmod(slidePath, 0o600);
        }

        // The failed write must not have taken visible effect...
        expect(await readPresentationFile(id, SLIDE_FILE_NAME)).toBe(original);

        // ...and the redo entry the commit had cleared must still be there.
        const { restoredPaths } = await redoLastGroup(id);
        expect(restoredPaths).toEqual([SLIDE_FILE_NAME]);
        expect(await readPresentationFile(id, SLIDE_FILE_NAME)).toBe(edited);
      } finally {
        await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
});

// NOOP-333 Fix.7r2, eviction leg: the same rollback must also restore an
// undo group the commit cap-evicted (UNDO_STACK_CAP = 50), not only redo.
describe("writePresentationFile: commit rollback restores a cap-evicted undo group", () => {
  it.skipIf(isRunningAsRoot)(
    "a write failure after the 51st edit does not lose the oldest undo group",
    async () => {
      const { createNewPresentation, openPresentation, writePresentationFile, readPresentationFile } = await import(
        "../src/workspace.js"
      );
      const { undoLastGroup } = await import("../src/history.js");
      const { SLIDE_FILE_NAME } = await import("../src/presentation.js");
      const { CoMotionError } = await import("../src/errors.js");

      const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
      try {
        const comotPath = path.join(comotDir, "deck.comot");
        await createNewPresentation(comotPath, "測試簡報");
        const { id } = await openPresentation(comotPath);

        const original = await readPresentationFile(id, SLIDE_FILE_NAME);

        // 50 successful edits fill the undo stack to its cap.
        let content = original;
        for (let i = 0; i < 50; i++) {
          content = `${content}<!--${i}-->`;
          await writePresentationFile(id, SLIDE_FILE_NAME, content);
        }

        // A failing 51st edit would evict the oldest undo group (the one
        // undoing back to `original`) as part of its commit.
        const slidePath = path.join(coMotionHome, "work", id, SLIDE_FILE_NAME);
        await chmod(slidePath, 0o400);
        try {
          await expect(writePresentationFile(id, SLIDE_FILE_NAME, "<svg>unreachable</svg>")).rejects.toThrow(
            CoMotionError,
          );
        } finally {
          await chmod(slidePath, 0o600);
        }

        // Undoing all 50 real edits must still reach the untouched original
        // — the oldest undo group must not have been evicted by the failed
        // 51st commit.
        for (let i = 0; i < 50; i++) {
          await undoLastGroup(id);
        }
        expect(await readPresentationFile(id, SLIDE_FILE_NAME)).toBe(original);
      } finally {
        await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
});
