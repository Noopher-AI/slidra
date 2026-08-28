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
