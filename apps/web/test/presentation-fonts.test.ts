import { describe, expect, it } from "vitest";
import { presentationFontFaces, setPresentationFonts, wrapPlayDocument } from "../src/canvas.js";

/**
 * #305：簡報自己內嵌的字型必須全部宣告。寫死一個家族時，一份 `font import`
 * 進第二種字型的簡報，在畫面上與 PDF 裡都會用主機的系統字型去畫那些字。
 */
describe("投影片文件注入的 @font-face 來自 project.json", () => {
  it("每一個內嵌字型都有一條 @font-face，url 指向該檔案", () => {
    setPresentationFonts([
      { file: "fonts/NotoSansTC-Presentation.ttf", family: "Noto Sans TC" },
      { file: "fonts/Noto-Serif-TC.ttf", family: "Noto Serif TC" },
    ]);
    const style = presentationFontFaces();
    expect(style).toContain('font-family:"Noto Sans TC"');
    expect(style).toContain("/api/raw/fonts/NotoSansTC-Presentation.ttf");
    expect(style).toContain('font-family:"Noto Serif TC"');
    expect(style).toContain("/api/raw/fonts/Noto-Serif-TC.ttf");
  });

  it("宣告會實際進到播放文件的 <head>", () => {
    setPresentationFonts([{ file: "fonts/Noto-Serif-TC.ttf", family: "Noto Serif TC" }]);
    const doc = wrapPlayDocument("<svg></svg>", "/api/raw/slides", "", "{}");
    expect(doc).toContain("/api/raw/fonts/Noto-Serif-TC.ttf");
  });

  it("沒有 fonts 欄位的舊簡報回到預設那一條，不會變成沒有字型", () => {
    setPresentationFonts(undefined);
    expect(presentationFontFaces()).toContain("NotoSansTC-Presentation.ttf");
  });
});
