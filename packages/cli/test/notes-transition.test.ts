import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import { checkSlideCompliance } from "@co-motion/core";

/** T3: `slide notes set` (AC 11) and `presentation transition set` (AC 12). */

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
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

async function openFreshPresentation(): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function slideContent(id: string, slidePath = "slides/001.svg"): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  return result.data!.content;
}

async function readProject(id: string): Promise<any> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
  return JSON.parse(result.data!.content);
}

describe("slide notes set", () => {
  it("沒有 <metadata> 時建立並寫入 <comot:notes>", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide notes set", {
      id,
      slidePath: "slides/001.svg",
      text: "第一版備忘稿",
    });
    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).toContain("<comot:notes>第一版備忘稿</comot:notes>");
  });

  it("已有 <comot:notes> 時整個取代", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "版本一" });
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "版本二" });
    const content = await slideContent(id);
    expect(content).toContain("<comot:notes>版本二</comot:notes>");
    expect(content).not.toContain("版本一");
  });

  it("空字串合法：清空備忘稿寫入空的 <comot:notes></comot:notes>", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "有內容" });
    const result = await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "" });
    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).toContain("<comot:notes></comot:notes>");
  });

  it("含 <、& 等字元一律做 XML 跳脫，寫回去能被讀回", async () => {
    const id = await openFreshPresentation();
    const text = "1 < 2 && true";
    const result = await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text });
    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).not.toContain("1 < 2");
    expect(content).toContain("1 &lt; 2 &amp;&amp; true");
  });

  it("含換行：合法，原樣保留", async () => {
    const id = await openFreshPresentation();
    const text = "第一行\n第二行";
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text });
    const content = await slideContent(id);
    expect(content).toContain("第一行\n第二行");
  });

  it("路徑不是投影片：不是投影片", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide notes set", { id, slidePath: "slides/999.svg", text: "x" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是投影片");
  });

  it("既有 <comot:effects> 不受影響；合規檢查仍全綠", async () => {
    const id = await openFreshPresentation();
    // No public command authors a standalone <comot:effects> yet
    // (element-edit.ts's own comment on the format), so this test hand-authors
    // one directly into the slide — the exact markup shape
    // slide-format.test.ts uses to prove checkSlideCompliance accepts it —
    // then writes it via `writePresentationFile`, the same escape hatch
    // element.test.ts's group-scale test uses to seed a fixture no public
    // command builds on its own.
    // `setSlideNotes` inserts <comot:notes> as <metadata>'s first child
    // (notes.ts's own doc comment), so the <comot:effects> block itself —
    // not the surrounding <metadata> tags — is the substring that must
    // survive byte-for-byte; it ends up shifted after the new notes tag,
    // not literally in place.
    const effectsBlock =
      '<comot:effects xmlns:comot="https://co-motion.dev/ns">' +
      '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>' +
      "</comot:effects>";
    const svgWithEffects =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      `  <metadata>${effectsBlock}</metadata>\n` +
      '  <g id="el-a"><rect x="0" y="0" width="10" height="10"/></g>\n' +
      "</svg>\n";
    expect(checkSlideCompliance(svgWithEffects)).toEqual([]);
    const { writePresentationFile } = await import("@co-motion/core");
    await writePresentationFile(id, "slides/001.svg", svgWithEffects);

    const result = await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "備忘稿" });

    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    // The existing <comot:effects> block survives byte-for-byte — this is
    // the actual T3 parent AC (「既有 effects 一個位元組都不動」), not just
    // "compliance still passes".
    expect(content).toContain(effectsBlock);
    expect(content).toContain("<comot:notes>備忘稿</comot:notes>");
    expect(checkSlideCompliance(content)).toEqual([]);
  });
});

describe("presentation transition set", () => {
  it("AC12: 設定 fade 後 project.json.transition === 'fade'", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("presentation transition set", { id, name: "fade" });
    expect(result.ok).toBe(true);
    const project = await readProject(id);
    expect(project.transition).toBe("fade");
  });

  it("設定 none 合法", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("presentation transition set", { id, name: "none" });
    expect(result.ok).toBe(true);
  });

  it("不支援的值明確報錯，不寫入、不預設回 none", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("presentation transition set", { id, name: "spin" });
    expect(result.ok).toBe(false);
    const project = await readProject(id);
    expect(project.transition).toBeUndefined();
  });

  it("slide move / duplicate / delete 之後 transition 值不變，且 SVG 內不含 transition 字樣", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("presentation transition set", { id, name: "fade" });
    await registry.dispatch("slide add", { id });
    await registry.dispatch("slide move", { id, slidePath: "slides/002.svg", newIndex: 0 });
    await registry.dispatch("slide duplicate", { id, slidePath: "slides/001.svg" });
    await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });

    const project = await readProject(id);
    expect(project.transition).toBe("fade");

    for (const slidePath of project.slides as string[]) {
      const content = await slideContent(id, slidePath);
      expect(content).not.toContain("transition");
    }
  });

  it("簡報原本沒有 transition 欄位：讀取端視為 none，不因缺欄位而炸", async () => {
    const id = await openFreshPresentation();
    const project = await readProject(id);
    expect(project.transition).toBeUndefined();
  });
});
