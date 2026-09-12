// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

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

describe("touchesProtectedPath: only .slidra files are CLI-exclusive", () => {
  it("touching the presentation's working directory is refused", () => {
    expect(refuses("sed -i s/a/b/ /home/u/.slidra/work/abc/slides/001.svg")).toBe(true);
  });

  it("touching the undo history is refused", () => {
    expect(refuses("rm -rf /home/u/.slidra/history/abc")).toBe(true);
  });

  it("touching a .slidra file itself is refused (any one of them)", () => {
    expect(refuses("unzip /home/u/decks/台灣美食.slidra")).toBe(true);
    expect(refuses("cp /somewhere/else/別人的.slidra /tmp/")).toBe(true);
  });

  it("using a relative path from the agent's working directory to loop back is refused", () => {
    expect(refuses("cat ../../work/abc/project.json")).toBe(true);
  });

  it("pointing at SLIDRA_HOME via ~ is refused", () => {
    const home = path.join(homedir(), ".slidra");
    expect(
      touchesProtectedPath("cat ~/.slidra/projects.json", {
        slidraHome: home,
        agentWorkdir: path.join(home, "agent", "abc"),
      }),
    ).toBe(true);
  });

  it("the agent's own working directory is allowed (it's the agent's cwd)", () => {
    expect(refuses("cat reference/modes.md")).toBe(false);
    expect(refuses("cat /home/u/.slidra/agent/abc/reference/modes.md")).toBe(false);
    expect(refuses("grep -rn pyramid .")).toBe(false);
  });

  it("anything unrelated to the presentation is allowed", () => {
    expect(refuses("curl -s https://example.com/a.png -o /tmp/a.png")).toBe(false);
    expect(refuses("python3 -c print(1)")).toBe(false);
    expect(refuses("ls -la")).toBe(false);
  });
});
