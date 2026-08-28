import { CoMotionError } from "./errors.js";

// Must never import a `node:` module: this file runs unmodified in both
// Node (packages/core) and the browser (imported by packages/web via the
// "@co-motion/core/text-metrics" subpath, see package.json's exports map),
// and it is the single implementation both sides share so a measured width
// is guaranteed identical on both ends (ADR: no second, independently
// drifting implementation).

/**
 * A parsed sfnt (TTF/OTF) font, reduced to exactly what text measurement
 * needs: glyph-id lookup by Unicode code point (cmap) and advance width by
 * glyph id (hmtx), scaled by unitsPerEm (head).
 *
 * Deliberately does not do glyph shaping (GSUB/GPOS/kerning/ligatures) — a
 * width is the sum of each code point's own advance width, nothing more.
 */
export interface FontMetrics {
  readonly unitsPerEm: number;
  /** Advance width in font units (not pixels) for one Unicode code point. */
  advanceWidthForCodePoint(codePoint: number): number;
}

const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_VERSION_TRUE = 0x74727565; // 'true'
const SFNT_TAG_OTTO = 0x4f54544f; // 'OTTO' (CFF-flavored OpenType)
const TAG_WOFF = 0x774f4646; // 'wOFF'
const TAG_WOFF2 = 0x774f4632; // 'wOF2'

interface TableRecord {
  offset: number;
  length: number;
}

/**
 * Parses raw sfnt bytes into a `FontMetrics`. Only reads the four tables
 * text measurement needs (`head`, `hhea`, `hmtx`, `cmap`) — never the whole
 * font. See the input/behavior table in the plan comment on this ticket for
 * the exact contract; summarized:
 *
 * - Empty or truncated input throws, never returns a zero-width font.
 * - WOFF/WOFF2 is explicitly rejected (not decompressed) — the container
 *   only ever holds sfnt (.ttf/.otf).
 * - A missing required table, or a cmap without a format 4 or 12 subtable,
 *   throws naming what's missing/unsupported.
 */
export function parseFont(bytes: Uint8Array): FontMetrics {
  if (bytes.length < 12) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sfntVersion = view.getUint32(0);
  if (sfntVersion === TAG_WOFF || sfntVersion === TAG_WOFF2) {
    throw new CoMotionError("不支援的字型格式，需要 TTF 或 OTF");
  }
  if (sfntVersion !== SFNT_VERSION_TRUETYPE && sfntVersion !== SFNT_VERSION_TRUE && sfntVersion !== SFNT_TAG_OTTO) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }

  const numTables = view.getUint16(4);
  const tables = new Map<string, TableRecord>();
  const directoryEnd = 12 + numTables * 16;
  if (directoryEnd > bytes.length) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  for (let i = 0; i < numTables; i++) {
    const recordOffset = 12 + i * 16;
    const tag = readTag(view, recordOffset);
    const offset = view.getUint32(recordOffset + 8);
    const length = view.getUint32(recordOffset + 12);
    if (offset + length > bytes.length) {
      throw new CoMotionError("字型檔案無效或已損毀");
    }
    tables.set(tag, { offset, length });
  }

  const head = requireTable(tables, "head");
  const hhea = requireTable(tables, "hhea");
  const hmtx = requireTable(tables, "hmtx");
  const cmap = requireTable(tables, "cmap");

  if (head.length < 20) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  const unitsPerEm = view.getUint16(head.offset + 18);

  if (hhea.length < 36) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  const numberOfHMetrics = view.getUint16(hhea.offset + 34);
  if (numberOfHMetrics === 0 || hmtx.length < numberOfHMetrics * 4) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }

  const glyphIdForCodePoint = parseCmap(view, cmap);

  function advanceWidthForGlyph(glyphId: number): number {
    const clampedIndex = Math.min(glyphId, numberOfHMetrics - 1);
    return view.getUint16(hmtx.offset + clampedIndex * 4);
  }

  return {
    unitsPerEm,
    advanceWidthForCodePoint(codePoint: number): number {
      return advanceWidthForGlyph(glyphIdForCodePoint(codePoint));
    },
  };
}

function requireTable(tables: Map<string, TableRecord>, tag: string): TableRecord {
  const table = tables.get(tag);
  if (!table) {
    throw new CoMotionError(`字型檔案缺少必要的資料表：${tag}`);
  }
  return table;
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/**
 * Picks a Unicode cmap subtable and returns a code-point-to-glyph-id lookup
 * function. Only format 4 (BMP) and format 12 (full Unicode) are supported —
 * anything else throws rather than silently falling back to glyph 0 for
 * every character.
 */
function parseCmap(view: DataView, cmap: TableRecord): (codePoint: number) => number {
  if (cmap.length < 4) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  const numSubtables = view.getUint16(cmap.offset + 2);
  if (4 + numSubtables * 8 > cmap.length) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }

  let format12Offset = -1;
  let format4Offset = -1;
  for (let i = 0; i < numSubtables; i++) {
    const recordOffset = cmap.offset + 4 + i * 8;
    const platformId = view.getUint16(recordOffset);
    const encodingId = view.getUint16(recordOffset + 2);
    const subtableOffset = cmap.offset + view.getUint32(recordOffset + 4);
    const isUnicodePlatform = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!isUnicodePlatform || subtableOffset + 2 > view.byteLength) {
      continue;
    }
    const format = view.getUint16(subtableOffset);
    if (format === 12) {
      format12Offset = subtableOffset;
    } else if (format === 4 && format4Offset === -1) {
      format4Offset = subtableOffset;
    }
  }

  if (format12Offset !== -1) {
    return buildFormat12Lookup(view, format12Offset);
  }
  if (format4Offset !== -1) {
    return buildFormat4Lookup(view, format4Offset);
  }
  throw new CoMotionError("字型的 cmap 格式不支援");
}

function buildFormat12Lookup(view: DataView, offset: number): (codePoint: number) => number {
  if (offset + 16 > view.byteLength) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  const numGroups = view.getUint32(offset + 12);
  const groupsStart = offset + 16;
  if (groupsStart + numGroups * 12 > view.byteLength) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  return (codePoint: number): number => {
    for (let i = 0; i < numGroups; i++) {
      const groupOffset = groupsStart + i * 12;
      const startCharCode = view.getUint32(groupOffset);
      const endCharCode = view.getUint32(groupOffset + 4);
      if (codePoint >= startCharCode && codePoint <= endCharCode) {
        const startGlyphId = view.getUint32(groupOffset + 8);
        return startGlyphId + (codePoint - startCharCode);
      }
    }
    return 0;
  };
}

function buildFormat4Lookup(view: DataView, offset: number): (codePoint: number) => number {
  if (offset + 14 > view.byteLength) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }
  const segCountX2 = view.getUint16(offset + 6);
  const segCount = segCountX2 / 2;
  const endCodesStart = offset + 14;
  const startCodesStart = endCodesStart + segCountX2 + 2; // +2 skips reservedPad
  const idDeltasStart = startCodesStart + segCountX2;
  const idRangeOffsetsStart = idDeltasStart + segCountX2;
  if (idRangeOffsetsStart + segCountX2 > view.byteLength) {
    throw new CoMotionError("字型檔案無效或已損毀");
  }

  return (codePoint: number): number => {
    if (codePoint > 0xffff) {
      // Format 4 only maps the Basic Multilingual Plane; an astral code
      // point is, by definition, not covered by this subtable.
      return 0;
    }
    for (let i = 0; i < segCount; i++) {
      const endCode = view.getUint16(endCodesStart + i * 2);
      if (codePoint > endCode) {
        continue;
      }
      const startCode = view.getUint16(startCodesStart + i * 2);
      if (codePoint < startCode) {
        return 0;
      }
      const idDelta = view.getInt16(idDeltasStart + i * 2);
      const idRangeOffset = view.getUint16(idRangeOffsetsStart + i * 2);
      if (idRangeOffset === 0) {
        return (codePoint + idDelta) & 0xffff;
      }
      const glyphIndexAddress = idRangeOffsetsStart + i * 2 + idRangeOffset + (codePoint - startCode) * 2;
      if (glyphIndexAddress + 2 > view.byteLength) {
        throw new CoMotionError("字型檔案無效或已損毀");
      }
      const glyphId = view.getUint16(glyphIndexAddress);
      return glyphId === 0 ? 0 : (glyphId + idDelta) & 0xffff;
    }
    return 0;
  };
}

/**
 * Measures the rendered width, in pixels, of `text` at `fontSizePx` using
 * `font`. Sums integer font-unit advance widths first and converts to
 * pixels once at the end (`sumUnits * fontSizePx / unitsPerEm`) — never per
 * character — so Node and browser callers reach the exact same
 * floating-point result for the same input.
 */
export function measureTextWidth(font: FontMetrics, text: string, fontSizePx: number): number {
  if (typeof fontSizePx !== "number" || Number.isNaN(fontSizePx) || !Number.isFinite(fontSizePx) || fontSizePx < 0) {
    throw new CoMotionError("字級必須是非負的有限數");
  }
  if (text === "" || fontSizePx === 0) {
    return 0;
  }
  let sumUnits = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    sumUnits += font.advanceWidthForCodePoint(codePoint);
  }
  return (sumUnits * fontSizePx) / font.unitsPerEm;
}
