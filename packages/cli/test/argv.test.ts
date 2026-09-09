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
      input: { id: "abc123", slidePath: "slides/001.svg", elementId: "el-a3f2c1", newText: "Hello", force: false },
    });
  });

  it("accepts an empty string as new-text (clearing text is legitimate)", () => {
    const parsed = parseArgv(["text", "set", "abc123", "slides/001.svg", "el-a3f2c1", ""]);

    expect(parsed.input).toEqual({
      id: "abc123",
      slidePath: "slides/001.svg",
      elementId: "el-a3f2c1",
      newText: "",
      force: false,
    });
  });

  it("fails when new-text is missing entirely", () => {
    expect(() => parseArgv(["text", "set", "abc123", "slides/001.svg", "el-a3f2c1"])).toThrow();
  });

  it("fails on an unknown text subcommand", () => {
    expect(() => parseArgv(["text", "get", "abc123"])).toThrow();
  });
});

describe("parseArgv element resize (NOOP-90/T2, new alongside element scale)", () => {
  it("parses width/height/anchor into structured input, comma-splitting the element-id list", () => {
    const parsed = parseArgv([
      "element", "resize", "p1", "slides/001.svg", "el-a,el-b", "--width", "200", "--height", "100", "--anchor", "se",
    ]);

    expect(parsed).toEqual({
      name: "element resize",
      input: { id: "p1", slidePath: "slides/001.svg", elementIds: ["el-a", "el-b"], width: 200, height: 100, anchor: "se", force: false },
    });
  });

  it("defaults anchor to nw when --anchor is absent", () => {
    const parsed = parseArgv(["element", "resize", "p1", "slides/001.svg", "el-a", "--width", "10", "--height", "10"]);
    expect(parsed.input).toMatchObject({ anchor: "nw" });
  });

  it("rejects an anchor outside nw/ne/sw/se", () => {
    expect(() =>
      parseArgv(["element", "resize", "p1", "slides/001.svg", "el-a", "--width", "10", "--height", "10", "--anchor", "center"]),
    ).toThrow("element resize 不支援的 anchor：center");
  });

  it("requires --width", () => {
    expect(() => parseArgv(["element", "resize", "p1", "slides/001.svg", "el-a", "--height", "10"])).toThrow(CoMotionError);
  });

  it("requires --height", () => {
    expect(() => parseArgv(["element", "resize", "p1", "slides/001.svg", "el-a", "--width", "10"])).toThrow(CoMotionError);
  });

  it("parses a trailing --force", () => {
    const parsed = parseArgv([
      "element", "resize", "p1", "slides/001.svg", "el-a", "--width", "10", "--height", "10", "--force",
    ]);
    expect(parsed.input).toMatchObject({ force: true });
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

describe("parseArgv template list ([E4.T7], A10)", () => {
  it("parses the presentation id", () => {
    expect(parseArgv(["template", "list", "p1"])).toEqual({ name: "template list", input: { id: "p1" } });
  });

  it("reports the missing presentation id", () => {
    expect(() => parseArgv(["template", "list"])).toThrow("命令 template list 缺少參數：presentation-id");
  });
});

describe("parseArgv template rename ([E4.T7], A5/A6/A10)", () => {
  it("parses id, template-path, and new-name into structured input", () => {
    expect(parseArgv(["template", "rename", "p1", "templates/001.svg", "封面"])).toEqual({
      name: "template rename",
      input: { id: "p1", templatePath: "templates/001.svg", newName: "封面" },
    });
  });

  it("accepts an empty string as new-name (rejected downstream as blank, not treated as omitted)", () => {
    expect(parseArgv(["template", "rename", "p1", "templates/001.svg", ""])).toEqual({
      name: "template rename",
      input: { id: "p1", templatePath: "templates/001.svg", newName: "" },
    });
  });

  it("fails when new-name is missing entirely, distinct from an empty string", () => {
    expect(() => parseArgv(["template", "rename", "p1", "templates/001.svg"])).toThrow(
      "命令 template rename 缺少參數：new-name",
    );
  });

  it("reports the missing template-path rather than swallowing it into new-name", () => {
    expect(() => parseArgv(["template", "rename", "p1"])).toThrow("命令 template rename 缺少參數：template-path");
  });
});

describe("parseArgv template delete ([E4.T7], A8/A10)", () => {
  it("parses id and template-path", () => {
    expect(parseArgv(["template", "delete", "p1", "templates/001.svg"])).toEqual({
      name: "template delete",
      input: { id: "p1", templatePath: "templates/001.svg" },
    });
  });

  it("reports the missing template-path", () => {
    expect(() => parseArgv(["template", "delete", "p1"])).toThrow("命令 template delete 缺少參數：template-path");
  });
});

describe("parseArgv template add --name ([E4.T7])", () => {
  it("parses --name alongside --from", () => {
    expect(parseArgv(["template", "add", "p1", "--from", "slides/001.svg", "--name", "封面"])).toEqual({
      name: "template add",
      input: { id: "p1", from: "slides/001.svg", name: "封面" },
    });
  });

  it("leaves name undefined when --name is absent, unchanged from before [E4.T7]", () => {
    expect(parseArgv(["template", "add", "p1"])).toEqual({
      name: "template add",
      input: { id: "p1", from: undefined, name: undefined },
    });
  });
});

describe("parseArgv textbox add — --font-weight/--fill/--align (NOOP-65)", () => {
  it("parses --font-weight and --fill alongside the existing flags", () => {
    const parsed = parseArgv([
      "textbox", "add", "p1", "slides/001.svg",
      "--x", "10", "--y", "20", "--width", "300", "--text", "Hi",
      "--font-weight", "700", "--fill", "#111",
    ]);
    expect(parsed.input).toMatchObject({ fontWeight: 700, fill: "#111" });
  });

  it("leaves fontWeight/fill/align undefined when absent, unchanged from before this ticket", () => {
    const parsed = parseArgv([
      "textbox", "add", "p1", "slides/001.svg", "--x", "0", "--y", "0", "--width", "100", "--text", "x",
    ]);
    expect(parsed.input).toMatchObject({ fontWeight: undefined, fill: undefined, align: undefined });
  });

  it("parses --align center/right", () => {
    const parsed = parseArgv([
      "textbox", "add", "p1", "slides/001.svg", "--x", "0", "--y", "0", "--width", "100", "--text", "x", "--align", "center",
    ]);
    expect(parsed.input).toMatchObject({ align: "center" });
  });

  it("rejects an --align value outside left/center/right", () => {
    expect(() =>
      parseArgv([
        "textbox", "add", "p1", "slides/001.svg", "--x", "0", "--y", "0", "--width", "100", "--text", "x", "--align", "justify",
      ]),
    ).toThrow("--align 必須是 left、center 或 right：justify");
  });

  it("rejects a non-numeric --font-weight", () => {
    expect(() =>
      parseArgv([
        "textbox", "add", "p1", "slides/001.svg", "--x", "0", "--y", "0", "--width", "100", "--text", "x", "--font-weight", "bold",
      ]),
    ).toThrow(CoMotionError);
  });
});

describe("parseArgv text style set (NOOP-65 §4.2)", () => {
  it("parses --range and --font-weight into structured input", () => {
    const parsed = parseArgv([
      "text", "style", "set", "p1", "slides/001.svg", "el-a", "--range", "2:5", "--font-weight", "bold",
    ]);
    expect(parsed).toEqual({
      name: "text style set",
      input: {
        id: "p1",
        slidePath: "slides/001.svg",
        elementId: "el-a",
        rangeStart: 2,
        rangeEnd: 5,
        fontWeight: "bold",
        fontStyle: undefined,
        force: false,
      },
    });
  });

  it("parses --font-style alone, without requiring --font-weight", () => {
    const parsed = parseArgv([
      "text", "style", "set", "p1", "slides/001.svg", "el-a", "--range", "0:1", "--font-style", "italic",
    ]);
    expect(parsed.input).toMatchObject({ fontWeight: undefined, fontStyle: "italic" });
  });

  it("reports the missing --range", () => {
    expect(() =>
      parseArgv(["text", "style", "set", "p1", "slides/001.svg", "el-a", "--font-weight", "bold"]),
    ).toThrow("命令 text style set 缺少參數：--range");
  });

  it("rejects a --range that is not digits:digits, echoing the original string", () => {
    expect(() =>
      parseArgv(["text", "style", "set", "p1", "slides/001.svg", "el-a", "--range", "2-5", "--font-weight", "bold"]),
    ).toThrow("--range 格式錯誤，必須是 數字:數字：2-5");
  });

  it("rejects a --range whose start is not strictly less than its end", () => {
    expect(() =>
      parseArgv(["text", "style", "set", "p1", "slides/001.svg", "el-a", "--range", "5:5", "--font-weight", "bold"]),
    ).toThrow("--range 的起點必須小於終點");
  });

  it("rejects when neither --font-weight nor --font-style is given", () => {
    expect(() =>
      parseArgv(["text", "style", "set", "p1", "slides/001.svg", "el-a", "--range", "0:1"]),
    ).toThrow("命令 text style set 至少要給 --font-weight 或 --font-style");
  });

  it("parses the trailing --force flag", () => {
    const parsed = parseArgv([
      "text", "style", "set", "p1", "slides/001.svg", "el-a", "--range", "0:1", "--font-weight", "bold", "--force",
    ]);
    expect(parsed.input).toMatchObject({ force: true });
  });

  it("fails on an unknown text style subcommand", () => {
    expect(() => parseArgv(["text", "style", "clear", "p1"])).toThrow();
  });
});

// NOOP-129 round-2: `slide render` was only reachable through
// `registry.dispatch` (server, tests) — no shell entry point existed, which
// blocked #199's A8 acceptance criterion (`co-motion slide render` from a
// real shell).
describe("parseArgv slide render (NOOP-65 A8 CLI entry point)", () => {
  it("parses presentation-id and slide-path into the same shape registry.dispatch('slide render', …) already expects", () => {
    const parsed = parseArgv(["slide", "render", "p1", "slides/001.svg"]);
    expect(parsed).toEqual({ name: "slide render", input: { id: "p1", path: "slides/001.svg" } });
  });

  it("reports the missing slide-path", () => {
    expect(() => parseArgv(["slide", "render", "p1"])).toThrow("命令 slide render 缺少參數：slide-path");
  });
});

describe("parseArgv text list set (NOOP-65 §4.3, 決定 E)", () => {
  it("parses --paragraph and --kind into structured input", () => {
    const parsed = parseArgv(["text", "list", "set", "p1", "slides/001.svg", "el-a", "--paragraph", "0", "--kind", "bullet"]);
    expect(parsed).toEqual({
      name: "text list set",
      input: { id: "p1", slidePath: "slides/001.svg", elementId: "el-a", paragraph: 0, kind: "bullet", force: false },
    });
  });

  it("reports the missing --paragraph", () => {
    expect(() =>
      parseArgv(["text", "list", "set", "p1", "slides/001.svg", "el-a", "--kind", "bullet"]),
    ).toThrow("命令 text list set 缺少參數：--paragraph");
  });

  it("rejects a negative or non-integer --paragraph", () => {
    expect(() =>
      parseArgv(["text", "list", "set", "p1", "slides/001.svg", "el-a", "--paragraph", "-1", "--kind", "bullet"]),
    ).toThrow(CoMotionError);
    expect(() =>
      parseArgv(["text", "list", "set", "p1", "slides/001.svg", "el-a", "--paragraph", "1.5", "--kind", "bullet"]),
    ).toThrow(CoMotionError);
  });

  it("rejects a --kind outside bullet/number/none, echoing the received value", () => {
    expect(() =>
      parseArgv(["text", "list", "set", "p1", "slides/001.svg", "el-a", "--paragraph", "0", "--kind", "star"]),
    ).toThrow("--kind 必須是 bullet、number 或 none：star");
  });

  it("parses the trailing --force flag", () => {
    const parsed = parseArgv([
      "text", "list", "set", "p1", "slides/001.svg", "el-a", "--paragraph", "0", "--kind", "none", "--force",
    ]);
    expect(parsed.input).toMatchObject({ force: true });
  });

  it("fails on an unknown text list subcommand", () => {
    expect(() => parseArgv(["text", "list", "clear", "p1"])).toThrow();
  });
});

describe("parseArgv slide transition set ([E2.T11], replacing presentation transition set)", () => {
  it("parses all four value flags plus --all", () => {
    expect(
      parseArgv([
        "slide", "transition", "set", "p1", "slides/001.svg",
        "--enter", "fade", "--enter-duration", "0.8",
        "--exit", "zoom", "--exit-duration", "0.5",
        "--all",
      ]),
    ).toEqual({
      name: "slide transition set",
      input: { id: "p1", slidePath: "slides/001.svg", enter: "fade", enterDuration: 0.8, exit: "zoom", exitDuration: 0.5, all: true },
    });
  });

  it("--all alone (no value flags) parses as legal — applying the slide's current values is the handler's job, not argv's", () => {
    expect(parseArgv(["slide", "transition", "set", "p1", "slides/001.svg", "--all"])).toEqual({
      name: "slide transition set",
      input: { id: "p1", slidePath: "slides/001.svg", enter: undefined, enterDuration: undefined, exit: undefined, exitDuration: undefined, all: true },
    });
  });

  it("rejects an --enter value outside none/fade/slide/zoom, echoing the received value", () => {
    expect(() => parseArgv(["slide", "transition", "set", "p1", "slides/001.svg", "--enter", "wipe"])).toThrow(
      "slide transition set 不支援的 enter：wipe",
    );
  });

  it("rejects an --exit value outside none/fade/slide/zoom, echoing the received value", () => {
    expect(() => parseArgv(["slide", "transition", "set", "p1", "slides/001.svg", "--exit", "spin"])).toThrow(
      "slide transition set 不支援的 exit：spin",
    );
  });

  it("rejects a non-numeric --enter-duration", () => {
    expect(() => parseArgv(["slide", "transition", "set", "p1", "slides/001.svg", "--enter-duration", "abc"])).toThrow(
      CoMotionError,
    );
  });

  it("requires at least one changed field or --all", () => {
    expect(() => parseArgv(["slide", "transition", "set", "p1", "slides/001.svg"])).toThrow(
      "slide transition set 至少要指定一個要改的欄位",
    );
  });

  it("requires <slide-path> even when --all is given", () => {
    expect(() => parseArgv(["slide", "transition", "set", "p1", "--all"])).toThrow(CoMotionError);
  });

  it("fails on an unknown slide transition subcommand", () => {
    expect(() => parseArgv(["slide", "transition", "clear", "p1"])).toThrow("未知的子命令：slide transition clear");
  });

  it("presentation transition set no longer parses as its own command — rejected as an unknown presentation subcommand", () => {
    expect(() => parseArgv(["presentation", "transition", "set", "p1", "fade"])).toThrow(
      "未知的子命令：presentation transition",
    );
  });
});

describe("parseArgv textbox align（#200 §4.1）", () => {
  it("parses the four positionals into structured input", () => {
    const parsed = parseArgv(["textbox", "align", "p1", "slides/001.svg", "el-a", "center"]);
    expect(parsed).toEqual({
      name: "textbox align",
      input: { id: "p1", slidePath: "slides/001.svg", elementId: "el-a", align: "center", force: false },
    });
  });

  it("rejects an align value outside left/center/right", () => {
    expect(() => parseArgv(["textbox", "align", "p1", "slides/001.svg", "el-a", "middle"])).toThrow(
      "align 必須是 left、center 或 right：middle",
    );
  });

  it("parses the trailing --force flag", () => {
    const parsed = parseArgv(["textbox", "align", "p1", "slides/001.svg", "el-a", "right", "--force"]);
    expect(parsed.input).toMatchObject({ force: true });
  });
});

describe("parseArgv slide style set（#200 §4.3/§4.4）", () => {
  it("parses --background and --accent together", () => {
    const parsed = parseArgv([
      "slide", "style", "set", "p1", "slides/001.svg", "--background", "#202020", "--accent", "#00ff00",
    ]);
    expect(parsed).toEqual({
      name: "slide style set",
      input: { id: "p1", slidePath: "slides/001.svg", background: "#202020", accent: "#00ff00" },
    });
  });

  it("parses --background alone, --accent left undefined", () => {
    const parsed = parseArgv(["slide", "style", "set", "p1", "slides/001.svg", "--background", "#202020"]);
    expect(parsed.input).toEqual({ id: "p1", slidePath: "slides/001.svg", background: "#202020", accent: undefined });
  });

  it("accepts an empty string as a legal value (clears the declaration)", () => {
    const parsed = parseArgv(["slide", "style", "set", "p1", "slides/001.svg", "--background", ""]);
    expect(parsed.input).toMatchObject({ background: "" });
  });

  it("rejects neither flag given", () => {
    expect(() => parseArgv(["slide", "style", "set", "p1", "slides/001.svg"])).toThrow(
      "命令 slide style set 至少要給 --background 或 --accent",
    );
  });
});

describe("parseArgv presentation canvas set（#200 §4.3）", () => {
  it("parses --width/--height", () => {
    const parsed = parseArgv(["presentation", "canvas", "set", "p1", "--width", "1024", "--height", "768"]);
    expect(parsed).toEqual({
      name: "presentation canvas set",
      input: { id: "p1", width: 1024, height: 768 },
    });
  });

  it("rejects a missing --height", () => {
    expect(() => parseArgv(["presentation", "canvas", "set", "p1", "--width", "1024"])).toThrow(
      "命令 presentation canvas set 缺少參數：--height",
    );
  });

  it("rejects a non-numeric --width", () => {
    expect(() => parseArgv(["presentation", "canvas", "set", "p1", "--width", "abc", "--height", "768"])).toThrow(
      "--width 不是合法數字：abc",
    );
  });

  it("fails on an unknown presentation canvas subcommand", () => {
    expect(() => parseArgv(["presentation", "canvas", "resize", "p1"])).toThrow("未知的子命令：presentation canvas resize");
  });
});

describe("parseArgv element insert — video/audio kind ([E2.T17] plan §4.5)", () => {
  it("accepts video/audio alongside the five pre-existing kinds", () => {
    const parsed = parseArgv([
      "element", "insert", "video", "p1", "slides/001.svg",
      "--x", "720", "--y", "144", "--width", "460", "--height", "432", "--media", "../assets/clip.webm",
    ]);
    expect(parsed).toMatchObject({
      name: "element insert",
      input: { id: "p1", slidePath: "slides/001.svg", kind: "video", x: 720, y: 144, width: 460, height: 432, media: "../assets/clip.webm" },
    });
  });

  it("--embed 被帶進 input（值本身由 core 驗證）", () => {
    const parsed = parseArgv([
      "element", "insert", "video", "p1", "slides/001.svg",
      "--x", "0", "--y", "0", "--width", "640", "--height", "360",
      "--media", "https://www.youtube-nocookie.com/embed/MtKyexX-GQc", "--embed", "youtube",
    ]);
    expect(parsed).toMatchObject({ name: "element insert", input: { embed: "youtube" } });
  });

  it("still rejects a kind outside the (now seven-entry) whitelist", () => {
    expect(() => parseArgv(["element", "insert", "bogus", "p1", "slides/001.svg"])).toThrow(
      "element insert 不支援的 kind：bogus",
    );
  });
});

describe("parseArgv asset import（NOOP-281/F5：cli.md 的並存期已知限制，補上 case \"asset\"）", () => {
  it("解析 asset import <id> <source> [--as <value>]", () => {
    const parsed = parseArgv(["asset", "import", "p1", "./sales.csv", "--as", "csv"]);
    expect(parsed).toEqual({
      name: "asset import",
      input: { id: "p1", source: "./sales.csv", as: "csv" },
    });
  });

  it("未知的 asset 子命令拋出「未知的子命令」錯誤", () => {
    expect(() => parseArgv(["asset", "export", "p1"])).toThrow("未知的子命令：asset export p1");
  });
});
