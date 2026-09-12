// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { hintForBlockedCommand } from "../../src/agent/command-hints.js";

describe("hintForBlockedCommand: turns a blocked command into a one-line 'use this instead' hint", () => {
  it("read-style commands → slidra cat", () => {
    expect(hintForBlockedCommand("cat /home/u/.slidra/work/abc/slides/001.svg", "abc")).toContain("slidra cat abc");
  });

  it("directory-listing commands → slidra ls", () => {
    expect(hintForBlockedCommand("ls -la /home/u/.slidra/work/abc", "abc")).toContain("slidra ls abc");
  });

  it("everything else points to the CLI (file edits only go through commands)", () => {
    expect(hintForBlockedCommand("sed -i s/a/b/ /home/u/.slidra/work/abc/slides/001.svg", "abc")).toContain("slidra");
    expect(hintForBlockedCommand("unzip /home/u/decks/x.slidra", "abc")).toContain("undo snapshot");
  });
});
