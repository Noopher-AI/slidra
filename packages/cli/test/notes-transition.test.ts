import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import { checkSlideCompliance } from "@co-motion/core";

/** T3: `slide notes set` (AC 11). [E2.T11]: `slide transition set`, replacing T3's `presentation transition set`. */

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
    expect(content).toContain('<comot:notes xmlns:comot="https://co-motion.dev/ns">第一版備忘稿</comot:notes>');
  });

  it("已有 <comot:notes> 時整個取代", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "版本一" });
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "版本二" });
    const content = await slideContent(id);
    expect(content).toContain('<comot:notes xmlns:comot="https://co-motion.dev/ns">版本二</comot:notes>');
    expect(content).not.toContain("版本一");
  });

  it("空字串合法：清空備忘稿寫入空的 <comot:notes></comot:notes>", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "有內容" });
    const result = await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "" });
    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).toContain('<comot:notes xmlns:comot="https://co-motion.dev/ns"></comot:notes>');
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

  it("寫入後的整份 SVG 是 namespace-well-formed 的 XML（unbound comot: 前綴會讓播放模式的 parseEffects 直接判定損毀）", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide notes set", { id, slidePath: "slides/001.svg", text: "備忘稿" });
    const content = await slideContent(id);
    const doc = new (new JSDOM().window.DOMParser)().parseFromString(content, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
  });

  it("既有 <comot:notes> 缺 xmlns:comot（舊檔，本次修正前寫入的）：重寫後補上，不再是 parsererror", async () => {
    // Round 1 只補了「沒有 <metadata>」與「有 <metadata> 但沒有 <comot:notes>」兩個分支，
    // 第三個分支（<comot:notes> 已存在）只換內容、不碰開標籤，於是任何在修正前就已經下過
    // `slide notes set` 的簡報，其 <comot:notes> 永遠缺 xmlns:comot —— 這裡手動重現那個舊檔狀態。
    const id = await openFreshPresentation();
    const legacySvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      "  <metadata><comot:notes>舊的備忘稿</comot:notes></metadata>\n" +
      '  <g id="el-a"><rect x="0" y="0" width="10" height="10"/></g>\n' +
      "</svg>\n";
    const { writePresentationFile } = await import("@co-motion/core");
    await writePresentationFile(id, "slides/001.svg", legacySvg);

    const result = await registry.dispatch("slide notes set", {
      id,
      slidePath: "slides/001.svg",
      text: "作者在 GUI 裡改過的新備忘稿",
    });

    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).toContain(
      '<comot:notes xmlns:comot="https://co-motion.dev/ns">作者在 GUI 裡改過的新備忘稿</comot:notes>',
    );
    expect(content).not.toContain("舊的備忘稿");
    const doc = new (new JSDOM().window.DOMParser)().parseFromString(content, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
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
    expect(content).toContain('<comot:notes xmlns:comot="https://co-motion.dev/ns">備忘稿</comot:notes>');
    expect(checkSlideCompliance(content)).toEqual([]);
  });
});

describe("slide transition set（[E2.T11]，取代 presentation transition set）", () => {
  it("[A1] 設定 enter=fade/enter-duration=0.8/exit=zoom/exit-duration=0.5 後，SVG 含完整四屬性；<metadata> 是既有的合規豁免區，寫入前後的合規清單不變", async () => {
    const id = await openFreshPresentation();
    const before = await slideContent(id);
    const complianceBefore = checkSlideCompliance(before);

    const result = await registry.dispatch("slide transition set", {
      id,
      slidePath: "slides/001.svg",
      enter: "fade",
      enterDuration: 0.8,
      exit: "zoom",
      exitDuration: 0.5,
    });
    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).toContain(
      '<comot:transition xmlns:comot="https://co-motion.dev/ns" enter="fade" enter-duration="0.8" exit="zoom" exit-duration="0.5"/>',
    );
    expect(checkSlideCompliance(content)).toEqual(complianceBefore);
  });

  it("[A2] 同一張投影片再跑 --enter none：只有 enter 變 none，其餘三個屬性值不變（部分更新）", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide transition set", {
      id,
      slidePath: "slides/001.svg",
      enter: "fade",
      enterDuration: 0.8,
      exit: "zoom",
      exitDuration: 0.5,
    });
    const result = await registry.dispatch("slide transition set", { id, slidePath: "slides/001.svg", enter: "none" });
    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).toContain(
      '<comot:transition xmlns:comot="https://co-motion.dev/ns" enter="none" enter-duration="0.8" exit="zoom" exit-duration="0.5"/>',
    );
  });

  it("[A3] 不支援的 enter 值／非法的 enter-duration 三種輸入各自明確報錯，SVG 位元組完全不變", async () => {
    const id = await openFreshPresentation();
    const before = await slideContent(id);

    for (const input of [
      { enter: "wipe" },
      { enterDuration: -1 },
      { enterDuration: NaN },
    ] as const) {
      const result = await registry.dispatch("slide transition set", { id, slidePath: "slides/001.svg", ...input });
      expect(result.ok, JSON.stringify(input)).toBe(false);
    }
    expect(await slideContent(id)).toBe(before);
  });

  it("slide transition set 至少要指定一個要改的欄位——四個旗標與 --all 都沒給時明確報錯", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide transition set", { id, slidePath: "slides/001.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("至少要指定一個要改的欄位");
  });

  it("<slide-path> 不是投影片（含指向 template）時明確報錯", async () => {
    const id = await openFreshPresentation();
    const result = await registry.dispatch("slide transition set", { id, slidePath: "slides/999.svg", enter: "fade" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是投影片");
  });

  it("slide duplicate 之後複本帶著相同的 <comot:transition>；slide move／delete 不改動任何一頁的頁面進出場（接手被刪測項的關切點：頁面操作不破壞轉場）", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide transition set", { id, slidePath: "slides/001.svg", enter: "fade", enterDuration: 0.8 });
    await registry.dispatch("slide add", { id });
    await registry.dispatch("slide move", { id, slidePath: "slides/002.svg", newIndex: 0 });
    await registry.dispatch("slide duplicate", { id, slidePath: "slides/001.svg" });

    const project = await readProject(id);
    const transitionTag = 'enter="fade" enter-duration="0.8"';
    let matches = 0;
    for (const slidePath of project.slides as string[]) {
      const content = await slideContent(id, slidePath);
      if (content.includes(transitionTag)) matches++;
    }
    // 原頁 + 複製出來的那一頁都帶著同一份設定（新加的空白頁沒有）。
    expect(matches).toBe(2);
  });

  it("[A4] --all 之後每張投影片都拿到相同的四個屬性值；一次 undo 就把全部投影片還原（一格 undo）", async () => {
    const id = await openFreshPresentation();
    await registry.dispatch("slide add", { id });
    await registry.dispatch("slide transition set", {
      id,
      slidePath: "slides/001.svg",
      enter: "slide",
      enterDuration: 0.4,
      exit: "fade",
      exitDuration: 0.9,
    });

    const before = await slideContent(id, "slides/002.svg");
    const result = await registry.dispatch("slide transition set", { id, slidePath: "slides/001.svg", all: true });
    expect(result.ok).toBe(true);

    const project = await readProject(id);
    const transitionTag = 'enter="slide" enter-duration="0.4" exit="fade" exit-duration="0.9"';
    for (const slidePath of project.slides as string[]) {
      expect(await slideContent(id, slidePath)).toContain(transitionTag);
    }

    await registry.dispatch("undo", { id });
    expect(await slideContent(id, "slides/002.svg")).toBe(before);
  });

  it("presentation transition set 已不存在：registry.dispatch 對未註冊的命令名一律拋錯（UnknownCommandError），不是回傳 { ok: false }", async () => {
    const id = await openFreshPresentation();
    await expect(registry.dispatch("presentation transition set", { id, name: "fade" })).rejects.toThrow("未知的命令：presentation transition set");
  });
});
