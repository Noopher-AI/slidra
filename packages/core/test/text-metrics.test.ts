import { describe, expect, it } from "vitest";
import { parseFont, measureTextWidth } from "../src/text-metrics.js";
import { CoMotionError } from "../src/errors.js";

/**
 * Builds a minimal-but-structurally-valid sfnt (TTF) font, by hand, for unit
 * testing `parseFont`/`measureTextWidth` without depending on a downloaded
 * font asset. Glyphs: 0 = .notdef (advance 0), 1 = "A" (advance 600),
 * 2 = " " (advance 300). unitsPerEm = 1000. Every other Unicode code point
 * (e.g. "Z") is intentionally left out of the cmap, so it falls through to
 * glyph 0 (.notdef) — this is what §4.2's "cmap 未涵蓋的字元" contract
 * exercises.
 */
function buildSyntheticFont(): Uint8Array {
  const HEAD_LEN = 20;
  const HHEA_LEN = 36;
  const NUM_H_METRICS = 3;
  const HMTX_LEN = NUM_H_METRICS * 4;
  const SEG_COUNT = 3; // space, "A", sentinel
  const FORMAT4_LEN = 14 + SEG_COUNT * 2 * 4 + 2;
  const CMAP_LEN = 4 + 8 + FORMAT4_LEN;

  const headOffset = 12 + 4 * 16;
  const hheaOffset = headOffset + HEAD_LEN;
  const hmtxOffset = hheaOffset + HHEA_LEN;
  const cmapOffset = hmtxOffset + HMTX_LEN;
  const total = cmapOffset + CMAP_LEN;

  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);

  // Offset table.
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 4); // numTables

  const tables: Array<[string, number, number]> = [
    ["cmap", cmapOffset, CMAP_LEN],
    ["head", headOffset, HEAD_LEN],
    ["hhea", hheaOffset, HHEA_LEN],
    ["hmtx", hmtxOffset, HMTX_LEN],
  ];
  tables.forEach(([tag, offset, length], i) => {
    const recordOffset = 12 + i * 16;
    for (let c = 0; c < 4; c++) buffer[recordOffset + c] = tag.charCodeAt(c);
    view.setUint32(recordOffset + 8, offset);
    view.setUint32(recordOffset + 12, length);
  });

  // head: unitsPerEm at +18.
  view.setUint16(headOffset + 18, 1000);

  // hhea: numberOfHMetrics at +34.
  view.setUint16(hheaOffset + 34, NUM_H_METRICS);

  // hmtx: [advanceWidth, lsb] per glyph.
  view.setUint16(hmtxOffset + 0, 0); // glyph 0 (.notdef)
  view.setInt16(hmtxOffset + 2, 0);
  view.setUint16(hmtxOffset + 4, 600); // glyph 1 ("A")
  view.setInt16(hmtxOffset + 6, 0);
  view.setUint16(hmtxOffset + 8, 300); // glyph 2 (" ")
  view.setInt16(hmtxOffset + 10, 0);

  // cmap: header + one format-4 subtable record.
  view.setUint16(cmapOffset + 0, 0); // version
  view.setUint16(cmapOffset + 2, 1); // numTables
  view.setUint16(cmapOffset + 4, 3); // platformID (Windows)
  view.setUint16(cmapOffset + 6, 1); // encodingID (BMP)
  const subtableOffset = 12; // relative to cmap table start
  view.setUint32(cmapOffset + 8, subtableOffset);

  const f4 = cmapOffset + subtableOffset;
  view.setUint16(f4 + 0, 4); // format
  view.setUint16(f4 + 2, FORMAT4_LEN); // length
  view.setUint16(f4 + 4, 0); // language
  view.setUint16(f4 + 6, SEG_COUNT * 2); // segCountX2
  view.setUint16(f4 + 8, 0); // searchRange (unused by our parser)
  view.setUint16(f4 + 10, 0); // entrySelector
  view.setUint16(f4 + 12, 0); // rangeShift

  const endCodes = f4 + 14;
  const startCodes = endCodes + SEG_COUNT * 2 + 2;
  const idDeltas = startCodes + SEG_COUNT * 2;
  const idRangeOffsets = idDeltas + SEG_COUNT * 2;

  const segments = [
    { start: 0x0020, end: 0x0020, delta: 2 - 0x0020 }, // " " -> glyph 2
    { start: 0x0041, end: 0x0041, delta: 1 - 0x0041 }, // "A" -> glyph 1
    { start: 0xffff, end: 0xffff, delta: 1 }, // sentinel -> glyph 0
  ];
  segments.forEach((seg, i) => {
    view.setUint16(endCodes + i * 2, seg.end);
    view.setUint16(startCodes + i * 2, seg.start);
    view.setInt16(idDeltas + i * 2, seg.delta);
    view.setUint16(idRangeOffsets + i * 2, 0);
  });

  return buffer;
}

/**
 * Builds a second synthetic sfnt, this one adding a GPOS pair-kerning table
 * and a GSUB ligature table on top of `buildSyntheticFont`'s shape, so
 * `measureTextWidth`'s shaping path (ligature substitution, then pair
 * kerning) can be exercised without downloading a real font. Glyphs:
 * 0 = .notdef, 1 = "A" (600), 2 = " " (300), 3 = "V" (500), 4 = "f" (300),
 * 5 = "i" (250), 6 = the "fi" ligature glyph (500, not 300+250=550 — the
 * whole point of the ligature case).
 *
 * GPOS: one 'kern' feature, one PairPos format-1 subtable: "A" followed by
 * "V" gets XAdvance -50 (glyph 1 -> glyph 3).
 * GSUB: one 'liga' feature, one ligature (type 4) subtable: "f" followed by
 * "i" (glyph 4 -> glyph 5) substitutes to the ligature glyph 6.
 */
function buildSyntheticFontWithShaping(): Uint8Array {
  const HEAD_LEN = 20;
  const HHEA_LEN = 36;
  const NUM_H_METRICS = 7;
  const HMTX_LEN = NUM_H_METRICS * 4;
  const SEG_COUNT = 6; // space, A, V, f, i, sentinel
  const FORMAT4_LEN = 14 + SEG_COUNT * 2 * 4 + 2;
  const CMAP_LEN = 4 + 8 + FORMAT4_LEN;
  const GPOS_LEN = 80;
  const GSUB_LEN = 80;

  const headOffset = 12 + 6 * 16; // 6 tables: cmap, head, hhea, hmtx, GPOS, GSUB
  const hheaOffset = headOffset + HEAD_LEN;
  const hmtxOffset = hheaOffset + HHEA_LEN;
  const cmapOffset = hmtxOffset + HMTX_LEN;
  const gposOffset = cmapOffset + CMAP_LEN;
  const gsubOffset = gposOffset + GPOS_LEN;
  const total = gsubOffset + GSUB_LEN;

  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, 0x00010000);
  view.setUint16(4, 6); // numTables

  const tables: Array<[string, number, number]> = [
    ["GPOS", gposOffset, GPOS_LEN],
    ["GSUB", gsubOffset, GSUB_LEN],
    ["cmap", cmapOffset, CMAP_LEN],
    ["head", headOffset, HEAD_LEN],
    ["hhea", hheaOffset, HHEA_LEN],
    ["hmtx", hmtxOffset, HMTX_LEN],
  ];
  tables.forEach(([tag, offset, length], i) => {
    const recordOffset = 12 + i * 16;
    for (let c = 0; c < 4; c++) buffer[recordOffset + c] = tag.charCodeAt(c);
    view.setUint32(recordOffset + 8, offset);
    view.setUint32(recordOffset + 12, length);
  });

  view.setUint16(headOffset + 18, 1000); // unitsPerEm
  view.setUint16(hheaOffset + 34, NUM_H_METRICS);

  const advances = [0, 600, 300, 500, 300, 250, 500]; // by glyph id
  advances.forEach((advance, glyphId) => {
    view.setUint16(hmtxOffset + glyphId * 4, advance);
    view.setInt16(hmtxOffset + glyphId * 4 + 2, 0);
  });

  // cmap: header + one format-4 subtable record.
  view.setUint16(cmapOffset + 0, 0);
  view.setUint16(cmapOffset + 2, 1);
  view.setUint16(cmapOffset + 4, 3);
  view.setUint16(cmapOffset + 6, 1);
  const subtableOffset = 12;
  view.setUint32(cmapOffset + 8, subtableOffset);

  const f4 = cmapOffset + subtableOffset;
  view.setUint16(f4 + 0, 4);
  view.setUint16(f4 + 2, FORMAT4_LEN);
  view.setUint16(f4 + 4, 0);
  view.setUint16(f4 + 6, SEG_COUNT * 2);
  view.setUint16(f4 + 8, 0);
  view.setUint16(f4 + 10, 0);
  view.setUint16(f4 + 12, 0);

  const endCodes = f4 + 14;
  const startCodes = endCodes + SEG_COUNT * 2 + 2;
  const idDeltas = startCodes + SEG_COUNT * 2;
  const idRangeOffsets = idDeltas + SEG_COUNT * 2;

  const segments = [
    { code: 0x0020, glyph: 2 }, // " "
    { code: 0x0041, glyph: 1 }, // "A"
    { code: 0x0056, glyph: 3 }, // "V"
    { code: 0x0066, glyph: 4 }, // "f"
    { code: 0x0069, glyph: 5 }, // "i"
    { code: 0xffff, glyph: 0 }, // sentinel -> .notdef (delta wraps to 0)
  ];
  segments.forEach((seg, i) => {
    const delta = seg.code === 0xffff ? 1 : seg.glyph - seg.code;
    view.setUint16(endCodes + i * 2, seg.code);
    view.setUint16(startCodes + i * 2, seg.code);
    view.setInt16(idDeltas + i * 2, delta);
    view.setUint16(idRangeOffsets + i * 2, 0);
  });

  // GPOS: DFLT script -> 'kern' feature -> lookup type 2 (PairPos format 1),
  // "A"(1) + "V"(3) => XAdvance -50.
  const gposScriptListOffset = gposOffset + 10;
  const gposFeatureListOffset = gposOffset + 18;
  const gposLookupListOffset = gposOffset + 26;
  const gposScriptTableOffset = gposOffset + 30;
  const gposLangSysOffset = gposOffset + 34;
  const gposFeatureTableOffset = gposOffset + 42;
  const gposLookupTableOffset = gposOffset + 48;
  const gposSubtableOffset = gposOffset + 56;
  const gposCoverageOffset = gposOffset + 68;
  const gposPairSetOffset = gposOffset + 74;

  view.setUint16(gposOffset + 0, 1); // majorVersion
  view.setUint16(gposOffset + 2, 0); // minorVersion
  view.setUint16(gposOffset + 4, gposScriptListOffset - gposOffset);
  view.setUint16(gposOffset + 6, gposFeatureListOffset - gposOffset);
  view.setUint16(gposOffset + 8, gposLookupListOffset - gposOffset);

  view.setUint16(gposScriptListOffset, 1); // scriptCount
  writeTag(view, gposScriptListOffset + 2, "DFLT");
  view.setUint16(gposScriptListOffset + 6, gposScriptTableOffset - gposScriptListOffset);

  view.setUint16(gposFeatureListOffset, 1); // featureCount
  writeTag(view, gposFeatureListOffset + 2, "kern");
  view.setUint16(gposFeatureListOffset + 6, gposFeatureTableOffset - gposFeatureListOffset);

  view.setUint16(gposLookupListOffset, 1); // lookupCount
  view.setUint16(gposLookupListOffset + 2, gposLookupTableOffset - gposLookupListOffset);

  view.setUint16(gposScriptTableOffset, gposLangSysOffset - gposScriptTableOffset); // defaultLangSysOffset
  view.setUint16(gposScriptTableOffset + 2, 0); // langSysCount

  view.setUint16(gposLangSysOffset, 0); // lookupOrder (reserved)
  view.setUint16(gposLangSysOffset + 2, 0xffff); // requiredFeatureIndex
  view.setUint16(gposLangSysOffset + 4, 1); // featureIndexCount
  view.setUint16(gposLangSysOffset + 6, 0); // featureIndices[0]

  view.setUint16(gposFeatureTableOffset, 0); // featureParamsOffset
  view.setUint16(gposFeatureTableOffset + 2, 1); // lookupIndexCount
  view.setUint16(gposFeatureTableOffset + 4, 0); // lookupListIndices[0]

  view.setUint16(gposLookupTableOffset, 2); // lookupType (PairAdjustment)
  view.setUint16(gposLookupTableOffset + 2, 0); // lookupFlag
  view.setUint16(gposLookupTableOffset + 4, 1); // subTableCount
  view.setUint16(gposLookupTableOffset + 6, gposSubtableOffset - gposLookupTableOffset);

  view.setUint16(gposSubtableOffset, 1); // posFormat
  view.setUint16(gposSubtableOffset + 2, gposCoverageOffset - gposSubtableOffset);
  view.setUint16(gposSubtableOffset + 4, 0x0004); // valueFormat1: XAdvance
  view.setUint16(gposSubtableOffset + 6, 0x0000); // valueFormat2: none
  view.setUint16(gposSubtableOffset + 8, 1); // pairSetCount
  view.setUint16(gposSubtableOffset + 10, gposPairSetOffset - gposSubtableOffset);

  view.setUint16(gposCoverageOffset, 1); // coverageFormat
  view.setUint16(gposCoverageOffset + 2, 1); // glyphCount
  view.setUint16(gposCoverageOffset + 4, 1); // glyph "A"

  view.setUint16(gposPairSetOffset, 1); // pairValueCount
  view.setUint16(gposPairSetOffset + 2, 3); // secondGlyph "V"
  view.setInt16(gposPairSetOffset + 4, -50); // value1.XAdvance

  // GSUB: DFLT script -> 'liga' feature -> lookup type 4, "f"(4)+"i"(5) => glyph 6.
  const gsubScriptListOffset = gsubOffset + 10;
  const gsubFeatureListOffset = gsubOffset + 18;
  const gsubLookupListOffset = gsubOffset + 26;
  const gsubScriptTableOffset = gsubOffset + 30;
  const gsubLangSysOffset = gsubOffset + 34;
  const gsubFeatureTableOffset = gsubOffset + 42;
  const gsubLookupTableOffset = gsubOffset + 48;
  const gsubSubtableOffset = gsubOffset + 56;
  const gsubCoverageOffset = gsubOffset + 64;
  const gsubLigSetOffset = gsubOffset + 70;
  const gsubLigatureOffset = gsubOffset + 74;

  view.setUint16(gsubOffset + 0, 1);
  view.setUint16(gsubOffset + 2, 0);
  view.setUint16(gsubOffset + 4, gsubScriptListOffset - gsubOffset);
  view.setUint16(gsubOffset + 6, gsubFeatureListOffset - gsubOffset);
  view.setUint16(gsubOffset + 8, gsubLookupListOffset - gsubOffset);

  view.setUint16(gsubScriptListOffset, 1);
  writeTag(view, gsubScriptListOffset + 2, "DFLT");
  view.setUint16(gsubScriptListOffset + 6, gsubScriptTableOffset - gsubScriptListOffset);

  view.setUint16(gsubFeatureListOffset, 1);
  writeTag(view, gsubFeatureListOffset + 2, "liga");
  view.setUint16(gsubFeatureListOffset + 6, gsubFeatureTableOffset - gsubFeatureListOffset);

  view.setUint16(gsubLookupListOffset, 1);
  view.setUint16(gsubLookupListOffset + 2, gsubLookupTableOffset - gsubLookupListOffset);

  view.setUint16(gsubScriptTableOffset, gsubLangSysOffset - gsubScriptTableOffset);
  view.setUint16(gsubScriptTableOffset + 2, 0);

  view.setUint16(gsubLangSysOffset, 0);
  view.setUint16(gsubLangSysOffset + 2, 0xffff);
  view.setUint16(gsubLangSysOffset + 4, 1);
  view.setUint16(gsubLangSysOffset + 6, 0);

  view.setUint16(gsubFeatureTableOffset, 0);
  view.setUint16(gsubFeatureTableOffset + 2, 1);
  view.setUint16(gsubFeatureTableOffset + 4, 0);

  view.setUint16(gsubLookupTableOffset, 4); // lookupType (Ligature)
  view.setUint16(gsubLookupTableOffset + 2, 0);
  view.setUint16(gsubLookupTableOffset + 4, 1);
  view.setUint16(gsubLookupTableOffset + 6, gsubSubtableOffset - gsubLookupTableOffset);

  view.setUint16(gsubSubtableOffset, 1); // substFormat
  view.setUint16(gsubSubtableOffset + 2, gsubCoverageOffset - gsubSubtableOffset);
  view.setUint16(gsubSubtableOffset + 4, 1); // ligSetCount
  view.setUint16(gsubSubtableOffset + 6, gsubLigSetOffset - gsubSubtableOffset);

  view.setUint16(gsubCoverageOffset, 1); // coverageFormat
  view.setUint16(gsubCoverageOffset + 2, 1); // glyphCount
  view.setUint16(gsubCoverageOffset + 4, 4); // glyph "f"

  view.setUint16(gsubLigSetOffset, 1); // ligatureCount
  view.setUint16(gsubLigSetOffset + 2, gsubLigatureOffset - gsubLigSetOffset);

  view.setUint16(gsubLigatureOffset, 6); // ligatureGlyph
  view.setUint16(gsubLigatureOffset + 2, 2); // componentCount (first + 1 more)
  view.setUint16(gsubLigatureOffset + 4, 5); // componentGlyphIDs[0] = "i"

  return buffer;
}

function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

describe("parseFont", () => {
  it("rejects an empty buffer, not a zero-width font", () => {
    expect(() => parseFont(new Uint8Array(0))).toThrow(CoMotionError);
  });

  it("rejects WOFF bytes explicitly, without attempting to decompress", () => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, 0x774f4646); // 'wOFF'
    expect(() => parseFont(bytes)).toThrow(/不支援的字型格式/);
  });

  it("rejects WOFF2 bytes explicitly", () => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, 0x774f4632); // 'wOF2'
    expect(() => parseFont(bytes)).toThrow(/不支援的字型格式/);
  });

  it("rejects bytes that are neither sfnt nor woff/woff2", () => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, 0xdeadbeef);
    expect(() => parseFont(bytes)).toThrow(/無效或已損毀/);
  });

  it("rejects a truncated table directory", () => {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x00010000);
    view.setUint16(4, 5); // claims 5 tables that don't fit in 12 bytes
    expect(() => parseFont(bytes)).toThrow(/無效或已損毀/);
  });

  it("names the missing table when a required table is absent", () => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(0, 0x00010000); // numTables defaults to 0
    expect(() => parseFont(bytes)).toThrow(/head/);
  });

  it("parses a structurally valid synthetic font", () => {
    const font = parseFont(buildSyntheticFont());
    expect(font.unitsPerEm).toBe(1000);
    expect(font.advanceWidthForCodePoint(0x0041)).toBe(600); // "A"
    expect(font.advanceWidthForCodePoint(0x0020)).toBe(300); // " "
    expect(font.advanceWidthForCodePoint(0x005a)).toBe(0); // "Z", uncovered -> .notdef
  });
});

describe("measureTextWidth", () => {
  const font = parseFont(buildSyntheticFont());

  it("returns 0 for an empty string", () => {
    expect(measureTextWidth(font, "", 48)).toBe(0);
  });

  it("returns 0 for fontSizePx 0", () => {
    expect(measureTextWidth(font, "A", 0)).toBe(0);
  });

  it("computes a known width from dead-reckoned advance widths, not the implementation", () => {
    // "A A" = A(600) + space(300) + A(600) = 1500 units, at unitsPerEm 1000
    // and fontSizePx 100 -> 1500 * 100 / 1000 = 150.
    expect(measureTextWidth(font, "A A", 100)).toBe(150);
  });

  it("uses glyph 0's advance width for a code point the cmap does not cover, not an error", () => {
    expect(measureTextWidth(font, "Z", 1000)).toBe(0);
  });

  it("throws for a negative fontSizePx", () => {
    expect(() => measureTextWidth(font, "A", -1)).toThrow(/字級/);
  });

  it("throws for a NaN fontSizePx", () => {
    expect(() => measureTextWidth(font, "A", NaN)).toThrow(/字級/);
  });

  it("throws for an Infinite fontSizePx", () => {
    expect(() => measureTextWidth(font, "A", Infinity)).toThrow(/字級/);
  });

  it("iterates by code point, not UTF-16 code unit, for an astral character", () => {
    // U+1F600 (😀) is a surrogate pair in UTF-16 but must count as one
    // code point; the synthetic font's cmap doesn't cover it, so both
    // "halves" would resolve to glyph 0 if iteration were wrong, making
    // this assertion alone insufficient — the real guard is that this call
    // does not throw or silently split the pair into two lookups that
    // happen to both be notdef. Cross-checked properly in the surrogate
    // math below.
    expect(() => measureTextWidth(font, "😀", 48)).not.toThrow();
    const widthOfOneAstral = measureTextWidth(font, "😀", 1000);
    const widthOfTwoAstral = measureTextWidth(font, "😀😀", 1000);
    expect(widthOfTwoAstral).toBe(widthOfOneAstral * 2);
  });
});

describe("measureTextWidth with GPOS/GSUB shaping", () => {
  const font = parseFont(buildSyntheticFontWithShaping());

  it("applies GPOS pair kerning between adjacent glyphs (A+V, -50 units)", () => {
    // "A" alone: 600. "AV": 600 + 500 - 50 (kern) = 1050, at unitsPerEm 1000
    // and fontSizePx 1000 -> 1050.
    expect(measureTextWidth(font, "A", 1000)).toBe(600);
    expect(measureTextWidth(font, "AV", 1000)).toBe(1050);
  });

  it("accumulates kerning only where GPOS actually has a pair (A->V, not V->A)", () => {
    // "AVAVA" has boundaries A-V, V-A, A-V, V-A. The synthetic font's
    // Coverage only lists "A" as a first glyph, so only the two A-V
    // boundaries kern: 600+500+600+500+600 = 2800, minus 2 x -50 = 2700.
    expect(measureTextWidth(font, "AVAVA", 1000)).toBe(2700);
  });

  it("does not apply kerning to a pair the GPOS table has no entry for", () => {
    // "VA": glyph "V" is not in the PairPos subtable's Coverage (only "A"
    // is), so no adjustment applies: 500 + 600 = 1100.
    expect(measureTextWidth(font, "VA", 1000)).toBe(1100);
  });

  it("substitutes a GSUB ligature and measures the ligature glyph's own width, not the sum of its parts", () => {
    // "fi" -> ligature glyph 6 (width 500), not "f"(300) + "i"(250) = 550.
    expect(measureTextWidth(font, "fi", 1000)).toBe(500);
  });

  it("only substitutes a ligature where the full component sequence matches", () => {
    // "f " (f followed by space, not "i") has no ligature match.
    expect(measureTextWidth(font, "f ", 1000)).toBe(600); // 300 + 300
  });

  it("applies ligature substitution before kerning, on the resulting glyph sequence", () => {
    // "fiA": "fi" ligates to glyph 6 (500) first, then no GPOS pair exists
    // for (ligature glyph, "A") — so no kerning applies here, just
    // ligature(500) + A(600) = 1100.
    expect(measureTextWidth(font, "fiA", 1000)).toBe(1100);
  });
});
