import { describe, expect, it } from "vitest";
import { validateProjectJson, readTemplateEntries, assertSupportedFormatVersion } from "../src/project-json.js";
import { CoMotionError } from "../src/errors.js";
import { FORMAT_VERSION } from "../src/presentation.js";

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

  it("rejects a fonts entry whose licenseFile is an absolute path", () => {
    expect(() =>
      validateProjectJson({ ...valid, fonts: [{ ...fontEntry, licenseFile: "/etc/passwd" }] }),
    ).toThrow(/不合法的路徑/);
  });

  it("rejects a fonts entry whose licenseFile contains '..'", () => {
    expect(() =>
      validateProjectJson({ ...valid, fonts: [{ ...fontEntry, licenseFile: "../outside.txt" }] }),
    ).toThrow(/不合法的路徑/);
  });

  it("rejects two fonts entries with the same family", () => {
    expect(() =>
      validateProjectJson({ ...valid, fonts: [fontEntry, { ...fontEntry, file: "fonts/other.ttf" }] }),
    ).toThrow(/重複的 family/);
  });

  describe("templates ([E4.T7])", () => {
    it("accepts a missing templates field", () => {
      expect(() => validateProjectJson(valid)).not.toThrow();
    });

    it("accepts a pre-[E4.T7] bare-string templates array", () => {
      expect(validateProjectJson({ ...valid, templates: ["templates/001.svg"] }).templates).toEqual([
        "templates/001.svg",
      ]);
    });

    it("accepts a post-upgrade { file, name } templates array", () => {
      const entry = { file: "templates/001.svg", name: "封面" };
      expect(validateProjectJson({ ...valid, templates: [entry] }).templates).toEqual([entry]);
    });

    it("accepts a mixture of bare-string and object entries in the same array", () => {
      const entries = ["templates/001.svg", { file: "templates/002.svg", name: "章節頁" }];
      expect(validateProjectJson({ ...valid, templates: entries }).templates).toEqual(entries);
    });

    it("rejects templates that is not an array, naming the field", () => {
      expect(() => validateProjectJson({ ...valid, templates: "templates/001.svg" })).toThrow(
        /templates 不是陣列/,
      );
    });

    it("rejects a templates entry missing file, naming the field", () => {
      expect(() => validateProjectJson({ ...valid, templates: [{ name: "封面" }] })).toThrow(
        /templates 內的項目缺少或型別錯誤的 file/,
      );
    });

    it("rejects a templates entry missing name, naming the field", () => {
      expect(() => validateProjectJson({ ...valid, templates: [{ file: "templates/001.svg" }] })).toThrow(
        /templates 內的項目缺少或型別錯誤的 name/,
      );
    });

    it("accepts an empty name on a templates entry — blank names are rejected at the command layer, not here", () => {
      expect(() =>
        validateProjectJson({ ...valid, templates: [{ file: "templates/001.svg", name: "" }] }),
      ).not.toThrow();
    });

    it("rejects a templates entry whose file is an absolute path", () => {
      expect(() =>
        validateProjectJson({ ...valid, templates: [{ file: "/etc/passwd", name: "x" }] }),
      ).toThrow(/不合法的路徑/);
    });

    it("rejects a templates entry whose file contains '..'", () => {
      expect(() =>
        validateProjectJson({ ...valid, templates: [{ file: "../outside.svg", name: "x" }] }),
      ).toThrow(/不合法的路徑/);
    });
  });
});

describe("readTemplateEntries", () => {
  const project = { ...valid, formatVersion: FORMAT_VERSION };

  it("returns [] for a project with no templates field", () => {
    expect(readTemplateEntries(project)).toEqual([]);
  });

  it("returns [] for an empty templates array", () => {
    expect(readTemplateEntries({ ...project, templates: [] })).toEqual([]);
  });

  it("normalizes a bare-string entry to { file, name }, name falling back to the basename without extension (A11)", () => {
    expect(readTemplateEntries({ ...project, templates: ["templates/001.svg"] })).toEqual([
      { file: "templates/001.svg", name: "001" },
    ]);
  });

  it("passes an already-object entry through unchanged", () => {
    const entry = { file: "templates/001.svg", name: "封面" };
    expect(readTemplateEntries({ ...project, templates: [entry] })).toEqual([entry]);
  });

  it("normalizes a mixture of bare-string and object entries element by element", () => {
    expect(
      readTemplateEntries({
        ...project,
        templates: ["templates/001.svg", { file: "templates/002.svg", name: "章節頁" }],
      }),
    ).toEqual([
      { file: "templates/001.svg", name: "001" },
      { file: "templates/002.svg", name: "章節頁" },
    ]);
  });
});

describe("assertSupportedFormatVersion", () => {
  const project = { ...valid, formatVersion: FORMAT_VERSION };

  it("passes a project at the current FORMAT_VERSION", () => {
    expect(() => assertSupportedFormatVersion(project)).not.toThrow();
  });

  it("passes a project older than the current FORMAT_VERSION", () => {
    expect(() => assertSupportedFormatVersion({ ...project, formatVersion: FORMAT_VERSION - 1 })).not.toThrow();
  });

  it("rejects a project newer than the current FORMAT_VERSION, naming that it is too new", () => {
    expect(() => assertSupportedFormatVersion({ ...project, formatVersion: FORMAT_VERSION + 1 })).toThrow(
      /較新版本/,
    );
  });
});
