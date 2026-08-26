import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBlankSlideSvg,
  insertSlidePathAt,
  moveSlidePath,
  nextSlideFileName,
  removeSlidePath,
} from "../src/slide/order.js";
import { CoMotionNotFoundError } from "../src/errors.js";
import { applyPresentationChanges, createNewPresentation, openPresentation, readPresentationFile } from "../src/workspace.js";
import { redoLastGroup, undoLastGroup } from "../src/history.js";

describe("insertSlidePathAt", () => {
  it("inserts at a 1-based middle position, shifting later entries right", () => {
    expect(insertSlidePathAt(["a.svg", "b.svg"], "x.svg", 2)).toEqual(["a.svg", "x.svg", "b.svg"]);
  });

  it("--at one past the last slide appends", () => {
    expect(insertSlidePathAt(["a.svg", "b.svg"], "x.svg", 3)).toEqual(["a.svg", "b.svg", "x.svg"]);
  });

  it("--at 1 inserts before every existing slide", () => {
    expect(insertSlidePathAt(["a.svg"], "x.svg", 1)).toEqual(["x.svg", "a.svg"]);
  });

  it("throws naming the legal range for 0", () => {
    expect(() => insertSlidePathAt(["a.svg"], "x.svg", 0)).toThrow("--at 必須是 1 到 2 之間的整數");
  });

  it("throws naming the legal range for a negative value", () => {
    expect(() => insertSlidePathAt(["a.svg"], "x.svg", -1)).toThrow("--at 必須是 1 到 2 之間的整數");
  });

  it("throws naming the legal range for one past the max", () => {
    expect(() => insertSlidePathAt(["a.svg"], "x.svg", 3)).toThrow("--at 必須是 1 到 2 之間的整數");
  });

  it("throws naming the legal range for a non-integer", () => {
    expect(() => insertSlidePathAt(["a.svg"], "x.svg", 1.5)).toThrow("--at 必須是 1 到 2 之間的整數");
  });

  it("throws naming the legal range for NaN", () => {
    expect(() => insertSlidePathAt(["a.svg"], "x.svg", NaN)).toThrow("--at 必須是 1 到 2 之間的整數");
  });
});

describe("removeSlidePath", () => {
  it("removes the named slide, leaving the rest in order", () => {
    expect(removeSlidePath(["a.svg", "b.svg", "c.svg"], "b.svg")).toEqual(["a.svg", "c.svg"]);
  });

  it("throws 不是投影片 for a path not in the list", () => {
    expect(() => removeSlidePath(["a.svg"], "z.svg")).toThrow("不是投影片：z.svg");
  });

  it("throws naming the corrupt duplicate rather than guessing which occurrence was meant", () => {
    expect(() => removeSlidePath(["a.svg", "a.svg"], "a.svg")).toThrow("簡報設定檔的投影片順序重複：a.svg");
  });

  it("refuses to remove the last remaining slide", () => {
    expect(() => removeSlidePath(["a.svg"], "a.svg")).toThrow("簡報至少要有一張投影片，無法刪除");
  });
});

describe("moveSlidePath", () => {
  it("moves a slide earlier, shifting the ones in between later", () => {
    expect(moveSlidePath(["a.svg", "b.svg", "c.svg"], "c.svg", 1)).toEqual(["c.svg", "a.svg", "b.svg"]);
  });

  it("moves a slide later, shifting the ones in between earlier", () => {
    expect(moveSlidePath(["a.svg", "b.svg", "c.svg"], "a.svg", 3)).toEqual(["b.svg", "c.svg", "a.svg"]);
  });

  it("--to equal to the slide's current 1-based position returns a content-equal array", () => {
    const slides = ["a.svg", "b.svg", "c.svg"];
    expect(moveSlidePath(slides, "b.svg", 2)).toEqual(slides);
  });

  it("throws 不是投影片 for a path not in the list", () => {
    expect(() => moveSlidePath(["a.svg"], "z.svg", 1)).toThrow("不是投影片：z.svg");
  });

  it("throws naming the corrupt duplicate rather than guessing which occurrence was meant", () => {
    expect(() => moveSlidePath(["a.svg", "a.svg"], "a.svg", 1)).toThrow("簡報設定檔的投影片順序重複：a.svg");
  });

  it("throws naming the legal range for 0", () => {
    expect(() => moveSlidePath(["a.svg", "b.svg"], "a.svg", 0)).toThrow("--to 必須是 1 到 2 之間的整數");
  });

  it("throws naming the legal range for one past the max (--to has no +1 slack, unlike --at)", () => {
    expect(() => moveSlidePath(["a.svg", "b.svg"], "a.svg", 3)).toThrow("--to 必須是 1 到 2 之間的整數");
  });

  it("throws naming the legal range for a non-integer", () => {
    expect(() => moveSlidePath(["a.svg", "b.svg"], "a.svg", 1.5)).toThrow("--to 必須是 1 到 2 之間的整數");
  });
});

describe("nextSlideFileName", () => {
  it("allocates one past the highest NNN.svg name found", () => {
    expect(nextSlideFileName(["001.svg", "004.svg"])).toBe("005.svg");
  });

  it("starts from 001 when the directory is empty", () => {
    expect(nextSlideFileName([])).toBe("001.svg");
  });

  it("ignores non-numeric / non-matching names for the max", () => {
    expect(nextSlideFileName(["001.svg", "cover.svg", "004.svg"])).toBe("005.svg");
  });

  it("pads only up to a minimum of 3 digits — the 1000th slide is 1000.svg, not truncated", () => {
    expect(nextSlideFileName(["999.svg"])).toBe("1000.svg");
  });
});

describe("buildBlankSlideSvg", () => {
  it("produces a compliant, empty <svg> sized to the given canvas", () => {
    expect(buildBlankSlideSvg({ width: 1280, height: 720 })).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n</svg>\n',
    );
  });
});

/**
 * The core module seam for #85's other genuinely hard piece: the
 * absence-aware `applyPresentationChanges` door, observed only through
 * `undoLastGroup` / `redoLastGroup` (per this unit's dispatch — never
 * against history.ts's internals). This is Step 2 of the design, tested
 * before any of the four slide commands exist.
 */
describe("applyPresentationChanges (#85): the absence-aware N-file door", () => {
  let coMotionHome: string;
  let comotDir: string;

  beforeEach(async () => {
    coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
    comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
    process.env.CO_MOTION_HOME = coMotionHome;
  });

  afterEach(async () => {
    delete process.env.CO_MOTION_HOME;
    await rm(coMotionHome, { recursive: true, force: true });
    await rm(comotDir, { recursive: true, force: true });
  });

  async function openFreshPresentation(): Promise<{ id: string }> {
    const comotPath = path.join(comotDir, "deck.comot");
    await createNewPresentation(comotPath, "door測試");
    return openPresentation(comotPath);
  }

  it("creating a file through the door: undo removes it, redo brings it back", async () => {
    const { id } = await openFreshPresentation();
    const newSlide = "slides/002.svg";
    const content = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n</svg>\n';

    await applyPresentationChanges(id, [{ virtualPath: newSlide, content }]);
    expect(await readPresentationFile(id, newSlide)).toBe(content);

    await undoLastGroup(id);
    await expect(readPresentationFile(id, newSlide)).rejects.toThrow(CoMotionNotFoundError);

    await redoLastGroup(id);
    expect(await readPresentationFile(id, newSlide)).toBe(content);
  });

  it("deleting a file through the door: undo restores it byte-identical", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    const original = await readPresentationFile(id, slidePath);

    await applyPresentationChanges(id, [{ virtualPath: slidePath, content: null }]);
    await expect(readPresentationFile(id, slidePath)).rejects.toThrow(CoMotionNotFoundError);

    await undoLastGroup(id);
    expect(await readPresentationFile(id, slidePath)).toBe(original);
  });

  it("two files changed in one call is one undo group: undo reverts both together", async () => {
    const { id } = await openFreshPresentation();
    const newSlide = "slides/002.svg";
    const content = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n</svg>\n';
    const originalProjectJson = await readPresentationFile(id, "project.json");
    const updatedProjectJson = originalProjectJson.replace('"slides/001.svg"', '"slides/001.svg",\n    "slides/002.svg"');

    await applyPresentationChanges(id, [
      { virtualPath: newSlide, content },
      { virtualPath: "project.json", content: updatedProjectJson },
    ]);
    expect(await readPresentationFile(id, "project.json")).toBe(updatedProjectJson);

    await undoLastGroup(id);
    expect(await readPresentationFile(id, "project.json")).toBe(originalProjectJson);
    await expect(readPresentationFile(id, newSlide)).rejects.toThrow(CoMotionNotFoundError);
  });
});
