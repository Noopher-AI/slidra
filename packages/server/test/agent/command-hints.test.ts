import { describe, expect, it } from "vitest";
import { hintForBlockedCommand } from "../../src/agent/command-hints.js";

describe("hintForBlockedCommand：被擋下的命令換成一句「請改用什麼」", () => {
  it("讀檔類 → slidra cat", () => {
    expect(hintForBlockedCommand("cat /home/u/.slidra/work/abc/slides/001.svg", "abc")).toContain("slidra cat abc");
  });

  it("列目錄類 → slidra ls", () => {
    expect(hintForBlockedCommand("ls -la /home/u/.slidra/work/abc", "abc")).toContain("slidra ls abc");
  });

  it("其餘一律指向 CLI（改檔只能走命令）", () => {
    expect(hintForBlockedCommand("sed -i s/a/b/ /home/u/.slidra/work/abc/slides/001.svg", "abc")).toContain("slidra");
    expect(hintForBlockedCommand("unzip /home/u/decks/x.slidra", "abc")).toContain("復原快照");
  });
});
