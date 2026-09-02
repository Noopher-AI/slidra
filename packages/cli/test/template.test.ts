import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import { FORMAT_VERSION } from "@co-motion/core";

/**
 * [E4.T7] core／CLI: `template list` / `template rename` / `template
 * delete`, and `template add --name`. Every assertion goes through
 * `registry.dispatch` (ADR-0002's boundary), never `slide-ops.ts`
 * internals directly — same posture as slide-ops.test.ts.
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

/** Builds and opens a `.comot` whose `project.json` is hand-crafted (bypassing every CLI command, unlike `openFreshPresentation`) — the only way to fabricate a pre-[E4.T7] fixture, since ADR-0002 gives no command that writes a legacy `templates` shape. */
async function openWithProjectJson(project: Record<string, unknown>): Promise<string> {
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(JSON.stringify(project)),
    "slides/001.svg": new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>"),
    "templates/001.svg": new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>"),
    "assets/": new Uint8Array(0),
  });
  const comotPath = path.join(comotDir, `fixture-${Math.random().toString(36).slice(2)}.comot`);
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  expect(opened.ok).toBe(true);
  return opened.data!.id;
}

async function readProject(id: string): Promise<any> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
  return JSON.parse(result.data!.content);
}

describe("A10-a: the three commands exist", () => {
  it("registry has template list / rename / delete", () => {
    expect(registry.has("template list")).toBe(true);
    expect(registry.has("template rename")).toBe(true);
    expect(registry.has("template delete")).toBe(true);
  });
});

describe("A10-c: full ADR-0002 flow — add → list → rename → list → delete → list", () => {
  it("每一步的 data 與最終 templates 都符合預期", async () => {
    const id = await openFreshPresentation();

    const added = await registry.dispatch<{ templatePath: string }>("template add", { id, name: "封面" });
    expect(added.ok).toBe(true);
    expect(added.data!.templatePath).toBe("templates/001.svg");

    const listed1 = await registry.dispatch<{ templates: { file: string; name: string }[] }>("template list", {
      id,
    });
    expect(listed1.ok).toBe(true);
    expect(listed1.data!.templates).toEqual([{ file: "templates/001.svg", name: "封面" }]);

    const renamed = await registry.dispatch("template rename", {
      id,
      templatePath: "templates/001.svg",
      newName: "章節頁",
    });
    expect(renamed.ok).toBe(true);

    const listed2 = await registry.dispatch<{ templates: { file: string; name: string }[] }>("template list", {
      id,
    });
    expect(listed2.data!.templates).toEqual([{ file: "templates/001.svg", name: "章節頁" }]);

    const deleted = await registry.dispatch("template delete", { id, templatePath: "templates/001.svg" });
    expect(deleted.ok).toBe(true);

    const listed3 = await registry.dispatch<{ templates: unknown[] }>("template list", { id });
    expect(listed3.data!.templates).toEqual([]);
  });
});

describe("template list", () => {
  it("回傳共 0 個範本，不是錯誤", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch<{ templates: unknown[] }>("template list", { id });
    expect(result.ok).toBe(true);
    expect(result.data!.templates).toEqual([]);
    expect(result.message).toContain("0");
  });

  it("A11: 舊字串格式的 templates 回傳 name 為檔名，不是空字串", async () => {
    const id = await openWithProjectJson({
      formatVersion: 1,
      name: "舊格式簡報",
      canvas: { width: 1280, height: 720 },
      slides: ["slides/001.svg"],
      templates: ["templates/001.svg"],
    });

    const result = await registry.dispatch<{ templates: { file: string; name: string }[] }>("template list", {
      id,
    });
    expect(result.ok).toBe(true);
    expect(result.data!.templates).toEqual([{ file: "templates/001.svg", name: "001" }]);
  });
});

describe("template rename", () => {
  it("正常改名：project.json 只有該筆的 name 變動", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    await registry.dispatch("template add", { id, name: "封底" }); // templates/002.svg

    const result = await registry.dispatch("template rename", {
      id,
      templatePath: "templates/001.svg",
      newName: "章節頁",
    });
    expect(result.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates).toEqual([
      { file: "templates/001.svg", name: "章節頁" },
      { file: "templates/002.svg", name: "封底" },
    ]);
  });

  it("新名稱前後有空白：trim 後儲存", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });

    await registry.dispatch("template rename", { id, templatePath: "templates/001.svg", newName: "  章節頁  " });

    const after = await readProject(id);
    expect(after.templates[0].name).toBe("章節頁");
  });

  it("A5: 新名稱為空字串，明確報錯，project.json 位元組未變", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    const before = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });

    const result = await registry.dispatch("template rename", { id, templatePath: "templates/001.svg", newName: "" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
    expect(result.message).toContain("不可為空");

    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
    expect(after.data!.content).toBe(before.data!.content);
  });

  it("新名稱只有空白字元：視同空字串，明確報錯", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });

    const result = await registry.dispatch("template rename", { id, templatePath: "templates/001.svg", newName: "   " });
    expect(result.ok).toBe(false);
  });

  it("A6: 新名稱與另一個範本相同，允許並存，不報錯", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    await registry.dispatch("template add", { id, name: "封底" });

    const result = await registry.dispatch("template rename", {
      id,
      templatePath: "templates/002.svg",
      newName: "封面",
    });
    expect(result.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates.map((t: { name: string }) => t.name)).toEqual(["封面", "封面"]);
  });

  it("template-path 不存在：CoMotionNotFoundError", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("template rename", {
      id,
      templatePath: "templates/999.svg",
      newName: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });

  it("template-path 是一張投影片：明確報錯，不容錯當成範本用", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("template rename", { id, templatePath: "slides/001.svg", newName: "x" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
  });

  it("名稱含 emoji／CJK／引號／換行：合法，原樣儲存", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    const weirdName = 'emoji🎉CJK測試"quote"\nnewline';

    const result = await registry.dispatch("template rename", {
      id,
      templatePath: "templates/001.svg",
      newName: weirdName,
    });
    expect(result.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates[0].name).toBe(weirdName);
  });

  it("undo 一次回到舊名", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    await registry.dispatch("template rename", { id, templatePath: "templates/001.svg", newName: "章節頁" });

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates[0].name).toBe("封面");
  });
});

describe("template delete", () => {
  it("正常刪除：SVG 檔消失、templates 少一筆", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });

    const result = await registry.dispatch("template delete", { id, templatePath: "templates/001.svg" });
    expect(result.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates).toEqual([]);

    const cat = await registry.dispatch("cat", { id, path: "templates/001.svg" });
    expect(cat.ok).toBe(false);
    expect(cat.failureKind).toBe("not-found");
  });

  it("A9: 刪除後已用此範本建立的投影片完全不受影響", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    const added = await registry.dispatch<{ slidePath: string }>("slide add", { id, templatePath: "templates/001.svg" });
    const slideBefore = await registry.dispatch<{ content: string }>("cat", { id, path: added.data!.slidePath });

    await registry.dispatch("template delete", { id, templatePath: "templates/001.svg" });

    const slideAfter = await registry.dispatch<{ content: string }>("cat", { id, path: added.data!.slidePath });
    expect(slideAfter.ok).toBe(true);
    expect(slideAfter.data!.content).toBe(slideBefore.data!.content);
  });

  it("template-path 不存在：CoMotionNotFoundError", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("template delete", { id, templatePath: "templates/999.svg" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });

  it("template-path 是一張投影片：明確報錯，提示改用 slide delete", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("template delete", { id, templatePath: "slides/001.svg" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
    expect(result.message).toContain("slide delete");
  });

  it("A9: undo 一次同時還原 SVG 檔與 templates 欄位", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    await registry.dispatch("template delete", { id, templatePath: "templates/001.svg" });

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates).toEqual([{ file: "templates/001.svg", name: "封面" }]);
    const cat = await registry.dispatch("cat", { id, path: "templates/001.svg" });
    expect(cat.ok).toBe(true);
  });
});

describe("template add --name (A4/A6/A11)", () => {
  it("有 --name：trim 後使用", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch<{ templatePath: string }>("template add", { id, name: "  封面  " });
    expect(result.ok).toBe(true);
    const after = await readProject(id);
    expect(after.templates).toEqual([{ file: result.data!.templatePath, name: "封面" }]);
  });

  it("無 --name：預設為新檔的檔名去副檔名", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch<{ templatePath: string }>("template add", { id });
    const after = await readProject(id);
    expect(after.templates).toEqual([{ file: result.data!.templatePath, name: "001" }]);
  });

  it("A4: --name 空字串明確報錯，且不建立任何檔案", async () => {
    const id = await openFreshPresentation();
    const before = await readProject(id);

    const result = await registry.dispatch("template add", { id, name: "" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不可為空");

    const after = await readProject(id);
    expect(after).toEqual(before);
    const listed = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "templates" });
    expect(listed.ok).toBe(false); // "templates" directory was never created
  });

  it("A6: 兩個同名範本可以並存", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("template add", { id, name: "封面" });
    const second = await registry.dispatch<{ templatePath: string }>("template add", { id, name: "封面" });
    expect(second.ok).toBe(true);

    const after = await readProject(id);
    expect(after.templates.map((t: { name: string }) => t.name)).toEqual(["封面", "封面"]);
  });
});

describe("formatVersion 進位 (4.2)", () => {
  it("(a) formatVersion 太新：開啟時明確報錯", async () => {
    const comotPath = path.join(comotDir, "future.comot");
    await registry.dispatch("new", { path: comotPath, name: "future" });
    // Corrupt the freshly-created container's own project.json isn't
    // reachable via a command (ADR-0002), so build a second, independent
    // container whose formatVersion is deliberately ahead instead.
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({
          formatVersion: FORMAT_VERSION + 1,
          name: "來自未來",
          canvas: { width: 1280, height: 720 },
          slides: ["slides/001.svg"],
        }),
      ),
      "slides/001.svg": new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>"),
      "assets/": new Uint8Array(0),
    });
    const futurePath = path.join(comotDir, "future2.comot");
    await writeFile(futurePath, zipped);

    const result = await registry.dispatch("open", { path: futurePath });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("較新版本");
  });

  it("(b) formatVersion:1 的簡報執行 template rename 後，寫出的 project.json 的 formatVersion 進位且 templates 已是物件陣列", async () => {
    const id = await openWithProjectJson({
      formatVersion: 1,
      name: "舊版本簡報",
      canvas: { width: 1280, height: 720 },
      slides: ["slides/001.svg"],
      templates: ["templates/001.svg"],
    });

    await registry.dispatch("template rename", { id, templatePath: "templates/001.svg", newName: "封面" });

    const after = await readProject(id);
    expect(after.formatVersion).toBe(FORMAT_VERSION);
    expect(after.templates).toEqual([{ file: "templates/001.svg", name: "封面" }]);
  });

  it("(c) formatVersion:1 的簡報只讀（template list）時，磁碟上的 project.json 位元組不變", async () => {
    const id = await openWithProjectJson({
      formatVersion: 1,
      name: "舊版本簡報",
      canvas: { width: 1280, height: 720 },
      slides: ["slides/001.svg"],
      templates: ["templates/001.svg"],
    });

    const before = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
    await registry.dispatch("template list", { id });
    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });

    expect(after.data!.content).toBe(before.data!.content);
    expect(JSON.parse(before.data!.content).formatVersion).toBe(1);
  });
});
