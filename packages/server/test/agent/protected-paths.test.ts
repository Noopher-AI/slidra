import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { touchesProtectedPath } from "../../src/agent/protected-paths.js";

const paths = {
  slidraHome: "/home/u/.slidra",
  agentWorkdir: "/home/u/.slidra/agent/abc",
  sourcePath: "/home/u/decks/台灣美食.slidra",
};

const refuses = (command: string) => touchesProtectedPath(command, paths);

describe("touchesProtectedPath：只有 slidra 檔案是 CLI 專屬的", () => {
  it("動到簡報工作目錄 → 擋", () => {
    expect(refuses("sed -i s/a/b/ /home/u/.slidra/work/abc/slides/001.svg")).toBe(true);
  });

  it("動到復原歷史 → 擋", () => {
    expect(refuses("rm -rf /home/u/.slidra/history/abc")).toBe(true);
  });

  it("動到 .slidra 檔本身 → 擋（任何一份都算）", () => {
    expect(refuses("unzip /home/u/decks/台灣美食.slidra")).toBe(true);
    expect(refuses("cp /somewhere/else/別人的.slidra /tmp/")).toBe(true);
  });

  it("從 agent 工作目錄用相對路徑繞回去 → 擋", () => {
    expect(refuses("cat ../../work/abc/project.json")).toBe(true);
  });

  it("用 ~ 指到 SLIDRA_HOME → 擋", () => {
    const home = path.join(homedir(), ".slidra");
    expect(
      touchesProtectedPath("cat ~/.slidra/projects.json", {
        slidraHome: home,
        agentWorkdir: path.join(home, "agent", "abc"),
      }),
    ).toBe(true);
  });

  it("agent 自己的工作目錄 → 放行（這是它的 cwd）", () => {
    expect(refuses("cat reference/modes.md")).toBe(false);
    expect(refuses("cat /home/u/.slidra/agent/abc/reference/modes.md")).toBe(false);
    expect(refuses("grep -rn pyramid .")).toBe(false);
  });

  it("跟簡報無關的事 → 放行", () => {
    expect(refuses("curl -s https://example.com/a.png -o /tmp/a.png")).toBe(false);
    expect(refuses("python3 -c print(1)")).toBe(false);
    expect(refuses("ls -la")).toBe(false);
  });
});
