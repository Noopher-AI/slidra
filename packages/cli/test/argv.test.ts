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
