import { describe, expect, it } from "vitest";
import { validateProjectJson } from "../src/project-json.js";
import { CoMotionError } from "../src/errors.js";

const valid = {
  formatVersion: 1,
  name: "測試簡報",
  canvas: { width: 1280, height: 720 },
  slides: ["slides/001.svg"],
};

describe("validateProjectJson", () => {
  it("accepts a structurally valid project.json unchanged", () => {
    expect(validateProjectJson(valid)).toEqual(valid);
  });

  it.each([
    ["an array", []],
    ["a string", "not an object"],
    ["a number", 42],
    ["null", null],
  ])("rejects content that is %s, naming that it is not an object", (_label, input) => {
    expect(() => validateProjectJson(input)).toThrow(/內容不是物件/);
  });

  it("rejects a missing formatVersion, naming the field", () => {
    const { formatVersion: _drop, ...rest } = valid;
    expect(() => validateProjectJson(rest)).toThrow(/formatVersion/);
  });

  it("rejects a non-numeric formatVersion, naming the field", () => {
    expect(() => validateProjectJson({ ...valid, formatVersion: "1" })).toThrow(/formatVersion/);
  });

  it("rejects a missing name, naming the field", () => {
    const { name: _drop, ...rest } = valid;
    expect(() => validateProjectJson(rest)).toThrow(/name/);
  });

  it("rejects a non-string name, naming the field", () => {
    expect(() => validateProjectJson({ ...valid, name: 123 })).toThrow(/name/);
  });

  it("rejects a missing canvas, naming the field", () => {
    const { canvas: _drop, ...rest } = valid;
    expect(() => validateProjectJson(rest)).toThrow(/canvas/);
  });

  it("rejects a canvas missing a numeric width, naming the field", () => {
    expect(() => validateProjectJson({ ...valid, canvas: { height: 720 } })).toThrow(/canvas/);
  });

  it("rejects a canvas missing a numeric height, naming the field", () => {
    expect(() => validateProjectJson({ ...valid, canvas: { width: 1280 } })).toThrow(/canvas/);
  });

  it("rejects a missing slides, naming the field", () => {
    const { slides: _drop, ...rest } = valid;
    expect(() => validateProjectJson(rest)).toThrow(/slides/);
  });

  it("rejects slides that is not an array, naming the field", () => {
    expect(() => validateProjectJson({ ...valid, slides: "slides/001.svg" })).toThrow(/slides/);
  });

  it("rejects a slides array containing a non-string entry, naming the field", () => {
    expect(() => validateProjectJson({ ...valid, slides: ["slides/001.svg", 42] })).toThrow(/slides/);
  });

  it("accepts an empty slides array as structurally valid (a presentation may legally have no slides yet)", () => {
    expect(() => validateProjectJson({ ...valid, slides: [] })).not.toThrow();
  });

  it("accepts unknown extra fields, for forward compatibility across formatVersions", () => {
    expect(() => validateProjectJson({ ...valid, futureField: "not yet invented" })).not.toThrow();
  });

  it("throws CoMotionError, never a native TypeError, for every rejection", () => {
    try {
      validateProjectJson({ formatVersion: 1 });
      throw new Error("expected validateProjectJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoMotionError);
    }
  });

  it("never includes a filesystem path in its message (caller contextualises, if it wants to)", () => {
    try {
      validateProjectJson(null);
      throw new Error("expected validateProjectJson to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(/[/\\]/);
    }
  });

  const fontEntry = {
    file: "fonts/NotoSansTC-Presentation.ttf",
    family: "Noto Sans TC",
    license: "SIL Open Font License 1.1",
    licenseFile: "fonts/LICENSE-NotoSansTC.txt",
    source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC",
  };

  it("accepts a missing fonts field — pre-#71 .comot files stay valid, formatVersion unchanged", () => {
    expect(() => validateProjectJson(valid)).not.toThrow();
    expect(validateProjectJson(valid).fonts).toBeUndefined();
  });

  it("accepts an empty fonts array", () => {
    expect(() => validateProjectJson({ ...valid, fonts: [] })).not.toThrow();
  });

  it("accepts a well-formed fonts array", () => {
    expect(validateProjectJson({ ...valid, fonts: [fontEntry] }).fonts).toEqual([fontEntry]);
  });

  it("rejects fonts that is not an array, naming the field", () => {
    expect(() => validateProjectJson({ ...valid, fonts: fontEntry })).toThrow(/fonts 不是陣列/);
  });

  it.each(["file", "family", "license", "licenseFile", "source"] as const)(
    "rejects a fonts entry missing %s, naming the field",
    (field) => {
      const { [field]: _drop, ...rest } = fontEntry;
      expect(() => validateProjectJson({ ...valid, fonts: [rest] })).toThrow(new RegExp(field));
    },
  );

  it("rejects a fonts entry whose file is an absolute path", () => {
    expect(() => validateProjectJson({ ...valid, fonts: [{ ...fontEntry, file: "/etc/passwd" }] })).toThrow(
      /不合法的路徑/,
    );
  });

  it("rejects a fonts entry whose file contains '..'", () => {
    expect(() => validateProjectJson({ ...valid, fonts: [{ ...fontEntry, file: "../outside.ttf" }] })).toThrow(
      /不合法的路徑/,
    );
  });

  it("rejects two fonts entries with the same family", () => {
    expect(() =>
      validateProjectJson({ ...valid, fonts: [fontEntry, { ...fontEntry, file: "fonts/other.ttf" }] }),
    ).toThrow(/重複的 family/);
  });
});
