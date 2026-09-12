import { describe, expect, it } from "vitest";
import { presentationFontFaces, setPresentationFonts, wrapPlayDocument } from "../src/canvas.js";

/**
 * Every font a presentation embeds must be declared. If a single hardcoded
 * family were assumed instead, a presentation with a second font imported
 * would fall back to the host's system font for that text, both on screen
 * and in the exported PDF.
 */
describe("@font-face injection into the slide document, sourced from project.json", () => {
  it("declares one @font-face per embedded font, with the url pointing at that file", () => {
    setPresentationFonts([
      { file: "fonts/NotoSansTC-Presentation.ttf", family: "Noto Sans TC" },
      { file: "fonts/Noto-Serif-TC.ttf", family: "Noto Serif TC" },
    ]);
    const style = presentationFontFaces();
    expect(style).toContain('font-family:"Noto Sans TC"');
    expect(style).toContain("/api/raw/fonts/NotoSansTC-Presentation.ttf");
    expect(style).toContain('font-family:"Noto Serif TC"');
    expect(style).toContain("/api/raw/fonts/Noto-Serif-TC.ttf");
  });

  it("puts the declaration into the play document's actual <head>", () => {
    setPresentationFonts([{ file: "fonts/Noto-Serif-TC.ttf", family: "Noto Serif TC" }]);
    const doc = wrapPlayDocument("<svg></svg>", "/api/raw/slides", "", "{}");
    expect(doc).toContain("/api/raw/fonts/Noto-Serif-TC.ttf");
  });

  it("falls back to the default entry for an old presentation with no fonts field, instead of ending up with no font at all", () => {
    setPresentationFonts(undefined);
    expect(presentationFontFaces()).toContain("NotoSansTC-Presentation.ttf");
  });
});
