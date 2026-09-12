//! `Splice`/`apply_splices`/`set_attr_splice`/`resolve_font`, ported from
//! `packages/core/src/element-text.ts`'s splice primitives (`Splice`,
//! `applySplices`, `setAttrSplice`, `resolveFont`). Every slide mutation in
//! the F4 ticket (notes/transition/style/canvas/normalise) is a byte-range
//! replacement against the raw SVG string, never a parse-then-re-serialize —
//! this is the shared plumbing for that. The chart/table write paths
//! (`chart/edit.rs`, `table/edit.rs`) reuse the same `Splice`/`apply_splices`
//! plumbing for their own container-level splices, and `table/layout.rs`
//! uses `resolve_font` to re-measure/wrap a cell's `<text>`.
//!
//! `Splice.start`/`end` here are always Rust **byte** offsets — the opposite
//! convention from `slide::scan::ScannedNode`/`ScannedAttribute`, whose
//! offsets are UTF-16 code-unit offsets (see that module's doc comment).
//! `set_attr_splice` below takes the source `svg` string precisely so it can
//! convert a scanned node/attribute's UTF-16 offsets to byte offsets via
//! `crate::text::runs::utf16_offset_to_byte_offset` before building the
//! `Splice` — every caller of `apply_splices` in this crate must have
//! already done the same conversion for any splice it builds by hand
//! (notes/transition/style all insert at a `content_start`, which needs the
//! same treatment; so does `chart/edit.rs`'s `splice_chart_element`).

use crate::errors::CoMotionError;
use crate::slide::scan::{ScannedNode, attribute_of};
use crate::text::FontMetrics;
use crate::text::escape::escape_xml_attr;
use crate::text::runs::utf16_offset_to_byte_offset;
use std::collections::HashMap;

/// A byte-range replacement against an SVG string: `[start, end)` is
/// replaced with `text`. Offsets are Rust byte offsets — see module doc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Splice {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Applies every splice in `splices` to `svg` in one pass, highest offset
/// first — so an earlier splice's start/end offsets are never invalidated by
/// a length-changing splice applied to a later region of the same string.
/// Splices must not overlap.
pub fn apply_splices(svg: &str, splices: &[Splice]) -> String {
    let mut sorted: Vec<&Splice> = splices.iter().collect();
    sorted.sort_by(|a, b| b.start.cmp(&a.start));
    let mut result = svg.to_string();
    for splice in sorted {
        result = format!(
            "{}{}{}",
            &result[..splice.start],
            splice.text,
            &result[splice.end..]
        );
    }
    result
}

/// Replaces `attr`'s value on `node` if present, or inserts it right after
/// the tag name if absent. `svg` is the document `node` was scanned from —
/// needed to convert `node`/the attribute's UTF-16 offsets to the byte
/// offsets this module's `Splice` uses (see module doc comment).
pub fn set_attr_splice(svg: &str, node: &ScannedNode, attr: &str, value: &str) -> Splice {
    if let Some(existing) = attribute_of(node, attr) {
        Splice {
            start: utf16_offset_to_byte_offset(svg, existing.start),
            end: utf16_offset_to_byte_offset(svg, existing.end),
            text: format!("{attr}=\"{}\"", escape_xml_attr(value)),
        }
    } else {
        // `node.tag` is always ASCII (an SVG tag name), so its UTF-16 length
        // and byte length agree — safe to add after converting `node.start`
        // alone to a byte offset.
        let insert_at = utf16_offset_to_byte_offset(svg, node.start) + 1 + node.tag.len();
        Splice {
            start: insert_at,
            end: insert_at,
            text: format!(" {attr}=\"{}\"", escape_xml_attr(value)),
        }
    }
}

/// Resolves `font_family` in `fonts`, throwing the same "缺少字型" error
/// every text-box measurement call uses on a miss. Used here by the table
/// write path (`table/layout.rs`) to re-measure/wrap a cell's text.
pub fn resolve_font<'a>(
    fonts: &'a HashMap<String, crate::text::font::ParsedFont>,
    font_family: &str,
    element_id: &str,
) -> Result<&'a dyn FontMetrics, CoMotionError> {
    match fonts.get(font_family) {
        Some(font) => Ok(font as &dyn FontMetrics),
        None => Err(CoMotionError::invalid(format!(
            "簡報未內嵌字型 {font_family}，無法重新換行：{element_id}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_splices_replaces_in_reverse_offset_order() {
        let result = apply_splices(
            "ABCDEF",
            &[
                Splice {
                    start: 0,
                    end: 1,
                    text: "x".to_string(),
                },
                Splice {
                    start: 4,
                    end: 5,
                    text: "y".to_string(),
                },
            ],
        );
        assert_eq!(result, "xBCDyF");
    }

    #[test]
    fn apply_splices_with_no_splices_is_identity() {
        assert_eq!(apply_splices("ABC", &[]), "ABC");
    }

    #[test]
    fn apply_splices_can_insert_at_a_zero_width_point() {
        let result = apply_splices(
            "AB",
            &[Splice {
                start: 1,
                end: 1,
                text: "X".to_string(),
            }],
        );
        assert_eq!(result, "AXB");
    }

    #[test]
    fn resolve_font_missing_family_reports_element_id() {
        let fonts = HashMap::new();
        // `&dyn FontMetrics` has no `Debug` impl, so `unwrap_err()` (which
        // requires the `Ok` side to be `Debug`) can't be used here.
        match resolve_font(&fonts, "Missing Family", "el-abc123") {
            Err(err) => assert_eq!(
                err.message(),
                "簡報未內嵌字型 Missing Family，無法重新換行：el-abc123"
            ),
            Ok(_) => panic!("expected an error"),
        }
    }
}
