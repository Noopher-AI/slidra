import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
