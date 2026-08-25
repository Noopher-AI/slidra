import { describe, expect, it } from "vitest";
import { CoMotionError } from "@co-motion/core";
import { parseArgv } from "../src/argv.js";

describe("parseArgv new positional path", () => {
  it("rejects a flag-shaped value in the path position instead of creating a file literally named --name", () => {
    // `co-motion new --name Foo` must be reported as a missing path, not
    // silently treated as a request to create a file called "--name".
    expect(() => parseArgv(["new", "--name", "Foo"])).toThrow(CoMotionError);
  });

  it("reports the missing path, not the flag string, as the problem", () => {
    try {
      parseArgv(["new", "--name", "Foo"]);
      throw new Error("expected parseArgv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoMotionError);
      expect((error as CoMotionError).message).toContain("path");
    }
  });
});

describe("parseArgv --name value", () => {
  it("rejects a flag-shaped value for --name instead of accepting it as the presentation name", () => {
    // `co-motion new deck.comot --name --foo` means --name was left
    // without a value; --foo must not be silently accepted as the name.
    expect(() => parseArgv(["new", "deck.comot", "--name", "--foo"])).toThrow(CoMotionError);
  });
});

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

describe("parseArgv convert", () => {
  it("parses the presentation id into { name: \"convert\", input: { id } }", () => {
    expect(parseArgv(["convert", "abc123"])).toEqual({ name: "convert", input: { id: "abc123" } });
  });

  it("reports the missing presentation id rather than converting something unnamed", () => {
    expect(() => parseArgv(["convert"])).toThrow(CoMotionError);
    expect(() => parseArgv(["convert"])).toThrow("命令 convert 缺少參數：presentation-id");
  });

  it("rejects a flag-shaped value in the id position", () => {
    expect(() => parseArgv(["convert", "--dry-run"])).toThrow(CoMotionError);
  });
});
