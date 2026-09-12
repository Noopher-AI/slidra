import { describe, expect, it } from "vitest";
import { isNearBottom } from "../src/shell/side/ChatPanel.js";

// The chat log follows new messages only while the author is already
// reading the bottom: someone who scrolled up to re-read an earlier
// command must not be yanked back down by the next streamed chunk.
describe("chat 自動捲動的貼底判斷", () => {
  const clientHeight = 600;

  it("完全貼底時要跟", () => {
    expect(isNearBottom(2000, 1400, clientHeight)).toBe(true);
  });

  it("差幾個像素也算貼底（分數像素、串流中長高的那一行）", () => {
    expect(isNearBottom(2000, 1360, clientHeight)).toBe(true);
  });

  it("往上捲去看舊訊息就不跟", () => {
    expect(isNearBottom(2000, 900, clientHeight)).toBe(false);
  });

  it("內容還沒長到需要捲動時也算貼底", () => {
    expect(isNearBottom(400, 0, clientHeight)).toBe(true);
  });
});
