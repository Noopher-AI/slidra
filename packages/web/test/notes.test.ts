import { describe, expect, it } from "vitest";
import { setSlideNotes } from "@co-motion/core";
import { readSlideNotes } from "../src/notes.js";

const BLANK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>';

describe("readSlideNotes", () => {
  it("沒有 <metadata>：空字串", () => {
    const result = readSlideNotes(BLANK_SVG);
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("有 <metadata> 但沒有 <comot:notes>：空字串", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:effects xmlns:comot="https://co-motion.dev/ns"/></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "" });
  });

  it("有 <comot:notes>：讀出內容", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:notes xmlns:comot="https://co-motion.dev/ns">第一版備忘稿</comot:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "第一版備忘稿" });
  });

  it("notes 含跳脫字元：還原成原字元", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:notes xmlns:comot="https://co-motion.dev/ns">1 &lt; 2 &amp;&amp; true</comot:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "1 < 2 && true" });
  });

  it("notes 含換行：原樣保留", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:notes xmlns:comot="https://co-motion.dev/ns">第一行\n第二行</comot:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "第一行\n第二行" });
  });

  it("舊檔（無 xmlns）：DOMParser 會判定損毀，但 readSlideNotes 讀得回來", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      "<metadata><comot:notes>舊版備忘稿，沒有繫結命名空間</comot:notes></metadata>" +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "舊版備忘稿，沒有繫結命名空間" });
  });

  it("markup 讀不出 <svg> 根：明確報錯，不是空字串", () => {
    const result = readSlideNotes("<html><body>not a slide</body></html>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("<svg>");
    }
  });

  it("標記語法錯誤（scanDocument 會 throw）：明確報錯", () => {
    const result = readSlideNotes('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>');
    expect(result.ok).toBe(false);
  });

  describe("往返：core 的 setSlideNotes 寫，readSlideNotes 讀，還原成原字串", () => {
    const cases: Record<string, string> = {
      一般文字: "第一版備忘稿",
      空字串: "",
      跳脫字元: "1 < 2 && true",
      換行: "第一行\n第二行",
      只有空白: "   ",
      "含 & 在中間": "A & B < C > D",
    };

    for (const [label, text] of Object.entries(cases)) {
      it(label, () => {
        const written = setSlideNotes(BLANK_SVG, text);
        const result = readSlideNotes(written);
        expect(result).toEqual({ ok: true, text });
      });
    }

    it("先寫一次再覆寫一次，往返仍成立", () => {
      const once = setSlideNotes(BLANK_SVG, "版本一");
      const twice = setSlideNotes(once, "版本二，含 <tag> 與 & 符號");
      expect(readSlideNotes(twice)).toEqual({ ok: true, text: "版本二，含 <tag> 與 & 符號" });
    });
  });
});
