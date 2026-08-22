import { describe, expect, it } from "vitest";
import { parseArgv } from "../src/argv.js";

describe("parseArgv new --name", () => {
  it("parses a following value as the presentation name", () => {
    const parsed = parseArgv(["new", "deck.comot", "--name", "我的簡報"]);

    expect(parsed.input).toEqual({ path: "deck.comot", name: "我的簡報" });
  });

  it("leaves name undefined when --name is absent entirely", () => {
    const parsed = parseArgv(["new", "deck.comot"]);

    expect(parsed.input).toEqual({ path: "deck.comot", name: undefined });
  });

  it("fails with a clear error when --name is present but has no following value", () => {
    expect(() => parseArgv(["new", "deck.comot", "--name"])).toThrow();
  });
});

describe("parseArgv text set", () => {
  it("parses the four positionals into structured input", () => {
    const parsed = parseArgv(["text", "set", "abc123", "slides/001.svg", "el-a3f2c1", "Hello"]);

    expect(parsed).toEqual({
      name: "text set",
      input: { id: "abc123", slidePath: "slides/001.svg", elementId: "el-a3f2c1", newText: "Hello" },
    });
  });

  it("accepts an empty string as new-text (clearing text is legitimate)", () => {
    const parsed = parseArgv(["text", "set", "abc123", "slides/001.svg", "el-a3f2c1", ""]);

    expect(parsed.input).toEqual({
      id: "abc123",
      slidePath: "slides/001.svg",
      elementId: "el-a3f2c1",
      newText: "",
    });
  });

  it("fails when new-text is missing entirely", () => {
    expect(() => parseArgv(["text", "set", "abc123", "slides/001.svg", "el-a3f2c1"])).toThrow();
  });

  it("fails on an unknown text subcommand", () => {
    expect(() => parseArgv(["text", "get", "abc123"])).toThrow();
  });
});
