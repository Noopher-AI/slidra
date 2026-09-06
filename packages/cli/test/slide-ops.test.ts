import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import { checkSlideCompliance } from "@co-motion/core";

/**
 * T3: `slide add / delete / duplicate / move` and `template add`. Every
 * assertion goes through `registry.dispatch` (the public boundary this
 * ticket's plan names) and reads state back out through `cat`/`ls`, never
 * by importing `slide-ops.ts`'s internals directly.
 */

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

async function openFreshPresentation(): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function readProject(id: string): Promise<any> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
  return JSON.parse(result.data!.content);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("slide add", () => {
  it("AC1: 空白投影片新增後 slides 長度 +1，新檔存在且合規", async () => {
    const id = await openFreshPresentation();
    const before = await readProject(id);
    expect(before.slides.length).toBe(1);

    const result = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(result.ok).toBe(true);
    const slidePath = result.data!.slidePath;

    const after = await readProject(id);
    expect(after.slides.length).toBe(2);
    expect(after.slides).toContain(slidePath);

    const slide = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
    expect(slide.ok).toBe(true);
    expect(checkSlideCompliance(slide.data!.content)).toEqual([]);
  });

  it("--at 0 插在最前面", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch<{ slidePath: string }>("slide add", { id, at: 0 });
    const after = await readProject(id);
    expect(after.slides[0]).toBe(result.data!.slidePath);
  });

  it("--at 超出範圍時明確報錯，不 clamp", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide add", { id, at: 99 });
    expect(result.ok).toBe(false);
  });

  it("--at 非整數時明確報錯", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide add", { id, at: 1.5 });
    expect(result.ok).toBe(false);
  });

  it("新檔名為三位數編號，補上被刪除的最小可用編號而非一路遞增", async () => {
    const id = await openFreshPresentation(); // slides/001.svg already exists
    const second = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(second.data!.slidePath).toBe("slides/002.svg");
    await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
    const third = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(third.data!.slidePath).toBe("slides/001.svg");
  });

  it("AC2: --template 套用後元素視覺一一對應，但 id 全部不同，鎖定標記原樣帶過去", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id }); // templates/001.svg, blank
    // Build up the template's content directly via element insert.
    await registry.dispatch("element insert", {
      id,
      slidePath: "templates/001.svg",
      kind: "rect",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
    const templateBefore = await registry.dispatch<{ content: string }>("cat", { id, path: "templates/001.svg" });
    const templateElementIdMatch = /id="(el-[^"]+)"/.exec(templateBefore.data!.content);
    expect(templateElementIdMatch).not.toBeNull();
    const templateElementId = templateElementIdMatch![1];
    await registry.dispatch("element lock", {
      id,
      slidePath: "templates/001.svg",
      elementIds: [templateElementId],
    });

    const added = await registry.dispatch<{ slidePath: string }>("slide add", {
      id,
      templatePath: "templates/001.svg",
    });
    expect(added.ok).toBe(true);
    const newSlide = await registry.dispatch<{ content: string }>("cat", { id, path: added.data!.slidePath });
    expect(newSlide.data!.content).toContain('width="100"');
    expect(newSlide.data!.content).toContain('height="50"');
    expect(newSlide.data!.content).toContain('data-comot-lock="true"');
    expect(newSlide.data!.content).not.toContain(templateElementId);
  });

  it("--template 指向不存在的路徑：CoMotionNotFoundError", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide add", { id, templatePath: "templates/999.svg" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });

  it("--template 指向一個 slide 而非 template：明確報錯，不容錯當成 slide 用", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide add", { id, templatePath: "slides/001.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是範本");
  });
});

describe("template add / 脫鉤 (AC3)", () => {
  it("套用範本後修改範本的鎖定元素（--force），不影響已產生的投影片；反向亦然", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id });
    await registry.dispatch("element insert", {
      id,
      slidePath: "templates/001.svg",
      kind: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: "#111111",
    });
    const templateContent = (await registry.dispatch<{ content: string }>("cat", { id, path: "templates/001.svg" }))
      .data!.content;
    const templateElementId = /id="(el-[^"]+)"/.exec(templateContent)![1];
    await registry.dispatch("element lock", { id, slidePath: "templates/001.svg", elementIds: [templateElementId] });

    const added = await registry.dispatch<{ slidePath: string }>("slide add", {
      id,
      templatePath: "templates/001.svg",
    });
    const slidePath = added.data!.slidePath;
    const slideBefore = (await registry.dispatch<{ content: string }>("cat", { id, path: slidePath })).data!.content;

    // Change the template's locked element (force required).
    await registry.dispatch("element style set", {
      id,
      slidePath: "templates/001.svg",
      elementIds: [templateElementId],
      attr: "fill",
      value: "#ff0000",
      force: true,
    });
    const slideAfterTemplateEdit = (await registry.dispatch<{ content: string }>("cat", { id, path: slidePath }))
      .data!.content;
    expect(slideAfterTemplateEdit).toBe(slideBefore);

    // Reverse: change the derived slide, template must stay untouched.
    const slideElementId = /id="(el-[^"]+)"/.exec(slideAfterTemplateEdit)![1];
    const templateBeforeSlideEdit = (
      await registry.dispatch<{ content: string }>("cat", { id, path: "templates/001.svg" })
    ).data!.content;
    await registry.dispatch("element style set", {
      id,
      slidePath,
      elementIds: [slideElementId],
      attr: "fill",
      value: "#00ff00",
      force: true,
    });
    const templateAfterSlideEdit = (
      await registry.dispatch<{ content: string }>("cat", { id, path: "templates/001.svg" })
    ).data!.content;
    expect(templateAfterSlideEdit).toBe(templateBeforeSlideEdit);
  });

  it("套用範本或複製投影片後，程式碼裡不留下任何指回範本的欄位、id 或註記", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id });
    const added = await registry.dispatch<{ slidePath: string }>("slide add", {
      id,
      templatePath: "templates/001.svg",
    });
    const slide = (await registry.dispatch<{ content: string }>("cat", { id, path: added.data!.slidePath })).data!
      .content;
    expect(slide).not.toContain("template");
  });
});

describe("template add", () => {
  it("AC8: 無 --from 建立空白範本並登記進 templates（[E4.T7]：物件格式，name 預設為檔名）", async () => {
    const id = await openFreshPresentation();
    const before = await readProject(id);
    expect(before.templates).toBeUndefined();

    const result = await registry.dispatch<{ templatePath: string }>("template add", { id });
    expect(result.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates).toEqual([{ file: result.data!.templatePath, name: "001" }]);
  });

  it("--from 指向一張投影片，複製其內容並重新 mint id", async () => {
    const id = await openFreshPresentation();
    const original = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" })).data!
      .content;
    const originalId = /id="([^"]+)"/.exec(original)![1];

    const result = await registry.dispatch<{ templatePath: string }>("template add", { id, from: "slides/001.svg" });
    const templateContent = (
      await registry.dispatch<{ content: string }>("cat", { id, path: result.data!.templatePath })
    ).data!.content;
    expect(templateContent).not.toContain(originalId);
  });

  it("--from 指向不存在的路徑：CoMotionNotFoundError", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("template add", { id, from: "slides/999.svg" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });

  it("範本套用既有 element insert / style set 直接編輯（放寬 assertSlidePathListed）", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch<{ templatePath: string }>("template add", { id });
    const insertResult = await registry.dispatch("element insert", {
      id,
      slidePath: result.data!.templatePath,
      kind: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(insertResult.ok).toBe(true);
  });
});

describe("slide delete", () => {
  it("AC4: 刪除後路徑不在 slides、實體檔不存在；undo 之後檔案與順序完全還原", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide add", { id }); // now 2 slides
    const before = await readProject(id);
    expect(before.slides.length).toBe(2);

    const del = await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
    expect(del.ok).toBe(true);
    const afterDelete = await readProject(id);
    expect(afterDelete.slides).not.toContain("slides/001.svg");
    expect(afterDelete.slides.length).toBe(1);

    const catAfterDelete = await registry.dispatch("cat", { id, path: "slides/001.svg" });
    expect(catAfterDelete.ok).toBe(false);

    await registry.dispatch("undo", { id });
    const afterUndo = await readProject(id);
    expect(afterUndo.slides).toEqual(before.slides);
    const catAfterUndo = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(catAfterUndo.ok).toBe(true);
  });

  it("允許刪成 0 張投影片", async () => {
    const id = await openFreshPresentation();
    const del = await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
    expect(del.ok).toBe(true);
    const after = await readProject(id);
    expect(after.slides).toEqual([]);
  });

  it("路徑不在 slides：不是投影片", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide delete", { id, slidePath: "slides/999.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是投影片");
  });

  it("刪除有鎖定元素的投影片：照刪，不需要 --force", async () => {
    const id = await openFreshPresentation();
    const content = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" })).data!
      .content;
    const elementId = /id="([^"]+)"/.exec(content)![1];
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });

    const del = await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
    expect(del.ok).toBe(true);
  });
});

describe("slide duplicate", () => {
  it("AC5: 新項緊接在來源之後；兩張元素 id 無交集；備忘稿一起複製", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "講者備忘稿" });

    const result = await registry.dispatch<{ slidePath: string }>("slide duplicate", {
      id,
      slidePath: "slides/001.svg",
    });
    expect(result.ok).toBe(true);
    const project = await readProject(id);
    const sourceIndex = project.slides.indexOf("slides/001.svg");
    expect(project.slides[sourceIndex + 1]).toBe(result.data!.slidePath);

    const source = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" })).data!
      .content;
    const copy = (await registry.dispatch<{ content: string }>("cat", { id, path: result.data!.slidePath })).data!
      .content;
    const sourceIds = [...source.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const copyIds = [...copy.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(sourceIds.some((sid) => copyIds.includes(sid))).toBe(false);
    expect(copy).toContain('<comot:notes xmlns:comot="https://co-motion.dev/ns">講者備忘稿</comot:notes>');
  });

  it("範本路徑：拒絕，提示改用 template add --from", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id });
    const result = await registry.dispatch("slide duplicate", { id, slidePath: "templates/001.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是投影片");
  });

  it("路徑不在 slides：不是投影片", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide duplicate", { id, slidePath: "slides/999.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是投影片");
  });
});

describe("slide move", () => {
  it("AC6: 只改順序，任何 SVG 檔案位元組完全不變", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide add", { id }); // slides/002.svg
    const before1 = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" })).data!
      .content;
    const before2 = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/002.svg" })).data!
      .content;

    const result = await registry.dispatch("slide move", { id, slidePath: "slides/002.svg", newIndex: 0 });
    expect(result.ok).toBe(true);
    const project = await readProject(id);
    expect(project.slides).toEqual(["slides/002.svg", "slides/001.svg"]);

    const after1 = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" })).data!
      .content;
    const after2 = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/002.svg" })).data!
      .content;
    expect(sha256(after1)).toBe(sha256(before1));
    expect(sha256(after2)).toBe(sha256(before2));
  });

  it("new-index 等於現在位置：合法，不報錯", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide move", { id, slidePath: "slides/001.svg", newIndex: 0 });
    expect(result.ok).toBe(true);
  });

  it("new-index 越界時明確報錯，不 clamp", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide move", { id, slidePath: "slides/001.svg", newIndex: 5 });
    expect(result.ok).toBe(false);
  });

  it("new-index 非整數時明確報錯", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide move", { id, slidePath: "slides/001.svg", newIndex: 0.5 });
    expect(result.ok).toBe(false);
  });
});

describe("AC13: 向後相容", () => {
  it("沒有 templates/transition 欄位的舊 .comot 能開啟並成功 slide add 與 text set", async () => {
    const id = await openFreshPresentation();
    // Simulate a pre-T3 project.json by writing one with no templates/transition field
    // through the existing public write surface only (cat confirms shape).
    const project = await readProject(id);
    expect(project.templates).toBeUndefined();
    expect(project.transition).toBeUndefined();

    const addResult = await registry.dispatch("slide add", { id });
    expect(addResult.ok).toBe(true);

    const content = (await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" })).data!
      .content;
    const elementId = /id="([^"]+)"/.exec(content)![1];
    const textResult = await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "新文字" });
    expect(textResult.ok).toBe(true);
  });
});
