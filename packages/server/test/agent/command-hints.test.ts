import { describe, expect, it } from "vitest";
import { hintForBlockedCommand } from "../../src/agent/command-hints.js";

describe("hintForBlockedCommand：被擋下的命令換成一句「請改用什麼」", () => {
  it("讀檔類 → comotion cat", () => {
    expect(hintForBlockedCommand("cat /home/u/.comotion/work/abc/slides/001.svg", "abc")).toContain("comotion cat abc");
  });

  it("列目錄類 → comotion ls", () => {
    expect(hintForBlockedCommand("ls -la /home/u/.comotion/work/abc", "abc")).toContain("comotion ls abc");
  });

  it("其餘一律指向 CLI（改檔只能走命令）", () => {
    expect(hintForBlockedCommand("sed -i s/a/b/ /home/u/.comotion/work/abc/slides/001.svg", "abc")).toContain("comotion");
    expect(hintForBlockedCommand("unzip /home/u/decks/x.comot", "abc")).toContain("復原快照");
  });
});
