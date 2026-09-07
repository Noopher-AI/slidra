import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { createNewPresentation, openPresentation, readPresentationFile, writePresentationFile } from "../src/workspace.js";
import { addSlide, buildBlankSlideSvg } from "../src/slide-ops.js";
import { undoLastGroup } from "../src/history.js";
import { setSlideViewBox, setPresentationCanvas } from "../src/presentation-canvas.js";

let coMotionHome: string;
let comotDir: string;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A fresh presentation with its title slide replaced by a compliant blank slide — `buildMinimalPresentation`'s own title slide is the pre-conversion legacy form (a bare `<text>`), which every editing command rejects. */
async function newDeck(): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await createNewPresentation(comotPath, "畫布尺寸測試");
  const { id } = await openPresentation(comotPath);
  await writePresentationFile(id, "slides/001.svg", buildBlankSlideSvg({ width: 1280, height: 720 }));
  return id;
}

describe("setSlideViewBox（純函式）", () => {
  it("只改 viewBox，元素的 transform 逐字保留", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><g id="el-a" transform="translate(80 80)"><rect x="0" y="0" width="10" height="10"/></g></svg>\n`;
    const updated = setSlideViewBox(svg, "slides/001.svg", 1024, 768);
    expect(updated).toContain('viewBox="0 0 1024 768"');
    expect(updated).toContain('transform="translate(80 80)"');
  });
});

describe("setPresentationCanvas（#200 §4.3/§4.4）", () => {
  it("改 project.json 的 canvas 與每張投影片的 viewBox，元素座標不動", async () => {
    const id = await newDeck();
    await addSlide(id); // 現在有兩張投影片，都是空白 1280x720

    const result = await setPresentationCanvas(id, 1024, 768);
    expect(result).toEqual({ width: 1024, height: 768 });

    const project = JSON.parse(await readPresentationFile(id, "project.json"));
    expect(project.canvas).toEqual({ width: 1024, height: 768 });

    for (const slidePath of project.slides as string[]) {
      const svg = await readPresentationFile(id, slidePath);
      expect(svg).toContain('viewBox="0 0 1024 768"');
    }
  });

  it("值域拒絕：非正整數或超出 320–4096 一律拒絕，不寫檔", async () => {
    const id = await newDeck();
    const before = await readPresentationFile(id, "project.json");

    await expect(setPresentationCanvas(id, 100, 720)).rejects.toThrow(CoMotionError);
    await expect(setPresentationCanvas(id, 1280, 5000)).rejects.toThrow(CoMotionError);
    await expect(setPresentationCanvas(id, 1280.5, 720)).rejects.toThrow(CoMotionError);

    expect(await readPresentationFile(id, "project.json")).toBe(before);
  });

  it("同值 no-op：不寫檔，不改動任何位元組", async () => {
    const id = await newDeck();
    const before = await readPresentationFile(id, "project.json");
    const beforeSlide = await readPresentationFile(id, "slides/001.svg");

    const result = await setPresentationCanvas(id, 1280, 720);
    expect(result).toEqual({ width: 1280, height: 720 });
    expect(await readPresentationFile(id, "project.json")).toBe(before);
    expect(await readPresentationFile(id, "slides/001.svg")).toBe(beforeSlide);
  });

  it("不入歷史：project.json 的 canvas 記錄，以及未被那次 undo 觸及的其他投影片，尺寸都維持新值", async () => {
    const id = await newDeck();
    await addSlide(id); // slides/002.svg
    // 只對 001 做一次內容編輯（這是 undo 真正要復原的那一筆）。
    const original = await readPresentationFile(id, "slides/001.svg");
    await writePresentationFile(id, "slides/001.svg", original.replace("</svg>", '<g id="el-x"><rect x="0" y="0" width="1" height="1"/></g></svg>'));

    await setPresentationCanvas(id, 1024, 768);

    const { restoredPaths } = await undoLastGroup(id);
    expect(restoredPaths).toEqual(["slides/001.svg"]);

    // project.json 從未進過任何 undo 群組（canvas set 完全繞過歷史），尺寸不受這次 undo 影響。
    const project = JSON.parse(await readPresentationFile(id, "project.json"));
    expect(project.canvas).toEqual({ width: 1024, height: 768 });
    // 002 沒有被那筆內容編輯觸及，它的 viewBox 同樣不受這次 undo 影響。
    expect(await readPresentationFile(id, "slides/002.svg")).toContain('viewBox="0 0 1024 768"');
    // 001 本身：undo 復原的是「該檔案在內容編輯之前的完整位元組」，那個快照本來就
    // 是 canvas set 之前的舊 viewBox——同一個檔案被「不入歷史的寫入」與「入歷史的
    // 寫入」前後夾擊時，逐檔快照式 undo 沒有辦法只復原內容、留下 viewBox，這是
    // history.ts 全檔快照機制的既有限制，不是本票新增的行為。
    const slide001 = await readPresentationFile(id, "slides/001.svg");
    expect(slide001).not.toContain("el-x");
    expect(slide001).toContain('viewBox="0 0 1280 720"');
  });
});
