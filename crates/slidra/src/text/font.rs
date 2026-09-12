//! TTF/OTF (sfnt) binary parsing, ported from `packages/core/src/text-metrics.ts`
//! (the `parseFont`/`FontMetrics` half of that file — `measureTextWidth` is
//! ported separately into `metrics.rs`).
//!
//! Must never depend on anything platform-specific: all reads are manual
//! big-endian integer parsing directly off a `&[u8]`, matching the TS
//! original's use of `DataView` (also always big-endian for these getters)
//! over a `Uint8Array`. No font-parsing crate dependency is introduced —
//! this ticket's Rust dependencies are fixed at `clap`/`serde`/`serde_json`.
//!
//! ## Divergence from the TS source (deliberate, see report)
//!
//! The TS implementation is a mix of two error-handling styles:
//!
//! 1. Explicit `if (...) throw new SlidraError(...)` guards at specific
//!    points (missing table, wrong sfnt version, table directory overrun,
//!    unsupported Coverage/ClassDef/PairPos format, cmap format unsupported,
//!    format-4/format-12 subtable header truncated). These are ported below
//!    as explicit `SlidraError` returns, at the same points, with the same
//!    messages.
//! 2. Un-guarded `DataView` reads elsewhere (inside GSUB/GPOS subtable
//!    walking, `resolveLookupIndices`, ligature/kerning table bodies) that
//!    would throw an uncaught, non-`SlidraError` `RangeError` if a table
//!    were corrupt in a way not covered by guard (1) — e.g. a `LookupList`
//!    offset pointing past the end of the buffer. Rust has no equivalent
//!    "let it throw whatever the runtime throws" — the choice is either
//!    panic or degrade. This module always degrades: out-of-bounds reads in
//!    category (2) return `0` (via the `u16_at`/`i16_at`/`u32_at` helpers
//!    below) rather than panicking or erroring, which for a `GSUB`/`GPOS`
//!    table (both optional — their absence is already "no ligatures/no
//!    kerning") means a corrupt optional table degrades to "as if the table
//!    were absent" instead of crashing font loading. This is *safer* than
//!    the TS behavior, not behavior-identical to it, for the narrow case of
//!    a structurally-corrupt (not merely "format we don't support") optional
//!    table. Everywhere required-table validation happens (`head`/`hhea`/
//!    `hmtx`/`cmap`), explicit bounds checks mirror the TS guards exactly.
//!    2b. One specific runtime (not parse-time) TS throw has no Rust equivalent
//!    at all: `buildFormat4Lookup`'s returned closure throws if a computed
//!    `glyphIndexAddress` lands past the end of the buffer, when looking up
//!    a *specific code point* after the font has already parsed successfully.
//!    The `FontMetrics` trait's `glyph_id_for_code_point` (per this ticket's
//!    required contract) returns `u16`, not a `Result` — there is no channel
//!    to propagate an error from inside a per-character lookup during
//!    `measure_text_width`/`wrap_text`. This case degrades to glyph 0
//!    (`.notdef`) instead. This only differs from TS for a font whose
//!    format-4 cmap subtable is itself internally inconsistent (a valid
//!    idRangeOffset arithmetic that points outside the table) — expected to
//!    be exceedingly rare in real fonts, never triggered by the bundled
//!    `NotoSansTC-Presentation.ttf`.

use crate::errors::{SlidraError, SlidraResult};
use std::collections::HashMap;

/// Matches the TS `FontMetrics` interface (`text-metrics.ts` lines 19-47)
/// method-for-method, reduced to exactly what text measurement needs.
pub trait FontMetrics {
    fn units_per_em(&self) -> u16;
    /// hhea.ascender, font units, positive.
    fn ascender(&self) -> i16;
    /// hhea.descender, font units, negative.
    fn descender(&self) -> i16;
    /// hhea.lineGap, font units.
    fn line_gap(&self) -> i16;
    /// Advance width in font units (not pixels) for one Unicode code point.
    fn advance_width_for_code_point(&self, code_point: u32) -> f64;
    /// Glyph id for a Unicode code point via cmap; 0 (.notdef) if uncovered.
    fn glyph_id_for_code_point(&self, code_point: u32) -> u16;
    /// Advance width in font units for a glyph id (hmtx).
    fn advance_width_for_glyph(&self, glyph_id: u16) -> f64;
    /// GSUB ligature substitution (lookup type 4, 'liga'/'rlig' features)
    /// over a glyph id sequence, returning the possibly-shorter substituted
    /// sequence. A font with no GSUB table, or none of these features,
    /// returns `glyph_ids` unchanged.
    fn substitute_ligatures(&self, glyph_ids: &[u16]) -> Vec<u16>;
    /// GPOS pair-adjustment kerning (lookup type 2, 'kern' feature) between
    /// two adjacent glyphs, as a font-unit xAdvance delta (0 if the font has
    /// no GPOS table, no 'kern' feature, or no pair for this combination).
    fn pair_kerning(&self, glyph_a: u16, glyph_b: u16) -> f64;
}

const SFNT_VERSION_TRUETYPE: u32 = 0x0001_0000;
const SFNT_VERSION_TRUE: u32 = 0x7472_7565; // 'true'
const SFNT_TAG_OTTO: u32 = 0x4f54_544f; // 'OTTO' (CFF-flavored OpenType)
const TAG_WOFF: u32 = 0x774f_4646; // 'wOFF'
const TAG_WOFF2: u32 = 0x774f_4632; // 'wOF2'

/// The project's bundled default font, embedded at compile time so the Rust
/// engine never depends on a font "happening to be installed" (mirrors
/// `packages/core/src/default-font.ts`'s ADR-0016 rationale). Path is
/// relative to this crate's `Cargo.toml` (`crates/slidra/`): `../../`
/// reaches the repo root, then into `assets/fonts/...`.
pub const DEFAULT_FONT_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../assets/fonts/NotoSansTC-Presentation.ttf"
));

/// Matches `packages/core/src/default-font.ts`'s `DEFAULT_FONT_FAMILY` verbatim.
pub const DEFAULT_FONT_FAMILY: &str = "Noto Sans TC";

fn corrupt() -> SlidraError {
    SlidraError::invalid("font file is invalid or corrupted")
}

// --- Raw big-endian reads. Out-of-bounds returns 0 rather than panicking —
// see the module-level "Divergence" note for what this means relative to
// the TS source's unguarded `DataView` reads. ---

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    bytes
        .get(offset..offset + 2)
        .map(|s| u16::from_be_bytes([s[0], s[1]]))
        .unwrap_or(0)
}

fn i16_at(bytes: &[u8], offset: usize) -> i16 {
    u16_at(bytes, offset) as i16
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    bytes
        .get(offset..offset + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
        .unwrap_or(0)
}

/// `String.fromCharCode` over 4 raw bytes — each byte maps 1:1 to the
/// Latin-1 code point of the same value (SFNT tags are always ASCII).
fn read_tag(bytes: &[u8], offset: usize) -> String {
    (0..4)
        .map(|i| bytes.get(offset + i).copied().unwrap_or(0) as char)
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct TableRecord {
    offset: usize,
    length: usize,
}

fn require_table(tables: &HashMap<String, TableRecord>, tag: &str) -> SlidraResult<TableRecord> {
    tables
        .get(tag)
        .copied()
        .ok_or_else(|| SlidraError::invalid(format!("font file is missing required table: {tag}")))
}

#[derive(Debug)]
enum CmapKind {
    Format12 {
        groups_start: usize,
        num_groups: u32,
    },
    Format4 {
        seg_count: u16,
        end_codes_start: usize,
        start_codes_start: usize,
        id_deltas_start: usize,
        id_range_offsets_start: usize,
    },
}

#[derive(Debug)]
struct LigatureRule {
    /// Components after the coverage (first) glyph, in match order.
    component_glyphs: Vec<u16>,
    ligature_glyph: u16,
}

#[derive(Debug)]
enum PairPosSubtable {
    Format1 {
        coverage: HashMap<u16, u16>,
        pair_set_offsets: Vec<usize>,
        value_format1: u16,
        value_format2: u16,
        value1_size: usize,
        value2_size: usize,
    },
    Format2 {
        coverage: HashMap<u16, u16>,
        class_def1: HashMap<u16, u16>,
        class_def2: HashMap<u16, u16>,
        class1_count: u16,
        class2_count: u16,
        class_records_start: usize,
        value_format1: u16,
        value_format2: u16,
        value1_size: usize,
        value2_size: usize,
    },
}

impl PairPosSubtable {
    fn kerning(&self, bytes: &[u8], glyph_a: u16, glyph_b: u16) -> f64 {
        match self {
            PairPosSubtable::Format1 {
                coverage,
                pair_set_offsets,
                value_format1,
                value_format2,
                value1_size,
                value2_size,
            } => {
                let coverage_index = match coverage.get(&glyph_a) {
                    Some(&i) => i as usize,
                    None => return 0.0,
                };
                if coverage_index >= pair_set_offsets.len() {
                    return 0.0;
                }
                let pair_set_offset = pair_set_offsets[coverage_index];
                let pair_value_count = u16_at(bytes, pair_set_offset);
                let mut cursor = pair_set_offset + 2;
                for _ in 0..pair_value_count {
                    let second_glyph = u16_at(bytes, cursor);
                    cursor += 2;
                    let (x1, _) = read_value_record_x_advance(bytes, cursor, *value_format1);
                    cursor += value1_size;
                    let (x2, _) = read_value_record_x_advance(bytes, cursor, *value_format2);
                    cursor += value2_size;
                    if second_glyph == glyph_b {
                        return f64::from(x1) + f64::from(x2);
                    }
                }
                0.0
            }
            PairPosSubtable::Format2 {
                coverage,
                class_def1,
                class_def2,
                class1_count,
                class2_count,
                class_records_start,
                value_format1,
                value_format2,
                value1_size,
                value2_size,
            } => {
                if !coverage.contains_key(&glyph_a) {
                    return 0.0;
                }
                let class1 = class_def1.get(&glyph_a).copied().unwrap_or(0);
                let class2 = class_def2.get(&glyph_b).copied().unwrap_or(0);
                if class1 >= *class1_count || class2 >= *class2_count {
                    return 0.0;
                }
                let record_size = value1_size + value2_size;
                let record_offset = class_records_start
                    + (class1 as usize * *class2_count as usize + class2 as usize) * record_size;
                let (x1, _) = read_value_record_x_advance(bytes, record_offset, *value_format1);
                let (x2, _) =
                    read_value_record_x_advance(bytes, record_offset + value1_size, *value_format2);
                f64::from(x1) + f64::from(x2)
            }
        }
    }
}

/// Byte size, in a ValueRecord, of the fields `value_format`'s bits select.
fn value_record_size(value_format: u16) -> usize {
    let mut count = 0usize;
    let mut bit = 0x0001u16;
    while bit <= 0x0080 {
        if value_format & bit != 0 {
            count += 1;
        }
        bit <<= 1;
    }
    count * 2
}

/// Reads a ValueRecord at `offset`, extracting only XAdvance (the sole field
/// that changes a run's total horizontal advance). Returns `(xAdvance,
/// totalByteSize)` so callers can advance past the record regardless of
/// which fields are present.
fn read_value_record_x_advance(bytes: &[u8], offset: usize, value_format: u16) -> (i16, usize) {
    let mut cursor = offset;
    let mut x_advance = 0i16;
    if value_format & 0x0001 != 0 {
        cursor += 2; // XPlacement
    }
    if value_format & 0x0002 != 0 {
        cursor += 2; // YPlacement
    }
    if value_format & 0x0004 != 0 {
        x_advance = i16_at(bytes, cursor);
        cursor += 2;
    }
    if value_format & 0x0008 != 0 {
        cursor += 2; // YAdvance
    }
    if value_format & 0x0010 != 0 {
        cursor += 2; // XPlaDevice
    }
    if value_format & 0x0020 != 0 {
        cursor += 2; // YPlaDevice
    }
    if value_format & 0x0040 != 0 {
        cursor += 2; // XAdvDevice
    }
    if value_format & 0x0080 != 0 {
        cursor += 2; // YAdvDevice
    }
    (x_advance, cursor - offset)
}

/// Parses a Coverage table into glyph id -> coverage index.
fn parse_coverage(bytes: &[u8], offset: usize) -> SlidraResult<HashMap<u16, u16>> {
    let format = u16_at(bytes, offset);
    let mut map = HashMap::new();
    if format == 1 {
        let glyph_count = u16_at(bytes, offset + 2);
        for i in 0..glyph_count as usize {
            map.insert(u16_at(bytes, offset + 4 + i * 2), i as u16);
        }
    } else if format == 2 {
        let range_count = u16_at(bytes, offset + 2);
        for i in 0..range_count as usize {
            let range_offset = offset + 4 + i * 6;
            let start_glyph = u16_at(bytes, range_offset);
            let end_glyph = u16_at(bytes, range_offset + 2);
            let start_coverage_index = u16_at(bytes, range_offset + 4);
            let mut glyph = start_glyph;
            loop {
                map.insert(
                    glyph,
                    start_coverage_index.wrapping_add(glyph - start_glyph),
                );
                if glyph >= end_glyph {
                    break;
                }
                glyph += 1;
            }
        }
    } else {
        return Err(SlidraError::invalid(format!(
            "unsupported Coverage format: {format}"
        )));
    }
    Ok(map)
}

/// Parses a ClassDef table into glyph id -> class (glyphs not listed are class 0).
fn parse_class_def(bytes: &[u8], offset: usize) -> SlidraResult<HashMap<u16, u16>> {
    let format = u16_at(bytes, offset);
    let mut map = HashMap::new();
    if format == 1 {
        let start_glyph = u16_at(bytes, offset + 2);
        let glyph_count = u16_at(bytes, offset + 4);
        for i in 0..glyph_count as usize {
            let class_value = u16_at(bytes, offset + 6 + i * 2);
            if class_value != 0 {
                map.insert(start_glyph.wrapping_add(i as u16), class_value);
            }
        }
    } else if format == 2 {
        let range_count = u16_at(bytes, offset + 2);
        for i in 0..range_count as usize {
            let range_offset = offset + 4 + i * 6;
            let start_glyph = u16_at(bytes, range_offset);
            let end_glyph = u16_at(bytes, range_offset + 2);
            let class_value = u16_at(bytes, range_offset + 4);
            if class_value != 0 {
                let mut glyph = start_glyph;
                loop {
                    map.insert(glyph, class_value);
                    if glyph >= end_glyph {
                        break;
                    }
                    glyph += 1;
                }
            }
        }
    } else {
        return Err(SlidraError::invalid(format!(
            "unsupported ClassDef format: {format}"
        )));
    }
    Ok(map)
}

/// Resolves the lookup table byte offsets a GSUB/GPOS table's `wanted_tags`
/// features activate, for whichever of "latn"/"hani"/"DFLT"/first-listed
/// script the font declares.
fn resolve_lookup_indices(bytes: &[u8], table_offset: usize, wanted_tags: &[&str]) -> Vec<usize> {
    let script_list_offset = table_offset + u16_at(bytes, table_offset + 4) as usize;
    let feature_list_offset = table_offset + u16_at(bytes, table_offset + 6) as usize;
    let lookup_list_offset = table_offset + u16_at(bytes, table_offset + 8) as usize;

    let script_count = u16_at(bytes, script_list_offset);
    const PREFERRED_SCRIPT_TAGS: [&str; 3] = ["latn", "hani", "DFLT"];
    let mut chosen_script_offset: Option<usize> = None;
    let mut fallback_script_offset: Option<usize> = None;
    let mut best_preference_rank = PREFERRED_SCRIPT_TAGS.len();
    for i in 0..script_count as usize {
        let record_offset = script_list_offset + 2 + i * 6;
        let tag = read_tag(bytes, record_offset);
        let script_offset = script_list_offset + u16_at(bytes, record_offset + 4) as usize;
        if fallback_script_offset.is_none() {
            fallback_script_offset = Some(script_offset);
        }
        if let Some(rank) = PREFERRED_SCRIPT_TAGS.iter().position(|&t| t == tag) {
            if rank < best_preference_rank {
                best_preference_rank = rank;
                chosen_script_offset = Some(script_offset);
            }
        }
    }
    let script_offset = match chosen_script_offset.or(fallback_script_offset) {
        Some(offset) => offset,
        None => return Vec::new(),
    };

    let default_lang_sys_offset = u16_at(bytes, script_offset);
    let lang_sys_count = u16_at(bytes, script_offset + 2);
    let lang_sys_offset = if default_lang_sys_offset != 0 {
        Some(script_offset + default_lang_sys_offset as usize)
    } else if lang_sys_count > 0 {
        Some(script_offset + u16_at(bytes, script_offset + 4 + 4) as usize)
    } else {
        None
    };
    let lang_sys_offset = match lang_sys_offset {
        Some(offset) => offset,
        None => return Vec::new(),
    };

    let feature_index_count = u16_at(bytes, lang_sys_offset + 4);
    let mut feature_indices = Vec::with_capacity(feature_index_count as usize);
    for i in 0..feature_index_count as usize {
        feature_indices.push(u16_at(bytes, lang_sys_offset + 6 + i * 2));
    }

    let feature_count = u16_at(bytes, feature_list_offset);
    let mut lookup_indices: Vec<u16> = Vec::new();
    for feature_index in feature_indices {
        if feature_index as usize >= feature_count as usize {
            continue;
        }
        let record_offset = feature_list_offset + 2 + feature_index as usize * 6;
        let tag = read_tag(bytes, record_offset);
        if !wanted_tags.contains(&tag.as_str()) {
            continue;
        }
        let feature_offset = feature_list_offset + u16_at(bytes, record_offset + 4) as usize;
        let lookup_index_count = u16_at(bytes, feature_offset + 2);
        for i in 0..lookup_index_count as usize {
            lookup_indices.push(u16_at(bytes, feature_offset + 4 + i * 2));
        }
    }

    lookup_indices
        .iter()
        .map(|&lookup_index| {
            lookup_list_offset
                + u16_at(bytes, lookup_list_offset + 2 + lookup_index as usize * 2) as usize
        })
        .collect()
}

/// Builds first-glyph -> candidate ligatures from every 'liga'/'rlig' GSUB
/// lookup's ligature (type 4) subtables.
fn parse_ligature_map(
    bytes: &[u8],
    gsub: &TableRecord,
) -> SlidraResult<HashMap<u16, Vec<LigatureRule>>> {
    let mut map: HashMap<u16, Vec<LigatureRule>> = HashMap::new();
    let lookup_offsets = resolve_lookup_indices(bytes, gsub.offset, &["liga", "rlig"]);
    for lookup_offset in lookup_offsets {
        let lookup_type = u16_at(bytes, lookup_offset);
        if lookup_type != 4 {
            continue;
        }
        let subtable_count = u16_at(bytes, lookup_offset + 4);
        for s in 0..subtable_count as usize {
            let subtable_offset = lookup_offset + u16_at(bytes, lookup_offset + 6 + s * 2) as usize;
            let coverage_offset = subtable_offset + u16_at(bytes, subtable_offset + 2) as usize;
            let coverage = parse_coverage(bytes, coverage_offset)?;
            let lig_set_count = u16_at(bytes, subtable_offset + 4);
            for (&first_glyph, &coverage_index) in &coverage {
                if coverage_index as usize >= lig_set_count as usize {
                    continue;
                }
                let lig_set_offset = subtable_offset
                    + u16_at(bytes, subtable_offset + 6 + coverage_index as usize * 2) as usize;
                let ligature_count = u16_at(bytes, lig_set_offset);
                let mut rules = Vec::with_capacity(ligature_count as usize);
                for l in 0..ligature_count as usize {
                    let lig_offset =
                        lig_set_offset + u16_at(bytes, lig_set_offset + 2 + l * 2) as usize;
                    let ligature_glyph = u16_at(bytes, lig_offset);
                    let component_count = u16_at(bytes, lig_offset + 2) as usize;
                    let mut component_glyphs = Vec::new();
                    for c in 0..component_count.saturating_sub(1) {
                        component_glyphs.push(u16_at(bytes, lig_offset + 4 + c * 2));
                    }
                    rules.push(LigatureRule {
                        component_glyphs,
                        ligature_glyph,
                    });
                }
                map.entry(first_glyph).or_insert(rules);
            }
        }
    }
    Ok(map)
}

/// Left-to-right, listed-order-first ligature substitution over a glyph id
/// sequence — the first matching rule at each position wins, mirroring the
/// TS `applyLigatures`.
fn apply_ligatures(glyph_ids: &[u16], ligature_map: &HashMap<u16, Vec<LigatureRule>>) -> Vec<u16> {
    if ligature_map.is_empty() {
        return glyph_ids.to_vec();
    }
    let mut result = Vec::new();
    let mut i = 0;
    while i < glyph_ids.len() {
        let rules = ligature_map.get(&glyph_ids[i]);
        let mut matched: Option<&LigatureRule> = None;
        if let Some(rules) = rules {
            for rule in rules {
                let end = i + 1 + rule.component_glyphs.len();
                if end > glyph_ids.len() {
                    continue;
                }
                if rule
                    .component_glyphs
                    .iter()
                    .enumerate()
                    .all(|(offset, &g)| glyph_ids[i + 1 + offset] == g)
                {
                    matched = Some(rule);
                    break;
                }
            }
        }
        if let Some(rule) = matched {
            result.push(rule.ligature_glyph);
            i += 1 + rule.component_glyphs.len();
        } else {
            result.push(glyph_ids[i]);
            i += 1;
        }
    }
    result
}

/// Builds every pair-adjustment (type 2) subtable from every 'kern' GPOS lookup.
fn parse_pair_kerning(bytes: &[u8], gpos: &TableRecord) -> SlidraResult<Vec<PairPosSubtable>> {
    let lookup_offsets = resolve_lookup_indices(bytes, gpos.offset, &["kern"]);
    let mut subtables = Vec::new();
    for lookup_offset in lookup_offsets {
        let lookup_type = u16_at(bytes, lookup_offset);
        if lookup_type != 2 {
            continue;
        }
        let subtable_count = u16_at(bytes, lookup_offset + 4);
        for s in 0..subtable_count as usize {
            let subtable_offset = lookup_offset + u16_at(bytes, lookup_offset + 6 + s * 2) as usize;
            subtables.push(parse_pair_pos_subtable(bytes, subtable_offset)?);
        }
    }
    Ok(subtables)
}

fn parse_pair_pos_subtable(bytes: &[u8], subtable_offset: usize) -> SlidraResult<PairPosSubtable> {
    let format = u16_at(bytes, subtable_offset);
    let coverage_offset = subtable_offset + u16_at(bytes, subtable_offset + 2) as usize;
    let value_format1 = u16_at(bytes, subtable_offset + 4);
    let value_format2 = u16_at(bytes, subtable_offset + 6);
    let coverage = parse_coverage(bytes, coverage_offset)?;
    let value1_size = value_record_size(value_format1);
    let value2_size = value_record_size(value_format2);

    if format == 1 {
        let pair_set_count = u16_at(bytes, subtable_offset + 8);
        let mut pair_set_offsets = Vec::with_capacity(pair_set_count as usize);
        for i in 0..pair_set_count as usize {
            pair_set_offsets
                .push(subtable_offset + u16_at(bytes, subtable_offset + 10 + i * 2) as usize);
        }
        return Ok(PairPosSubtable::Format1 {
            coverage,
            pair_set_offsets,
            value_format1,
            value_format2,
            value1_size,
            value2_size,
        });
    }

    if format == 2 {
        let class_def1_offset = subtable_offset + u16_at(bytes, subtable_offset + 8) as usize;
        let class_def2_offset = subtable_offset + u16_at(bytes, subtable_offset + 10) as usize;
        let class1_count = u16_at(bytes, subtable_offset + 12);
        let class2_count = u16_at(bytes, subtable_offset + 14);
        let class_def1 = parse_class_def(bytes, class_def1_offset)?;
        let class_def2 = parse_class_def(bytes, class_def2_offset)?;
        let class_records_start = subtable_offset + 16;
        return Ok(PairPosSubtable::Format2 {
            coverage,
            class_def1,
            class_def2,
            class1_count,
            class2_count,
            class_records_start,
            value_format1,
            value_format2,
            value1_size,
            value2_size,
        });
    }

    Err(SlidraError::invalid(format!(
        "unsupported PairPos format: {format}"
    )))
}

/// Picks a Unicode cmap subtable (format 4 preferred to format 12 in the TS
/// source's own preference — `format12Offset` is checked first below,
/// matching `parseCmap`'s `if (format12Offset !== -1) ... else if
/// (format4Offset !== -1)`), eagerly validating its header the same way
/// `buildFormat12Lookup`/`buildFormat4Lookup` do at parse time (not lazily).
fn parse_cmap(bytes: &[u8], cmap: TableRecord) -> SlidraResult<CmapKind> {
    if cmap.length < 4 {
        return Err(corrupt());
    }
    let num_subtables = u16_at(bytes, cmap.offset + 2);
    if 4 + num_subtables as usize * 8 > cmap.length {
        return Err(corrupt());
    }

    let mut format12_offset: Option<usize> = None;
    let mut format4_offset: Option<usize> = None;
    for i in 0..num_subtables as usize {
        let record_offset = cmap.offset + 4 + i * 8;
        let platform_id = u16_at(bytes, record_offset);
        let encoding_id = u16_at(bytes, record_offset + 2);
        let subtable_offset = cmap.offset + u32_at(bytes, record_offset + 4) as usize;
        let is_unicode_platform =
            platform_id == 0 || (platform_id == 3 && (encoding_id == 1 || encoding_id == 10));
        if !is_unicode_platform || subtable_offset + 2 > bytes.len() {
            continue;
        }
        let format = u16_at(bytes, subtable_offset);
        if format == 12 {
            format12_offset = Some(subtable_offset);
        } else if format == 4 && format4_offset.is_none() {
            format4_offset = Some(subtable_offset);
        }
    }

    if let Some(offset) = format12_offset {
        return build_format12(bytes, offset);
    }
    if let Some(offset) = format4_offset {
        return build_format4(bytes, offset);
    }
    Err(SlidraError::invalid("font cmap format not supported"))
}

fn build_format12(bytes: &[u8], offset: usize) -> SlidraResult<CmapKind> {
    if offset + 16 > bytes.len() {
        return Err(corrupt());
    }
    let num_groups = u32_at(bytes, offset + 12);
    let groups_start = offset + 16;
    if groups_start + num_groups as usize * 12 > bytes.len() {
        return Err(corrupt());
    }
    Ok(CmapKind::Format12 {
        groups_start,
        num_groups,
    })
}

fn build_format4(bytes: &[u8], offset: usize) -> SlidraResult<CmapKind> {
    if offset + 14 > bytes.len() {
        return Err(corrupt());
    }
    let seg_count_x2 = u16_at(bytes, offset + 6);
    let seg_count = seg_count_x2 / 2;
    let end_codes_start = offset + 14;
    let start_codes_start = end_codes_start + seg_count_x2 as usize + 2; // +2 skips reservedPad
    let id_deltas_start = start_codes_start + seg_count_x2 as usize;
    let id_range_offsets_start = id_deltas_start + seg_count_x2 as usize;
    if id_range_offsets_start + seg_count_x2 as usize > bytes.len() {
        return Err(corrupt());
    }
    Ok(CmapKind::Format4 {
        seg_count,
        end_codes_start,
        start_codes_start,
        id_deltas_start,
        id_range_offsets_start,
    })
}

fn lookup_format12(bytes: &[u8], groups_start: usize, num_groups: u32, code_point: u32) -> u16 {
    for i in 0..num_groups {
        let group_offset = groups_start + i as usize * 12;
        let start_char_code = u32_at(bytes, group_offset);
        let end_char_code = u32_at(bytes, group_offset + 4);
        if code_point >= start_char_code && code_point <= end_char_code {
            let start_glyph_id = u32_at(bytes, group_offset + 8);
            return (start_glyph_id + (code_point - start_char_code)) as u16;
        }
    }
    0
}

#[allow(clippy::too_many_arguments)]
fn lookup_format4(
    bytes: &[u8],
    seg_count: u16,
    end_codes_start: usize,
    start_codes_start: usize,
    id_deltas_start: usize,
    id_range_offsets_start: usize,
    code_point: u32,
) -> u16 {
    // Format 4 only maps the Basic Multilingual Plane; an astral code point
    // is, by definition, not covered by this subtable.
    if code_point > 0xffff {
        return 0;
    }
    let cp = code_point as u16;
    for i in 0..seg_count {
        let end_code = u16_at(bytes, end_codes_start + i as usize * 2);
        if cp > end_code {
            continue;
        }
        let start_code = u16_at(bytes, start_codes_start + i as usize * 2);
        if cp < start_code {
            return 0;
        }
        let id_delta = i16_at(bytes, id_deltas_start + i as usize * 2);
        let id_range_offset = u16_at(bytes, id_range_offsets_start + i as usize * 2);
        if id_range_offset == 0 {
            return cp.wrapping_add(id_delta as u16);
        }
        let glyph_index_address = id_range_offsets_start
            + i as usize * 2
            + id_range_offset as usize
            + (cp - start_code) as usize * 2;
        if glyph_index_address + 2 > bytes.len() {
            // TS throws here (a structurally-inconsistent idRangeOffset).
            // `glyph_id_for_code_point` has no Result channel (fixed trait
            // contract) — degrade to .notdef instead. See module doc.
            return 0;
        }
        let glyph_id = u16_at(bytes, glyph_index_address);
        return if glyph_id == 0 {
            0
        } else {
            glyph_id.wrapping_add(id_delta as u16)
        };
    }
    0
}

/// A parsed sfnt (TTF/OTF) font. Owns its source bytes plus every offset/map
/// needed to answer `FontMetrics` queries — mirrors the TS `parseFont`'s
/// closures, which all capture the same `DataView` over the original buffer.
#[derive(Debug)]
pub struct ParsedFont {
    bytes: Vec<u8>,
    units_per_em: u16,
    ascender: i16,
    descender: i16,
    line_gap: i16,
    number_of_h_metrics: u16,
    hmtx_offset: usize,
    cmap_kind: CmapKind,
    ligature_map: HashMap<u16, Vec<LigatureRule>>,
    pair_kerning_subtables: Vec<PairPosSubtable>,
}

/// Parses raw sfnt bytes into a `ParsedFont`. Only reads the tables text
/// measurement needs (`head`, `hhea`, `hmtx`, `cmap`, optionally `GSUB`/
/// `GPOS`) — never the whole font.
///
/// - Empty or truncated input errors, never returns a zero-width font.
/// - WOFF/WOFF2 is explicitly rejected (not decompressed) — the container
///   only ever holds sfnt (.ttf/.otf).
/// - A missing required table, or a cmap without a format 4 or 12 subtable,
///   errors naming what's missing/unsupported.
pub fn parse_font(bytes: &[u8]) -> SlidraResult<ParsedFont> {
    if bytes.len() < 12 {
        return Err(corrupt());
    }
    let sfnt_version = u32_at(bytes, 0);
    if sfnt_version == TAG_WOFF || sfnt_version == TAG_WOFF2 {
        return Err(SlidraError::invalid(
            "unsupported font format, requires TTF or OTF",
        ));
    }
    if sfnt_version != SFNT_VERSION_TRUETYPE
        && sfnt_version != SFNT_VERSION_TRUE
        && sfnt_version != SFNT_TAG_OTTO
    {
        return Err(corrupt());
    }

    let num_tables = u16_at(bytes, 4) as usize;
    let directory_end = 12 + num_tables * 16;
    if directory_end > bytes.len() {
        return Err(corrupt());
    }

    let mut tables: HashMap<String, TableRecord> = HashMap::new();
    for i in 0..num_tables {
        let record_offset = 12 + i * 16;
        let tag = read_tag(bytes, record_offset);
        let offset = u32_at(bytes, record_offset + 8) as usize;
        let length = u32_at(bytes, record_offset + 12) as usize;
        if offset + length > bytes.len() {
            return Err(corrupt());
        }
        tables.insert(tag, TableRecord { offset, length });
    }

    let head = require_table(&tables, "head")?;
    let hhea = require_table(&tables, "hhea")?;
    let hmtx = require_table(&tables, "hmtx")?;
    let cmap = require_table(&tables, "cmap")?;

    if head.length < 20 {
        return Err(corrupt());
    }
    let units_per_em = u16_at(bytes, head.offset + 18);

    if hhea.length < 36 {
        return Err(corrupt());
    }
    let number_of_h_metrics = u16_at(bytes, hhea.offset + 34);
    if number_of_h_metrics == 0 || hmtx.length < number_of_h_metrics as usize * 4 {
        return Err(corrupt());
    }
    let ascender = i16_at(bytes, hhea.offset + 4);
    let descender = i16_at(bytes, hhea.offset + 6);
    let line_gap = i16_at(bytes, hhea.offset + 8);

    let cmap_kind = parse_cmap(bytes, cmap)?;

    let ligature_map = match tables.get("GSUB") {
        Some(gsub) => parse_ligature_map(bytes, gsub)?,
        None => HashMap::new(),
    };

    let pair_kerning_subtables = match tables.get("GPOS") {
        Some(gpos) => parse_pair_kerning(bytes, gpos)?,
        None => Vec::new(),
    };

    Ok(ParsedFont {
        bytes: bytes.to_vec(),
        units_per_em,
        ascender,
        descender,
        line_gap,
        number_of_h_metrics,
        hmtx_offset: hmtx.offset,
        cmap_kind,
        ligature_map,
        pair_kerning_subtables,
    })
}

impl FontMetrics for ParsedFont {
    fn units_per_em(&self) -> u16 {
        self.units_per_em
    }

    fn ascender(&self) -> i16 {
        self.ascender
    }

    fn descender(&self) -> i16 {
        self.descender
    }

    fn line_gap(&self) -> i16 {
        self.line_gap
    }

    fn advance_width_for_code_point(&self, code_point: u32) -> f64 {
        self.advance_width_for_glyph(self.glyph_id_for_code_point(code_point))
    }

    fn glyph_id_for_code_point(&self, code_point: u32) -> u16 {
        match &self.cmap_kind {
            CmapKind::Format12 {
                groups_start,
                num_groups,
            } => lookup_format12(&self.bytes, *groups_start, *num_groups, code_point),
            CmapKind::Format4 {
                seg_count,
                end_codes_start,
                start_codes_start,
                id_deltas_start,
                id_range_offsets_start,
            } => lookup_format4(
                &self.bytes,
                *seg_count,
                *end_codes_start,
                *start_codes_start,
                *id_deltas_start,
                *id_range_offsets_start,
                code_point,
            ),
        }
    }

    fn advance_width_for_glyph(&self, glyph_id: u16) -> f64 {
        // number_of_h_metrics is guaranteed >= 1 by parse_font's validation.
        let clamped_index = glyph_id.min(self.number_of_h_metrics - 1) as usize;
        u16_at(&self.bytes, self.hmtx_offset + clamped_index * 4) as f64
    }

    fn substitute_ligatures(&self, glyph_ids: &[u16]) -> Vec<u16> {
        apply_ligatures(glyph_ids, &self.ligature_map)
    }

    fn pair_kerning(&self, glyph_a: u16, glyph_b: u16) -> f64 {
        for subtable in &self.pair_kerning_subtables {
            let delta = subtable.kerning(&self.bytes, glyph_a, glyph_b);
            if delta != 0.0 {
                return delta;
            }
        }
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Pure-logic helpers: no font bytes needed. ---

    #[test]
    fn read_tag_decodes_four_ascii_bytes() {
        assert_eq!(read_tag(b"GSUB", 0), "GSUB");
    }

    #[test]
    fn u16_at_out_of_bounds_degrades_to_zero_rather_than_panicking() {
        assert_eq!(u16_at(&[0x01], 0), 0);
        assert_eq!(u16_at(&[], 5), 0);
    }

    #[test]
    fn i16_at_reinterprets_high_bit_as_negative() {
        assert_eq!(i16_at(&[0xff, 0xff], 0), -1);
        assert_eq!(i16_at(&[0x80, 0x00], 0), i16::MIN);
    }

    #[test]
    fn value_record_size_counts_set_bits_times_two() {
        assert_eq!(value_record_size(0x0000), 0);
        assert_eq!(value_record_size(0x0004), 2); // XAdvance only
        assert_eq!(value_record_size(0x000f), 8); // four low fields
        assert_eq!(value_record_size(0x00ff), 16); // all eight fields
    }

    #[test]
    fn read_value_record_x_advance_skips_preceding_fields() {
        // XPlacement(2) + YPlacement(2) + XAdvance(2), value = -5.
        let format = 0x0001 | 0x0002 | 0x0004;
        let mut bytes = vec![0u8; 6];
        bytes[4..6].copy_from_slice(&(-5i16).to_be_bytes());
        let (x_advance, size) = read_value_record_x_advance(&bytes, 0, format);
        assert_eq!(x_advance, -5);
        assert_eq!(size, 6);
    }

    #[test]
    fn apply_ligatures_with_empty_map_is_identity() {
        let map = HashMap::new();
        assert_eq!(apply_ligatures(&[1, 2, 3], &map), vec![1, 2, 3]);
    }

    #[test]
    fn apply_ligatures_substitutes_matching_run_and_continues_after() {
        // Glyphs [10, 11] -> ligature glyph 99 (e.g. "fi" -> ligature).
        let mut map = HashMap::new();
        map.insert(
            10u16,
            vec![LigatureRule {
                component_glyphs: vec![11],
                ligature_glyph: 99,
            }],
        );
        let result = apply_ligatures(&[10, 11, 5], &map);
        assert_eq!(result, vec![99, 5]);
    }

    #[test]
    fn apply_ligatures_does_not_match_when_components_dont_follow() {
        let mut map = HashMap::new();
        map.insert(
            10u16,
            vec![LigatureRule {
                component_glyphs: vec![11],
                ligature_glyph: 99,
            }],
        );
        let result = apply_ligatures(&[10, 5, 11], &map);
        assert_eq!(result, vec![10, 5, 11]);
    }

    #[test]
    fn parse_coverage_format1_maps_listed_glyphs_to_their_index() {
        // format=1, glyphCount=2, glyphs=[7,9]
        let mut bytes = vec![0u8; 8];
        bytes[0..2].copy_from_slice(&1u16.to_be_bytes());
        bytes[2..4].copy_from_slice(&2u16.to_be_bytes());
        bytes[4..6].copy_from_slice(&7u16.to_be_bytes());
        bytes[6..8].copy_from_slice(&9u16.to_be_bytes());
        let map = parse_coverage(&bytes, 0).unwrap();
        assert_eq!(map.get(&7), Some(&0));
        assert_eq!(map.get(&9), Some(&1));
        assert_eq!(map.get(&8), None);
    }

    #[test]
    fn parse_coverage_format2_expands_ranges() {
        // format=2, rangeCount=1, range: startGlyph=100, endGlyph=102, startCoverageIndex=5
        let mut bytes = vec![0u8; 10];
        bytes[0..2].copy_from_slice(&2u16.to_be_bytes());
        bytes[2..4].copy_from_slice(&1u16.to_be_bytes());
        bytes[4..6].copy_from_slice(&100u16.to_be_bytes());
        bytes[6..8].copy_from_slice(&102u16.to_be_bytes());
        bytes[8..10].copy_from_slice(&5u16.to_be_bytes());
        let map = parse_coverage(&bytes, 0).unwrap();
        assert_eq!(map.get(&100), Some(&5));
        assert_eq!(map.get(&101), Some(&6));
        assert_eq!(map.get(&102), Some(&7));
        assert_eq!(map.get(&103), None);
    }

    #[test]
    fn parse_coverage_unsupported_format_errors() {
        let bytes = vec![0u8, 9, 0, 0]; // format = 9
        let err = parse_coverage(&bytes, 0).unwrap_err();
        assert!(err.message().contains("unsupported Coverage format"));
    }

    #[test]
    fn parse_class_def_format1_skips_class_zero_entries() {
        // format=1, startGlyph=50, glyphCount=3, classes=[0, 2, 0]
        let mut bytes = vec![0u8; 12];
        bytes[0..2].copy_from_slice(&1u16.to_be_bytes());
        bytes[2..4].copy_from_slice(&50u16.to_be_bytes());
        bytes[4..6].copy_from_slice(&3u16.to_be_bytes());
        bytes[6..8].copy_from_slice(&0u16.to_be_bytes());
        bytes[8..10].copy_from_slice(&2u16.to_be_bytes());
        bytes[10..12].copy_from_slice(&0u16.to_be_bytes());
        let map = parse_class_def(&bytes, 0).unwrap();
        assert_eq!(map.get(&50), None);
        assert_eq!(map.get(&51), Some(&2));
        assert_eq!(map.get(&52), None);
    }

    // --- Full sfnt parsing, against a hand-built minimal valid font. ---

    /// Builds the smallest sfnt buffer `parse_font` accepts: table directory
    /// plus `head`/`hhea`/`hmtx`/`cmap` (format 4, two glyphs mapped) and no
    /// `GSUB`/`GPOS`. All the fields this module doesn't read are left zero.
    fn build_minimal_font() -> Vec<u8> {
        // --- hmtx: 2 hMetric records (advanceWidth u16, lsb i16), matching
        // numberOfHMetrics=2 below. Glyph 0 (.notdef) width 500, glyph 1
        // width 600.
        let mut hmtx = Vec::new();
        hmtx.extend_from_slice(&500u16.to_be_bytes());
        hmtx.extend_from_slice(&0i16.to_be_bytes());
        hmtx.extend_from_slice(&600u16.to_be_bytes());
        hmtx.extend_from_slice(&0i16.to_be_bytes());

        // --- head: only unitsPerEm (offset 18) matters; needs length >= 20.
        let mut head = vec![0u8; 20];
        head[18..20].copy_from_slice(&1000u16.to_be_bytes());

        // --- hhea: ascender(+4)/descender(+6)/lineGap(+8)/numberOfHMetrics(+34); needs length >= 36.
        let mut hhea = vec![0u8; 36];
        hhea[4..6].copy_from_slice(&800i16.to_be_bytes());
        hhea[6..8].copy_from_slice(&(-200i16).to_be_bytes());
        hhea[8..10].copy_from_slice(&100i16.to_be_bytes());
        hhea[34..36].copy_from_slice(&2u16.to_be_bytes());

        // --- cmap: header + one format-4 Unicode BMP subtable mapping
        // codepoint 'A' (0x41) -> glyph 1, everything else -> glyph 0.
        // Format 4 with 2 segments: [0x41,0x41] -> glyph 1 (via idRangeOffset
        // pointing at a glyphIdArray entry), and the required final
        // 0xFFFF..0xFFFF terminator segment -> .notdef (idDelta making
        // (0xffff+idDelta)&0xffff == 0).
        let seg_count: u16 = 2;
        let seg_count_x2 = seg_count * 2;
        let mut format4 = Vec::new();
        format4.extend_from_slice(&4u16.to_be_bytes()); // format
        format4.extend_from_slice(&0u16.to_be_bytes()); // length (unused by our parser)
        format4.extend_from_slice(&0u16.to_be_bytes()); // language (unused)
        format4.extend_from_slice(&seg_count_x2.to_be_bytes());
        format4.extend_from_slice(&0u16.to_be_bytes()); // searchRange (unused)
        format4.extend_from_slice(&0u16.to_be_bytes()); // entrySelector (unused)
        format4.extend_from_slice(&0u16.to_be_bytes()); // rangeShift (unused)
        // endCodes[2]
        format4.extend_from_slice(&0x41u16.to_be_bytes());
        format4.extend_from_slice(&0xffffu16.to_be_bytes());
        format4.extend_from_slice(&0u16.to_be_bytes()); // reservedPad
        // startCodes[2]
        format4.extend_from_slice(&0x41u16.to_be_bytes());
        format4.extend_from_slice(&0xffffu16.to_be_bytes());
        // idDeltas[2]: segment 0 uses idRangeOffset (delta unused -> 0);
        // segment 1 (terminator) maps 0xffff -> 0 via delta=1 (0xffff+1 & 0xffff = 0).
        format4.extend_from_slice(&0i16.to_be_bytes());
        format4.extend_from_slice(&1i16.to_be_bytes());
        // idRangeOffsets[2]: segment 0's idRangeOffset is a byte offset
        // measured from the position of this slot itself (per the TrueType
        // spec's pointer-arithmetic convention) to the glyphIdArray start.
        // This is a 2-entry array (4 bytes); slot 0 is at the array's start,
        // so the distance to the array's end (where glyphIdArray begins) is
        // the full 4 bytes.
        format4.extend_from_slice(&4u16.to_be_bytes());
        format4.extend_from_slice(&0u16.to_be_bytes()); // segment 1 unused (delta path)
        // glyphIdArray: one entry for segment 0's single code point (0x41 - 0x41 = index 0) -> glyph 1.
        format4.extend_from_slice(&1u16.to_be_bytes());

        let mut cmap = Vec::new();
        cmap.extend_from_slice(&0u16.to_be_bytes()); // version
        cmap.extend_from_slice(&1u16.to_be_bytes()); // numTables
        cmap.extend_from_slice(&3u16.to_be_bytes()); // platformID 3 (Windows)
        cmap.extend_from_slice(&1u16.to_be_bytes()); // encodingID 1 (BMP)
        cmap.extend_from_slice(&12u32.to_be_bytes()); // subtable offset (right after this 12-byte header)
        cmap.extend_from_slice(&format4);

        // --- Table directory ---
        let tables: Vec<(&str, &[u8])> = vec![
            ("head", &head),
            ("hhea", &hhea),
            ("hmtx", &hmtx),
            ("cmap", &cmap),
        ];
        let mut out = Vec::new();
        out.extend_from_slice(&SFNT_VERSION_TRUETYPE.to_be_bytes());
        out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes()); // searchRange (unused)
        out.extend_from_slice(&0u16.to_be_bytes()); // entrySelector (unused)
        out.extend_from_slice(&0u16.to_be_bytes()); // rangeShift (unused)

        let directory_start = out.len();
        let directory_len = tables.len() * 16;
        let mut cursor = directory_start + directory_len;
        let mut directory = Vec::new();
        let mut body = Vec::new();
        for (tag, data) in &tables {
            directory.extend_from_slice(tag.as_bytes());
            directory.extend_from_slice(&0u32.to_be_bytes()); // checksum (unused)
            directory.extend_from_slice(&(cursor as u32).to_be_bytes());
            directory.extend_from_slice(&(data.len() as u32).to_be_bytes());
            body.extend_from_slice(data);
            cursor += data.len();
        }
        out.extend_from_slice(&directory);
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn parse_font_reads_head_hhea_line_metrics() {
        let bytes = build_minimal_font();
        let font = parse_font(&bytes).expect("minimal font must parse");
        assert_eq!(font.units_per_em(), 1000);
        assert_eq!(font.ascender(), 800);
        assert_eq!(font.descender(), -200);
        assert_eq!(font.line_gap(), 100);
    }

    #[test]
    fn parse_font_reads_hmtx_advance_widths_with_clamping() {
        let bytes = build_minimal_font();
        let font = parse_font(&bytes).unwrap();
        assert_eq!(font.advance_width_for_glyph(0), 500.0);
        assert_eq!(font.advance_width_for_glyph(1), 600.0);
        // glyph id beyond numberOfHMetrics clamps to the last hMetric record.
        assert_eq!(font.advance_width_for_glyph(9), 600.0);
    }

    #[test]
    fn parse_font_cmap_format4_maps_covered_and_uncovered_code_points() {
        let bytes = build_minimal_font();
        let font = parse_font(&bytes).unwrap();
        assert_eq!(font.glyph_id_for_code_point(0x41), 1); // 'A' -> glyph 1
        assert_eq!(font.glyph_id_for_code_point(0x42), 0); // 'B' uncovered -> .notdef
        assert_eq!(font.advance_width_for_code_point(0x41), 600.0);
        assert_eq!(font.advance_width_for_code_point(0x42), 500.0);
    }

    #[test]
    fn parse_font_with_no_gsub_gpos_leaves_ligatures_and_kerning_inert() {
        let bytes = build_minimal_font();
        let font = parse_font(&bytes).unwrap();
        assert_eq!(font.substitute_ligatures(&[1, 1]), vec![1, 1]);
        assert_eq!(font.pair_kerning(1, 1), 0.0);
    }

    #[test]
    fn parse_font_rejects_too_short_input() {
        let err = parse_font(&[0u8; 4]).unwrap_err();
        assert_eq!(err.message(), "font file is invalid or corrupted");
    }

    #[test]
    fn parse_font_rejects_woff_magic() {
        let mut bytes = vec![0u8; 12];
        bytes[0..4].copy_from_slice(&TAG_WOFF.to_be_bytes());
        let err = parse_font(&bytes).unwrap_err();
        assert_eq!(
            err.message(),
            "unsupported font format, requires TTF or OTF"
        );
    }

    #[test]
    fn parse_font_rejects_unknown_sfnt_version() {
        let mut bytes = vec![0u8; 12];
        bytes[0..4].copy_from_slice(&0xdeadbeefu32.to_be_bytes());
        let err = parse_font(&bytes).unwrap_err();
        assert_eq!(err.message(), "font file is invalid or corrupted");
    }

    #[test]
    fn parse_font_rejects_missing_required_table() {
        // Valid header, numTables=0 -> no head/hhea/hmtx/cmap at all.
        let mut bytes = vec![0u8; 12];
        bytes[0..4].copy_from_slice(&SFNT_VERSION_TRUETYPE.to_be_bytes());
        let err = parse_font(&bytes).unwrap_err();
        assert!(
            err.message()
                .contains("font file is missing required table")
        );
    }

    #[test]
    fn default_font_bytes_is_a_parseable_ttf() {
        // Confirms the include_bytes! path resolves correctly and the
        // bundled font really is a well-formed sfnt.
        let font = parse_font(DEFAULT_FONT_BYTES).expect("bundled default font must parse");
        assert!(font.units_per_em() > 0);
        assert_eq!(DEFAULT_FONT_FAMILY, "Noto Sans TC");
    }
}
