//! `Splice`/`applySplices`/`resolveFont`, ported from
//! `packages/core/src/element-text.ts`. That TS file's *other* contents
//! (text-box measurement/rewrap, run styling, list handling) belong to F4
//! (NOOP-280) — only these three pieces are this ticket's, because the
//! chart/table write paths (`chart/edit.ts`, `table/edit.ts`) both splice
//! their container's data/markup children directly and `table/edit.ts`'s
//! cell text also needs `resolveFont` to re-measure/wrap a cell's `<text>`.
//! Living at the crate root (not under `text/`) mirrors why `svgnum.rs`
//! does: `Splice`/`apply_splices` are markup-splicing primitives, not
//! text-measurement ones, and F4 — not this ticket — owns growing this
//! file (or moving it) further.

use crate::errors::CoMotionError;
use crate::text::FontMetrics;
use crate::text::runs::utf16_offset_to_byte_offset;
use std::collections::HashMap;

/// A range replacement against an SVG source string: `[start, end)` is
/// replaced with `text`. Ported from `element-text.ts`'s `Splice`
/// interface. `start`/`end` are **UTF-16 code-unit offsets** — the same
/// index space `ScannedNode.start`/`.end`/`.content_start`/`.content_end`
/// use (see `slide/scan.rs`'s module doc, "The UTF-16 index space"), which
/// is where every caller's `start`/`end` values come from. This is NOT the
/// Rust byte offset a `&str` slices by — `apply_splices` converts before
/// slicing (see its own doc comment) precisely so callers can pass a
/// `ScannedNode` field straight through without a conversion step of their
/// own at every call site.
#[derive(Debug, Clone)]
pub struct Splice {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Applies every splice in `splices` to `svg` in one pass, highest offset
/// first — so an earlier splice's start/end offsets are never invalidated
/// by a length-changing splice applied to a later region of the same
/// string. Splices must not overlap (the caller's responsibility, exactly
/// as in the TS original).
///
/// `start`/`end` are UTF-16 code-unit offsets (see `Splice`'s doc comment)
/// — converted to Rust byte offsets via `utf16_offset_to_byte_offset`
/// before any slicing, since a `&str` is byte-indexed. Skipping this
/// conversion silently corrupts every document containing a CJK or astral
/// character before a splice point (a 3-byte UTF-8 CJK character is one
/// UTF-16 code unit but three UTF-8 bytes) — confirmed by hand against a
/// real corrupted-output repro during this ticket's manual verification,
/// not a hypothetical.
pub fn apply_splices(svg: &str, splices: &[Splice]) -> String {
    let mut ordered: Vec<&Splice> = splices.iter().collect();
    ordered.sort_by(|a, b| b.start.cmp(&a.start));

    let bytes = svg.as_bytes();
    let mut result = bytes.to_vec();
    for splice in ordered {
        let start = utf16_offset_to_byte_offset(svg, splice.start);
        let end = utf16_offset_to_byte_offset(svg, splice.end);
        let mut next = Vec::with_capacity(result.len());
        next.extend_from_slice(&result[..start]);
        next.extend_from_slice(splice.text.as_bytes());
        next.extend_from_slice(&result[end..]);
        result = next;
    }
    String::from_utf8(result).expect("splices only ever cut at UTF-8-safe boundaries")
}

/// Resolves `font_family` in `fonts`, throwing the same "缺少字型" error
/// every text-box measurement call uses on a miss. Ported from
/// `element-text.ts`'s exported `resolveFont`, used here by the table
/// write path (`table/edit.rs`) to re-measure/wrap a cell's text.
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
    fn apply_splices_replaces_highest_offset_first() {
        let svg = "<a>AAAA</a><b>BBBB</b>";
        let splices = vec![
            Splice {
                start: 3,
                end: 7,
                text: "X".to_string(),
            },
            Splice {
                start: 14,
                end: 18,
                text: "YY".to_string(),
            },
        ];
        assert_eq!(apply_splices(svg, &splices), "<a>X</a><b>YY</b>");
    }

    #[test]
    fn apply_splices_with_no_splices_returns_input_unchanged() {
        assert_eq!(apply_splices("<svg></svg>", &[]), "<svg></svg>");
    }

    #[test]
    fn apply_splices_insertion_splice_with_equal_start_and_end() {
        let svg = "<a></a>";
        let splices = vec![Splice {
            start: 3,
            end: 3,
            text: "INSERTED".to_string(),
        }];
        assert_eq!(apply_splices(svg, &splices), "<a>INSERTED</a>");
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
