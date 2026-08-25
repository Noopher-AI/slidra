import { CoMotionError } from "../errors.js";

/**
 * Text measurement read straight out of a bundled sfnt (`.ttf` / `.otf`).
 *
 * This file must never import a `node:` module: the same measurement has to
 * run in the browser (Vite bundles it) and in the CLI, and #70 requires that
 * there is exactly one implementation of it. Reading files is bundle.ts's
 * job.
 */

/** Metadata of one bundled face. Lengths are font units, not px. */
export interface FontFaceInfo {
  /** name table ID 16 (typographic family), falling back to ID 1. */
  readonly family: string;
  /** OS/2 usWeightClass. */
  readonly weight: number;
  /** head.unitsPerEm. */
  readonly unitsPerEm: number;
  /** hhea.ascender, font units, positive. */
  readonly ascender: number;
  /** hhea.descender, font units, negative. */
  readonly descender: number;
  /** hhea.lineGap, font units. */
  readonly lineGap: number;
}

export interface TextStyle {
  /** A single family name, never a CSS font-family list. */
  readonly fontFamily: string;
  /** User units (SVG px). Must be a finite number greater than 0; decimals are legal. */
  readonly fontSize: number;
  /** OS/2 usWeightClass. Defaults to 400. */
  readonly fontWeight?: number;
}

export interface FontBook {
  readonly faces: readonly FontFaceInfo[];
  /** Resolves the face a style names; throws CoMotionError when there is none. */
  faceFor(style: Pick<TextStyle, "fontFamily" | "fontWeight">): FontFaceInfo;
  /** Advance width of this text at this style, in user units (SVG px), unrounded. */
  measureText(text: string, style: TextStyle): number;
  /** Advance width of a single code point, same units — so line breaking can accumulate in O(n). */
  advanceOf(codePoint: number, style: TextStyle): number;
}

/**
 * The rendering contract: any text that has to agree with `measureText`
 * must be rendered carrying this CSS. Each property switches off one
 * browser behaviour that `measureText` deliberately does not model
 * (kerning, ligatures, CJK punctuation trimming).
 */
export const MEASURED_TEXT_CSS =
  "font-kerning:none;font-variant-ligatures:none;text-spacing-trim:space-all";

interface TableRecord {
  readonly offset: number;
  readonly length: number;
}

function readTableDirectory(view: DataView): Map<string, TableRecord> {
  if (view.byteLength < 12) {
    throw new CoMotionError("字型檔已損毀：檔案太短，讀不到表目錄");
  }
  const sfntVersion = view.getUint32(0);
  // 0x00010000 = TrueType outlines, 0x4F54544F = "OTTO" (CFF outlines).
  if (sfntVersion !== 0x00010000 && sfntVersion !== 0x4f54544f) {
    throw new CoMotionError("字型檔已損毀：不是可辨識的字型格式");
  }
  const numTables = view.getUint16(4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > view.byteLength) {
      throw new CoMotionError("字型檔已損毀：表目錄超出檔案範圍");
    }
    let tag = "";
    for (let b = 0; b < 4; b += 1) {
      tag += String.fromCharCode(view.getUint8(record + b));
    }
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > view.byteLength) {
      throw new CoMotionError(`字型檔已損毀：表「${tag}」超出檔案範圍`);
    }
    tables.set(tag, { offset, length });
  }
  return tables;
}

function requireTable(tables: Map<string, TableRecord>, tag: string): TableRecord {
  const table = tables.get(tag);
  if (!table) {
    throw new CoMotionError(`字型檔已損毀：缺少必要的表「${tag}」`);
  }
  return table;
}

/** name table string, platformID 3 (Windows) / languageID 0x409 (en-US), UTF-16BE. */
function readNameId(view: DataView, name: TableRecord, nameId: number): string | undefined {
  const count = view.getUint16(name.offset + 2);
  const storage = name.offset + view.getUint16(name.offset + 4);
  for (let i = 0; i < count; i += 1) {
    const record = name.offset + 6 + i * 12;
    const platformId = view.getUint16(record);
    const languageId = view.getUint16(record + 4);
    if (platformId !== 3 || languageId !== 0x409 || view.getUint16(record + 6) !== nameId) {
      continue;
    }
    const length = view.getUint16(record + 8);
    const offset = storage + view.getUint16(record + 10);
    let text = "";
    for (let b = 0; b + 1 < length; b += 2) {
      text += String.fromCharCode(view.getUint16(offset + b));
    }
    return text;
  }
  return undefined;
}

function readFaceInfo(view: DataView, tables: Map<string, TableRecord>): FontFaceInfo {
  const head = requireTable(tables, "head");
  const hhea = requireTable(tables, "hhea");
  const os2 = requireTable(tables, "OS/2");
  const name = requireTable(tables, "name");

  const family = readNameId(view, name, 16) ?? readNameId(view, name, 1);
  if (family === undefined || family.trim() === "") {
    throw new CoMotionError("字型檔已損毀：讀不到字型名稱");
  }

  return {
    family,
    weight: view.getUint16(os2.offset + 4),
    unitsPerEm: view.getUint16(head.offset + 18),
    ascender: view.getInt16(hhea.offset + 4),
    descender: view.getInt16(hhea.offset + 6),
    lineGap: view.getInt16(hhea.offset + 8),
  };
}

// --- cmap -------------------------------------------------------------

type GlyphLookup = (codePoint: number) => number;

/**
 * Resolves code points to glyph ids. Only the two subtables this project's
 * fonts actually carry are supported: Windows/UCS-4 format 12 (preferred —
 * the only one that reaches beyond the BMP) and Windows/BMP format 4. A
 * font with neither is an explicit error; guessing at a Mac or symbol
 * subtable would be a fallback.
 */
function readCmap(view: DataView, cmap: TableRecord): GlyphLookup {
  const numTables = view.getUint16(cmap.offset + 2);
  let format12 = -1;
  let format4 = -1;
  for (let i = 0; i < numTables; i += 1) {
    const record = cmap.offset + 4 + i * 8;
    const platformId = view.getUint16(record);
    const encodingId = view.getUint16(record + 2);
    const subtable = cmap.offset + view.getUint32(record + 4);
    if (platformId === 3 && encodingId === 10 && view.getUint16(subtable) === 12) {
      format12 = subtable;
    } else if (platformId === 3 && encodingId === 1 && view.getUint16(subtable) === 4) {
      format4 = subtable;
    }
  }
  if (format12 >= 0) {
    return makeFormat12Lookup(view, format12);
  }
  if (format4 >= 0) {
    return makeFormat4Lookup(view, format4);
  }
  throw new CoMotionError("字型檔已損毀：找不到可用的字元對應表（cmap）");
}

function makeFormat12Lookup(view: DataView, subtable: number): GlyphLookup {
  const numGroups = view.getUint32(subtable + 12);
  // Groups are sorted by startCharCode, so a binary search avoids expanding
  // the whole table — this font has 20,710 glyphs, more characters than a
  // whole deck contains.
  return (codePoint) => {
    let low = 0;
    let high = numGroups - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const group = subtable + 16 + mid * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      if (codePoint < start) {
        high = mid - 1;
      } else if (codePoint > end) {
        low = mid + 1;
      } else {
        return view.getUint32(group + 8) + (codePoint - start);
      }
    }
    return 0;
  };
}

function makeFormat4Lookup(view: DataView, subtable: number): GlyphLookup {
  const segCount = view.getUint16(subtable + 6) / 2;
  const endCodes = subtable + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  return (codePoint) => {
    if (codePoint > 0xffff) {
      return 0;
    }
    for (let seg = 0; seg < segCount; seg += 1) {
      if (view.getUint16(endCodes + seg * 2) < codePoint) {
        continue;
      }
      if (view.getUint16(startCodes + seg * 2) > codePoint) {
        return 0;
      }
      const rangeOffset = view.getUint16(idRangeOffsets + seg * 2);
      if (rangeOffset === 0) {
        return (codePoint + view.getInt16(idDeltas + seg * 2)) & 0xffff;
      }
      const start = view.getUint16(startCodes + seg * 2);
      const glyphAddress = idRangeOffsets + seg * 2 + rangeOffset + (codePoint - start) * 2;
      const glyph = view.getUint16(glyphAddress);
      return glyph === 0 ? 0 : (glyph + view.getInt16(idDeltas + seg * 2)) & 0xffff;
    }
    return 0;
  };
}

// --- text validation --------------------------------------------------

// Characters whose rendered width provably disagrees between this
// measurement and a browser, because the browser applies its own layout to
// them: tab stops, bidi controls, and mark attachment via ccmp/GPOS, which
// no CSS property can switch off. Measuring them would produce a number
// that is silently wrong, so they are rejected instead (no fallbacks).
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/u;
const VARIATION_SELECTORS = /[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/u;
const FORMAT_CHARS = /\p{Cf}/u;
const COMBINING_MARKS = /\p{Mn}|\p{Mc}|\p{Me}/u;

function assertMeasurable(text: string): void {
  if (CONTROL_CHARS.test(text)) {
    throw new CoMotionError("文字不可包含控制字元");
  }
  // Checked before the general mark test: variation selectors are Mn too,
  // and "unsupported variation selector" says far more than "combining
  // mark" to whoever has to fix the text.
  if (VARIATION_SELECTORS.test(text)) {
    throw new CoMotionError("不支援變體選擇符");
  }
  if (FORMAT_CHARS.test(text)) {
    throw new CoMotionError("文字不可包含零寬或格式字元");
  }
  if (COMBINING_MARKS.test(text)) {
    throw new CoMotionError("不支援組合字元，請改用預組合字元");
  }
}

function assertFontSize(fontSize: number): void {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new CoMotionError("字級必須是大於 0 的數字");
  }
}

/**
 * A CSS font-family list means "if you cannot measure it, use the next
 * one" — exactly the behaviour this ticket exists to eliminate. Only a
 * single family name is accepted; matching is trim + ASCII case-insensitive
 * as CSS family names are.
 */
function normaliseFamily(fontFamily: string): string {
  if (/["',]/.test(fontFamily)) {
    throw new CoMotionError("字型名稱不可以是清單");
  }
  return fontFamily.trim().toLowerCase();
}

function formatCodePoint(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
  return `${String.fromCodePoint(codePoint)} (U+${hex})`;
}

interface LoadedFace {
  readonly info: FontFaceInfo;
  /** Advance in font units, or undefined when the font has no glyph for it. */
  advanceUnits(codePoint: number): number | undefined;
}

function loadFace(bytes: Uint8Array): LoadedFace {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = readTableDirectory(view);
  const info = readFaceInfo(view, tables);
  const hhea = requireTable(tables, "hhea");
  const hmtx = requireTable(tables, "hmtx");
  const numberOfHMetrics = view.getUint16(hhea.offset + 34);
  const glyphFor = readCmap(view, requireTable(tables, "cmap"));
  const cache = new Map<number, number | undefined>();

  return {
    info,
    advanceUnits(codePoint) {
      if (cache.has(codePoint)) {
        return cache.get(codePoint);
      }
      const glyph = glyphFor(codePoint);
      // Glyph 0 is .notdef: the font has no such character. That is
      // reported as missing, never measured as a tofu box.
      const advance =
        glyph === 0
          ? undefined
          : view.getUint16(hmtx.offset + Math.min(glyph, numberOfHMetrics - 1) * 4);
      cache.set(codePoint, advance);
      return advance;
    },
  };
}

/** Builds a font book from a set of sfnt byte arrays. */
export function createFontBook(fonts: readonly Uint8Array[]): FontBook {
  const loaded = fonts.map(loadFace);
  const byKey = new Map<string, LoadedFace>();
  for (const face of loaded) {
    const key = `${face.info.family.trim().toLowerCase()}/${face.info.weight}`;
    if (byKey.has(key)) {
      throw new CoMotionError(
        `打包了兩份相同的字型「${face.info.family}」字重 ${face.info.weight}，無法決定用哪一份`,
      );
    }
    byKey.set(key, face);
  }

  function resolve(style: Pick<TextStyle, "fontFamily" | "fontWeight">): LoadedFace {
    if (loaded.length === 0) {
      throw new CoMotionError("這份簡報沒有打包字型");
    }
    const family = normaliseFamily(style.fontFamily);
    const weight = style.fontWeight ?? 400;
    const exact = byKey.get(`${family}/${weight}`);
    if (exact) {
      return exact;
    }
    const sameFamily = loaded.filter((face) => face.info.family.trim().toLowerCase() === family);
    if (sameFamily.length === 0) {
      const available = loaded.map((face) => face.info.family).join("、");
      throw new CoMotionError(`這份簡報沒有打包字型「${style.fontFamily}」；已打包：${available}`);
    }
    const weights = sameFamily.map((face) => face.info.weight).join("、");
    throw new CoMotionError(
      `這份簡報沒有打包字重 ${weight} 的「${sameFamily[0].info.family}」；可用字重：${weights}`,
    );
  }

  function advanceUnits(face: LoadedFace, codePoints: readonly number[]): number {
    let units = 0;
    const missing: number[] = [];
    for (const codePoint of codePoints) {
      const advance = face.advanceUnits(codePoint);
      if (advance === undefined) {
        if (!missing.includes(codePoint)) {
          missing.push(codePoint);
        }
        continue;
      }
      units += advance;
    }
    if (missing.length > 0) {
      throw new CoMotionError(
        `字型「${face.info.family}」不支援下列字元：${missing.map(formatCodePoint).join("、")}`,
      );
    }
    return units;
  }

  return {
    faces: loaded.map((face) => face.info),

    faceFor(style) {
      return resolve(style).info;
    },

    measureText(text, style) {
      const face = resolve(style);
      assertFontSize(style.fontSize);
      assertMeasurable(text);
      // Iterating the string yields whole code points, so surrogate pairs
      // need no special case.
      const codePoints = Array.from(text, (ch) => ch.codePointAt(0) as number);
      return (advanceUnits(face, codePoints) * style.fontSize) / face.info.unitsPerEm;
    },

    advanceOf(codePoint, style) {
      const face = resolve(style);
      assertFontSize(style.fontSize);
      assertMeasurable(String.fromCodePoint(codePoint));
      return (advanceUnits(face, [codePoint]) * style.fontSize) / face.info.unitsPerEm;
    },
  };
}
