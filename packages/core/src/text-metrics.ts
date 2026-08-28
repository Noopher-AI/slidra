import { CoMotionError } from "./errors.js";

// Must never import a `node:` module: this file runs unmodified in both
// Node (packages/core) and the browser (imported by packages/web via the
// "@co-motion/core/text-metrics" subpath, see package.json's exports map),
// and it is the single implementation both sides share so a measured width
// is guaranteed identical on both ends (ADR: no second, independently
// drifting implementation).

/**
 * A parsed sfnt (TTF/OTF) font, reduced to exactly what text measurement
 * needs: glyph-id lookup by Unicode code point (cmap), advance width by
 * glyph id (hmtx) scaled by unitsPerEm (head), and the two shaping steps
 * that change a run's total advance versus summing isolated glyph widths —
 * GSUB ligature substitution and GPOS pair kerning — so a measured width
 * matches what a real text-shaping engine (e.g. Chromium/HarfBuzz) renders,
 * not just the sum of each character's own advance width.
 */
export interface FontMetrics {
  readonly unitsPerEm: number;
  /** hhea.ascender, font units, positive. */
  readonly ascender: number;
  /** hhea.descender, font units, negative. */
  readonly descender: number;
  /** hhea.lineGap, font units. */
  readonly lineGap: number;
  /** Advance width in font units (not pixels) for one Unicode code point. */
  advanceWidthForCodePoint(codePoint: number): number;
  /** Glyph id for a Unicode code point via cmap; 0 (.notdef) if uncovered. */
  glyphIdForCodePoint(codePoint: number): number;
  /** Advance width in font units for a glyph id (hmtx). */
  advanceWidthForGlyph(glyphId: number): number;
  /**
   * Applies GSUB ligature substitution (lookup type 4, 'liga'/'rlig'
   * features) to a glyph id sequence, returning the possibly-shorter
   * substituted sequence. A font with no GSUB table, or none of these
   * features, returns `glyphIds` unchanged.
   */
  substituteLigatures(glyphIds: number[]): number[];
  /**
   * GPOS pair-adjustment kerning (lookup type 2, 'kern' feature) between two
   * adjacent glyphs, as a font-unit xAdvance delta applied between them (0 if
   * the font has no GPOS table, no 'kern' feature, or no pair for this
   * combination).
   */
  pairKerning(glyphA: number, glyphB: number): number;
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
  // hhea's ascender/descender/lineGap (FWord, signed, offsets 4/6/8) — the
  // line-metrics half of text measurement (line height, baseline position),
  // as opposed to advance widths. hhea.length >= 36 is already guaranteed
  // above, so these three reads are always in-bounds for any font that
  // passed the checks so far.
  const ascender = view.getInt16(hhea.offset + 4);
  const descender = view.getInt16(hhea.offset + 6);
  const lineGap = view.getInt16(hhea.offset + 8);

  const glyphIdForCodePoint = parseCmap(view, cmap);

  function advanceWidthForGlyph(glyphId: number): number {
    const clampedIndex = Math.min(glyphId, numberOfHMetrics - 1);
    return view.getUint16(hmtx.offset + clampedIndex * 4);
  }

  const gsub = tables.get("GSUB");
  const ligatureMap = gsub ? parseLigatureMap(view, gsub) : new Map<number, LigatureRule[]>();

  const gpos = tables.get("GPOS");
  const pairKerning = gpos ? parsePairKerning(view, gpos) : (): number => 0;

  return {
    unitsPerEm,
    ascender,
    descender,
    lineGap,
    advanceWidthForCodePoint(codePoint: number): number {
      return advanceWidthForGlyph(glyphIdForCodePoint(codePoint));
    },
    glyphIdForCodePoint,
    advanceWidthForGlyph,
    substituteLigatures(glyphIds: number[]): number[] {
      return applyLigatures(glyphIds, ligatureMap);
    },
    pairKerning,
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

// --- GSUB/GPOS shared layout structures (OpenType "Common Table Formats") ---
//
// GSUB and GPOS headers, ScriptList/FeatureList/LookupList, Coverage, and
// ClassDef all share the same binary shape regardless of which of the two
// tables they appear in — the helpers below serve both.

/** Parses a Coverage table into glyph id -> coverage index. */
function parseCoverage(view: DataView, offset: number): Map<number, number> {
  const format = view.getUint16(offset);
  const map = new Map<number, number>();
  if (format === 1) {
    const glyphCount = view.getUint16(offset + 2);
    for (let i = 0; i < glyphCount; i++) {
      map.set(view.getUint16(offset + 4 + i * 2), i);
    }
  } else if (format === 2) {
    const rangeCount = view.getUint16(offset + 2);
    for (let i = 0; i < rangeCount; i++) {
      const rangeOffset = offset + 4 + i * 6;
      const startGlyph = view.getUint16(rangeOffset);
      const endGlyph = view.getUint16(rangeOffset + 2);
      const startCoverageIndex = view.getUint16(rangeOffset + 4);
      for (let glyph = startGlyph; glyph <= endGlyph; glyph++) {
        map.set(glyph, startCoverageIndex + (glyph - startGlyph));
      }
    }
  } else {
    throw new CoMotionError(`不支援的 Coverage 格式：${format}`);
  }
  return map;
}

/** Parses a ClassDef table into glyph id -> class (glyphs not listed are class 0). */
function parseClassDef(view: DataView, offset: number): Map<number, number> {
  const format = view.getUint16(offset);
  const map = new Map<number, number>();
  if (format === 1) {
    const startGlyph = view.getUint16(offset + 2);
    const glyphCount = view.getUint16(offset + 4);
    for (let i = 0; i < glyphCount; i++) {
      const classValue = view.getUint16(offset + 6 + i * 2);
      if (classValue !== 0) map.set(startGlyph + i, classValue);
    }
  } else if (format === 2) {
    const rangeCount = view.getUint16(offset + 2);
    for (let i = 0; i < rangeCount; i++) {
      const rangeOffset = offset + 4 + i * 6;
      const startGlyph = view.getUint16(rangeOffset);
      const endGlyph = view.getUint16(rangeOffset + 2);
      const classValue = view.getUint16(rangeOffset + 4);
      if (classValue !== 0) {
        for (let glyph = startGlyph; glyph <= endGlyph; glyph++) map.set(glyph, classValue);
      }
    }
  } else {
    throw new CoMotionError(`不支援的 ClassDef 格式：${format}`);
  }
  return map;
}

/** Byte size, in a ValueRecord, of the fields `valueFormat`'s bits select. */
function valueRecordSize(valueFormat: number): number {
  let fieldCount = 0;
  for (let bit = 0x0001; bit <= 0x0080; bit <<= 1) {
    if (valueFormat & bit) fieldCount++;
  }
  return fieldCount * 2;
}

/**
 * Reads a ValueRecord at `offset`, extracting only XAdvance (the sole field
 * that changes a run's total horizontal advance — XPlacement/YPlacement/
 * YAdvance/device tables affect glyph position or vertical text, not the
 * width `measureTextWidth` reports). Returns the record's total byte size so
 * callers can advance past it regardless of which fields are present.
 */
function readValueRecordXAdvance(view: DataView, offset: number, valueFormat: number): { xAdvance: number; size: number } {
  let cursor = offset;
  let xAdvance = 0;
  if (valueFormat & 0x0001) cursor += 2; // XPlacement
  if (valueFormat & 0x0002) cursor += 2; // YPlacement
  if (valueFormat & 0x0004) {
    xAdvance = view.getInt16(cursor);
    cursor += 2;
  }
  if (valueFormat & 0x0008) cursor += 2; // YAdvance
  if (valueFormat & 0x0010) cursor += 2; // XPlaDevice
  if (valueFormat & 0x0020) cursor += 2; // YPlaDevice
  if (valueFormat & 0x0040) cursor += 2; // XAdvDevice
  if (valueFormat & 0x0080) cursor += 2; // YAdvDevice
  return { xAdvance, size: cursor - offset };
}

/**
 * Resolves the lookup indices a GSUB/GPOS table's `wantedTags` features
 * activate, for whichever of "latn"/"hani"/"DFLT"/first-listed script the
 * font declares. Real documents mix scripts per run; this measures a whole
 * string with one script's feature set, the same simplification the rest of
 * this module makes by never doing per-run script segmentation — good
 * enough for the CJK+Latin mixes ticket #71 targets, not full ICU-grade
 * shaping.
 */
function resolveLookupIndices(view: DataView, tableOffset: number, wantedTags: readonly string[]): number[] {
  const scriptListOffset = tableOffset + view.getUint16(tableOffset + 4);
  const featureListOffset = tableOffset + view.getUint16(tableOffset + 6);
  const lookupListOffset = tableOffset + view.getUint16(tableOffset + 8);

  const scriptCount = view.getUint16(scriptListOffset);
  let chosenScriptOffset = -1;
  let fallbackScriptOffset = -1;
  const PREFERRED_SCRIPT_TAGS = ["latn", "hani", "DFLT"];
  let bestPreferenceRank = PREFERRED_SCRIPT_TAGS.length;
  for (let i = 0; i < scriptCount; i++) {
    const recordOffset = scriptListOffset + 2 + i * 6;
    const tag = readTag(view, recordOffset);
    const scriptOffset = scriptListOffset + view.getUint16(recordOffset + 4);
    if (fallbackScriptOffset === -1) fallbackScriptOffset = scriptOffset;
    const rank = PREFERRED_SCRIPT_TAGS.indexOf(tag);
    if (rank !== -1 && rank < bestPreferenceRank) {
      bestPreferenceRank = rank;
      chosenScriptOffset = scriptOffset;
    }
  }
  const scriptOffset = chosenScriptOffset !== -1 ? chosenScriptOffset : fallbackScriptOffset;
  if (scriptOffset === -1) return [];

  const defaultLangSysOffset = view.getUint16(scriptOffset);
  const langSysCount = view.getUint16(scriptOffset + 2);
  let langSysOffset = -1;
  if (defaultLangSysOffset !== 0) {
    langSysOffset = scriptOffset + defaultLangSysOffset;
  } else if (langSysCount > 0) {
    langSysOffset = scriptOffset + view.getUint16(scriptOffset + 4 + 4);
  }
  if (langSysOffset === -1) return [];

  const featureIndexCount = view.getUint16(langSysOffset + 4);
  const featureIndices: number[] = [];
  for (let i = 0; i < featureIndexCount; i++) {
    featureIndices.push(view.getUint16(langSysOffset + 6 + i * 2));
  }

  const featureCount = view.getUint16(featureListOffset);
  const lookupIndices: number[] = [];
  for (const featureIndex of featureIndices) {
    if (featureIndex >= featureCount) continue;
    const recordOffset = featureListOffset + 2 + featureIndex * 6;
    const tag = readTag(view, recordOffset);
    if (!wantedTags.includes(tag)) continue;
    const featureOffset = featureListOffset + view.getUint16(recordOffset + 4);
    const lookupIndexCount = view.getUint16(featureOffset + 2);
    for (let i = 0; i < lookupIndexCount; i++) {
      lookupIndices.push(view.getUint16(featureOffset + 4 + i * 2));
    }
  }

  return lookupIndices.map((lookupIndex) => lookupListOffset + view.getUint16(lookupListOffset + 2 + lookupIndex * 2));
}

interface LigatureRule {
  /** Components after the coverage (first) glyph, in match order. */
  componentGlyphs: number[];
  ligatureGlyph: number;
}

/** Builds first-glyph -> candidate ligatures from every 'liga'/'rlig' GSUB lookup's ligature (type 4) subtables. */
function parseLigatureMap(view: DataView, gsub: TableRecord): Map<number, LigatureRule[]> {
  const map = new Map<number, LigatureRule[]>();
  const lookupOffsets = resolveLookupIndices(view, gsub.offset, ["liga", "rlig"]);
  for (const lookupOffset of lookupOffsets) {
    const lookupType = view.getUint16(lookupOffset);
    if (lookupType !== 4) continue;
    const subTableCount = view.getUint16(lookupOffset + 4);
    for (let s = 0; s < subTableCount; s++) {
      const subtableOffset = lookupOffset + view.getUint16(lookupOffset + 6 + s * 2);
      const coverageOffset = subtableOffset + view.getUint16(subtableOffset + 2);
      const coverage = parseCoverage(view, coverageOffset);
      const ligSetCount = view.getUint16(subtableOffset + 4);
      for (const [firstGlyph, coverageIndex] of coverage) {
        if (coverageIndex >= ligSetCount) continue;
        const ligSetOffset = subtableOffset + view.getUint16(subtableOffset + 6 + coverageIndex * 2);
        const ligatureCount = view.getUint16(ligSetOffset);
        const rules: LigatureRule[] = [];
        for (let l = 0; l < ligatureCount; l++) {
          const ligOffset = ligSetOffset + view.getUint16(ligSetOffset + 2 + l * 2);
          const ligatureGlyph = view.getUint16(ligOffset);
          const componentCount = view.getUint16(ligOffset + 2);
          const componentGlyphs: number[] = [];
          for (let c = 0; c < componentCount - 1; c++) {
            componentGlyphs.push(view.getUint16(ligOffset + 4 + c * 2));
          }
          rules.push({ componentGlyphs, ligatureGlyph });
        }
        if (!map.has(firstGlyph)) map.set(firstGlyph, rules);
      }
    }
  }
  return map;
}

/** Left-to-right, longest-rule-first (as listed) ligature substitution over a glyph id sequence. */
function applyLigatures(glyphIds: number[], ligatureMap: Map<number, LigatureRule[]>): number[] {
  if (ligatureMap.size === 0) return glyphIds;
  const result: number[] = [];
  let i = 0;
  while (i < glyphIds.length) {
    const rules = ligatureMap.get(glyphIds[i]);
    let matchedRule: LigatureRule | undefined;
    if (rules) {
      for (const rule of rules) {
        const end = i + 1 + rule.componentGlyphs.length;
        if (end > glyphIds.length) continue;
        if (rule.componentGlyphs.every((glyph, offset) => glyphIds[i + 1 + offset] === glyph)) {
          matchedRule = rule;
          break;
        }
      }
    }
    if (matchedRule) {
      result.push(matchedRule.ligatureGlyph);
      i += 1 + matchedRule.componentGlyphs.length;
    } else {
      result.push(glyphIds[i]);
      i += 1;
    }
  }
  return result;
}

type PairKerningFn = (glyphA: number, glyphB: number) => number;

/** Builds a glyph-pair -> xAdvance-delta function from every 'kern' GPOS lookup's pair-adjustment (type 2) subtables. */
function parsePairKerning(view: DataView, gpos: TableRecord): PairKerningFn {
  const lookupOffsets = resolveLookupIndices(view, gpos.offset, ["kern"]);
  const subtableParsers: PairKerningFn[] = [];
  for (const lookupOffset of lookupOffsets) {
    const lookupType = view.getUint16(lookupOffset);
    if (lookupType !== 2) continue;
    const subTableCount = view.getUint16(lookupOffset + 4);
    for (let s = 0; s < subTableCount; s++) {
      const subtableOffset = lookupOffset + view.getUint16(lookupOffset + 6 + s * 2);
      subtableParsers.push(parsePairPosSubtable(view, subtableOffset));
    }
  }
  if (subtableParsers.length === 0) return () => 0;
  return (glyphA, glyphB) => {
    for (const parser of subtableParsers) {
      const delta = parser(glyphA, glyphB);
      if (delta !== 0) return delta;
    }
    return 0;
  };
}

function parsePairPosSubtable(view: DataView, subtableOffset: number): PairKerningFn {
  const format = view.getUint16(subtableOffset);
  const coverageOffset = subtableOffset + view.getUint16(subtableOffset + 2);
  const valueFormat1 = view.getUint16(subtableOffset + 4);
  const valueFormat2 = view.getUint16(subtableOffset + 6);
  const coverage = parseCoverage(view, coverageOffset);
  const value1Size = valueRecordSize(valueFormat1);
  const value2Size = valueRecordSize(valueFormat2);

  if (format === 1) {
    const pairSetCount = view.getUint16(subtableOffset + 8);
    const pairSetOffsets: number[] = [];
    for (let i = 0; i < pairSetCount; i++) pairSetOffsets.push(subtableOffset + view.getUint16(subtableOffset + 10 + i * 2));
    return (glyphA, glyphB) => {
      const coverageIndex = coverage.get(glyphA);
      if (coverageIndex === undefined || coverageIndex >= pairSetOffsets.length) return 0;
      const pairSetOffset = pairSetOffsets[coverageIndex];
      const pairValueCount = view.getUint16(pairSetOffset);
      let cursor = pairSetOffset + 2;
      for (let i = 0; i < pairValueCount; i++) {
        const secondGlyph = view.getUint16(cursor);
        cursor += 2;
        const value1 = readValueRecordXAdvance(view, cursor, valueFormat1);
        cursor += value1Size;
        const value2 = readValueRecordXAdvance(view, cursor, valueFormat2);
        cursor += value2Size;
        if (secondGlyph === glyphB) return value1.xAdvance + value2.xAdvance;
      }
      return 0;
    };
  }

  if (format === 2) {
    const classDef1Offset = subtableOffset + view.getUint16(subtableOffset + 8);
    const classDef2Offset = subtableOffset + view.getUint16(subtableOffset + 10);
    const class1Count = view.getUint16(subtableOffset + 12);
    const class2Count = view.getUint16(subtableOffset + 14);
    const classDef1 = parseClassDef(view, classDef1Offset);
    const classDef2 = parseClassDef(view, classDef2Offset);
    const classRecordsStart = subtableOffset + 16;
    const recordSize = value1Size + value2Size;
    return (glyphA, glyphB) => {
      if (!coverage.has(glyphA)) return 0;
      const class1 = classDef1.get(glyphA) ?? 0;
      const class2 = classDef2.get(glyphB) ?? 0;
      if (class1 >= class1Count || class2 >= class2Count) return 0;
      const recordOffset = classRecordsStart + (class1 * class2Count + class2) * recordSize;
      const value1 = readValueRecordXAdvance(view, recordOffset, valueFormat1);
      const value2 = readValueRecordXAdvance(view, recordOffset + value1Size, valueFormat2);
      return value1.xAdvance + value2.xAdvance;
    };
  }

  throw new CoMotionError(`不支援的 PairPos 格式：${format}`);
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
 * `font`. Shapes the run the same order a real text engine does — GSUB
 * ligature substitution first (which can shrink the glyph count), then GPOS
 * pair kerning between what remains adjacent — before summing font-unit
 * advances and converting to pixels once at the end
 * (`sumUnits * fontSizePx / unitsPerEm`, never per character), so Node and
 * browser callers reach the exact same floating-point result for the same
 * input.
 */
export function measureTextWidth(font: FontMetrics, text: string, fontSizePx: number): number {
  if (typeof fontSizePx !== "number" || Number.isNaN(fontSizePx) || !Number.isFinite(fontSizePx) || fontSizePx < 0) {
    throw new CoMotionError("字級必須是非負的有限數");
  }
  if (text === "" || fontSizePx === 0) {
    return 0;
  }
  const glyphIds: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    glyphIds.push(font.glyphIdForCodePoint(codePoint));
  }
  const shapedGlyphs = font.substituteLigatures(glyphIds);

  let sumUnits = 0;
  for (let i = 0; i < shapedGlyphs.length; i++) {
    sumUnits += font.advanceWidthForGlyph(shapedGlyphs[i]);
    if (i + 1 < shapedGlyphs.length) {
      sumUnits += font.pairKerning(shapedGlyphs[i], shapedGlyphs[i + 1]);
    }
  }
  return (sumUnits * fontSizePx) / font.unitsPerEm;
}
