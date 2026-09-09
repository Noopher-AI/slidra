import { describe, expect, it } from "vitest";
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

  // F8 (NOOP-289): 原本這裡是用 core 的 setSlideNotes 現場寫入再讀回的往返測試
  // ——期望值由 core 現場產生，core 即將從 web 移除。改成與上面幾條同樣的字面
  // markup fixture，覆蓋同一組輸入（空字串／只有空白／& 在中間）；「一般文
  // 字」「跳脫字元」「換行」三個樣本已經是上面既有測試逐字覆蓋的輸入，不重
  //複列。
  it("notes 是空字串：讀回空字串", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:notes xmlns:comot="https://co-motion.dev/ns"></comot:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "" });
  });

  it("notes 只有空白：原樣保留", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:notes xmlns:comot="https://co-motion.dev/ns">   </comot:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "   " });
  });

  it("notes 含 & 在中間：還原成原字元", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:notes xmlns:comot="https://co-motion.dev/ns">A &amp; B &lt; C &gt; D</comot:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "A & B < C > D" });
  });
});
