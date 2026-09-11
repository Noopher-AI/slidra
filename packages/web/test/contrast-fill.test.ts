import { describe, expect, it } from "vitest";
import { contrastFill } from "../src/contrast-fill.js";

// NOOP-353 拍板決定 7（逐字）：讀頁面背景（沒有就當白），亮度高填深色
// （#1f1a1a）、亮度低填淺色（#f4f6f8）。方向是唯一的契約——深色頁永遠拿到
// 淺色值，淺色頁永遠拿到深色值。
describe("contrastFill", () => {
  it("null（沒有頁面背景）當白色處理，回傳深色", () => {
    expect(contrastFill(null)).toBe("#1f1a1a");
  });

  it("白色背景（#ffffff）回傳深色", () => {
    expect(contrastFill("#ffffff")).toBe("#1f1a1a");
  });

  it("demo deck 的深色頁背景（#101418）回傳淺色", () => {
    expect(contrastFill("#101418")).toBe("#f4f6f8");
  });

  it("接受 3 碼 hex（#000）回傳淺色", () => {
    expect(contrastFill("#000")).toBe("#f4f6f8");
  });

  it("接受 rgb() 函式寫法，行為與等值 hex 一致", () => {
    expect(contrastFill("rgb(16, 20, 24)")).toBe("#f4f6f8");
  });

  it("無法解析的值（非 hex／rgb()）視同沒有背景，當白色處理", () => {
    expect(contrastFill("not-a-color")).toBe("#1f1a1a");
  });
});
