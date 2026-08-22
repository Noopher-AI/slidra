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
