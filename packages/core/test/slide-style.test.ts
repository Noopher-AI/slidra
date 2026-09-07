import { describe, expect, it } from "vitest";
import { readSlidePageStyle, setSlidePageStyle } from "../src/slide-style.js";

const BLANK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>\n`;

describe("readSlidePageStyle", () => {
  it("沒有 style 屬性 → 兩者皆 null，不捏預設值", () => {
    expect(readSlidePageStyle(BLANK)).toEqual({ background: null, accent: null });
  });

  it("讀回已寫入的 background 與 accent", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" style="background-color:#14161a;--comot-accent:#c41e3a"></svg>\n`;
    expect(readSlidePageStyle(svg)).toEqual({ background: "#14161a", accent: "#c41e3a" });
  });
});

describe("setSlidePageStyle", () => {
  it("寫入 background：根 <svg> 出現 style 屬性，其他部分不變", () => {
    const updated = setSlidePageStyle(BLANK, { background: "#202020" });
    expect(updated).toContain('style="background-color:#202020"');
    expect(updated).toContain('viewBox="0 0 1280 720"');
  });

  it("background 與 accent 兩者並存，寫成同一個 style 屬性", () => {
    const updated = setSlidePageStyle(BLANK, { background: "#202020", accent: "#00ff00" });
    expect(readSlidePageStyle(updated)).toEqual({ background: "#202020", accent: "#00ff00" });
  });

  it("只改其中一項時，另一項既有宣告原封不動", () => {
    const withBoth = setSlidePageStyle(BLANK, { background: "#202020", accent: "#00ff00" });
    const updated = setSlidePageStyle(withBoth, { accent: "#ff00ff" });
    expect(readSlidePageStyle(updated)).toEqual({ background: "#202020", accent: "#ff00ff" });
  });

  it("style 屬性原本就有其他宣告時，只改自己那條，其餘逐字保留", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" style="cursor:default"></svg>\n`;
    const updated = setSlidePageStyle(svg, { background: "#202020" });
    expect(readSlidePageStyle(updated)).toEqual({ background: "#202020", accent: null });
    expect(updated).toContain("cursor:default");
  });

  it("根 <svg> 的其他屬性不動", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-comot-name="x"></svg>\n`;
    const updated = setSlidePageStyle(svg, { background: "#202020" });
    expect(updated).toContain('data-comot-name="x"');
  });

  it("空字串清除該項；兩者都清除後整個 style 屬性移除", () => {
    const withBoth = setSlidePageStyle(BLANK, { background: "#202020", accent: "#00ff00" });
    const clearedBg = setSlidePageStyle(withBoth, { background: "" });
    expect(readSlidePageStyle(clearedBg)).toEqual({ background: null, accent: "#00ff00" });
    const clearedBoth = setSlidePageStyle(clearedBg, { accent: "" });
    expect(clearedBoth).not.toContain("style=");
    expect(readSlidePageStyle(clearedBoth)).toEqual({ background: null, accent: null });
  });

  it("兩個 flag 都沒給 → 拒絕", () => {
    expect(() => setSlidePageStyle(BLANK, {})).toThrow("至少要給 --background 或 --accent");
  });
});
