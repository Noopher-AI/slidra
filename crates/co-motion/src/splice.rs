//! `Splice`/`apply_splices`/`set_attr_splice`, ported from
//! `packages/core/src/element-text.ts`'s splice primitives (the subset this
//! ticket needs: `Splice`, `applySplices`, `setAttrSplice`). Every slide
//! mutation in this ticket (notes/transition/style/canvas/normalise) is a
//! byte-range replacement against the raw SVG string, never a
//! parse-then-re-serialize — this is the shared plumbing for that.
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
//! same treatment).

use crate::slide::scan::{ScannedNode, attribute_of};
use crate::text::escape::escape_xml_attr;
use crate::text::runs::utf16_offset_to_byte_offset;

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
}
