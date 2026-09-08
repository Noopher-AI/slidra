//! The splice primitives every pure mutation function in `element::edit`,
//! `element::group`, `element::arrange`, and `element::clipboard` builds its
//! output from. Ported from four near-identical copies TS keeps (in
//! `element-edit.ts`, `element-group.ts`, `element-arrange.ts`, and
//! `element-clipboard.ts`) into ONE — plan section 7, decision D6: TS
//! duplicates them because other tickets edit those four files in parallel
//! and the coordination cost of a shared module wasn't worth it there; all
//! four Rust modules are new, written by this ticket alone, so that reason
//! does not hold here.
//!
//! # UTF-16 offsets in, byte offsets out (read this before calling anything below)
//!
//! Every `Splice.start`/`.end` here is expected in the same **UTF-16
//! code-unit** space as `ScannedNode`/`ScannedAttribute`'s own
//! `start`/`end`/`content_start`/`content_end` fields (`slide::scan`'s
//! module doc — load-bearing, read it if this paragraph is surprising).
//! `apply_splices` is the ONLY place in this ticket's code that is allowed
//! to convert a UTF-16 offset to the Rust byte offset `String::replace_range`
//! actually needs (via `crate::text::utf16_offset_to_byte_offset`) — every
//! splice-builder below (`attribute_removal_splice`, `set_attr_splice`,
//! `build_transform_splice`) works ONLY in UTF-16 offsets and must never
//! slice `svg` itself. A caller that slices `svg` directly with a
//! `ScannedNode`/`ScannedAttribute` offset (as this ticket's own
//! `effects::remove_effects_targeting` did before this file existed — see
//! that module's fix in this same commit) silently corrupts any document
//! containing so much as one CJK character or emoji before the splice
//! point, because a UTF-16 offset and a UTF-8 byte offset only coincide for
//! purely-ASCII content.

use crate::errors::CoMotionResult;
use crate::geometry::transform::{
    TransformParts, decompose_matrix, format_transform, parse_transform,
};
use crate::slide::scan::{ScannedAttribute, ScannedNode, attribute_of};
use crate::text::{escape_xml_attr, utf16_offset_to_byte_offset};

/// One replacement over a UTF-16 offset span: `svg[start..end]` (UTF-16
/// units) becomes `text`. `start == end` is a pure insertion.
#[derive(Debug, Clone)]
pub struct Splice {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Applies every splice in `splices` to `svg` in one pass, highest UTF-16
/// offset first — so an earlier (in application order) splice's
/// start/end can never be invalidated by a length-changing splice applied
/// to a later region of the same string. Splices must not overlap.
///
/// Byte offsets are computed for every splice up front, against the
/// ORIGINAL (pre-mutation) `svg` — not re-derived after each replacement —
/// mirroring the TS original's own single up-front `.sort()` over
/// UTF-16 offsets that never change mid-loop. This is sound because
/// splices are applied widest-start-first: every splice still to be
/// applied has a smaller byte offset than the one just applied, so it
/// addresses a byte range that is still part of the untouched PREFIX of
/// the growing/shrinking result string, where the byte offsets computed
/// against the original string remain valid.
pub fn apply_splices(svg: &str, splices: &[Splice]) -> String {
    let mut byte_spans: Vec<(usize, usize, &str)> = splices
        .iter()
        .map(|splice| {
            (
                utf16_offset_to_byte_offset(svg, splice.start),
                utf16_offset_to_byte_offset(svg, splice.end),
                splice.text.as_str(),
            )
        })
        .collect();
    byte_spans.sort_by(|a, b| b.0.cmp(&a.0));

    let mut result = svg.to_string();
    for (start, end, text) in byte_spans {
        result.replace_range(start..end, text);
    }
    result
}

/// The leading whitespace before an attribute, so removing it also removes
/// the space that separated it from its neighbour. `container_start` is the
/// enclosing element's own `start` (a UTF-16 offset) — the floor this walk
/// never backs up past, so removing the first attribute never eats into the
/// element's opening `<tag`.
pub fn attribute_removal_splice(
    container_start: usize,
    svg: &str,
    attr: &ScannedAttribute,
) -> Splice {
    // `attr.start` is a UTF-16 offset, so each backward step must retreat
    // by one UTF-16 unit, not one byte — converting to a byte offset on
    // every step (rather than once, up front) is what lets this ask "what
    // character is immediately before `start`" correctly even when earlier
    // parts of `svg` contain multi-byte or astral characters.
    let mut start = attr.start;
    while start > container_start {
        let byte_at = utf16_offset_to_byte_offset(svg, start - 1);
        let ch = svg[byte_at..].chars().next().expect("valid char boundary");
        if matches!(ch, '\t' | '\n' | '\r' | ' ') {
            start -= ch.len_utf16();
        } else {
            break;
        }
    }
    Splice {
        start,
        end: attr.end,
        text: String::new(),
    }
}

/// Replaces `attr`'s value on `node` if present, or inserts it right after
/// the tag name if absent. Mirrors `element-text.ts`'s `setAttrSplice`.
pub fn set_attr_splice(node: &ScannedNode, attr: &str, value: &str) -> Splice {
    if let Some(existing) = attribute_of(node, attr) {
        return Splice {
            start: existing.start,
            end: existing.end,
            text: format!("{attr}=\"{}\"", escape_xml_attr(value)),
        };
    }
    // `node.start` is a UTF-16 offset; `1 + node.tag.len()` (the length of
    // `<` plus the tag name) must therefore be counted in UTF-16 units, not
    // Rust bytes — `node.tag` is ASCII in every case this crate scans (SVG
    // and `comot:*` tag names), so `.len()` (bytes) and UTF-16 length
    // coincide here, but `.encode_utf16().count()` is used anyway so this
    // is correct even if that ever stops being true.
    let insert_at = node.start + 1 + node.tag.encode_utf16().count();
    Splice {
        start: insert_at,
        end: insert_at,
        text: format!(" {attr}=\"{}\"", escape_xml_attr(value)),
    }
}

/// Builds the splice that rewrites `container`'s `transform` attribute
/// after applying `mutate` to its decomposed parts — inserting the
/// attribute if it was absent, or removing it if the mutated parts
/// serialize back to the empty string (identity transform). Mirrors
/// `element-edit.ts`'s `buildTransformSplice` / `element-group.ts`'s
/// `setTransformSplice` (the two were byte-identical; this is the one copy).
///
/// `Err` when the container's existing `transform` cannot be parsed or
/// decomposed (malformed value, skew, a degenerate/zero-scale matrix) —
/// `parse_transform`/`decompose_matrix` are themselves fallible (plan
/// section 3.4's move/rotate contract row: "目標既有的 transform 含傾斜…
/// 無法拆解" is exactly this path surfacing).
pub fn build_transform_splice(
    svg: &str,
    container: &ScannedNode,
    mutate: impl FnOnce(TransformParts) -> TransformParts,
) -> CoMotionResult<Splice> {
    let attr = attribute_of(container, "transform");
    let matrix = parse_transform(attr.map(|a| a.value.as_str()))?;
    let next_parts = mutate(decompose_matrix(&matrix)?);
    let next_transform = format_transform(&next_parts);

    if let Some(attr) = attr {
        if next_transform.is_empty() {
            return Ok(attribute_removal_splice(container.start, svg, attr));
        }
        return Ok(Splice {
            start: attr.start,
            end: attr.end,
            text: format!("transform=\"{next_transform}\""),
        });
    }
    if next_transform.is_empty() {
        return Ok(Splice {
            start: container.start,
            end: container.start,
            text: String::new(),
        });
    }
    let insert_at = container.start + 1 + container.tag.encode_utf16().count();
    Ok(Splice {
        start: insert_at,
        end: insert_at,
        text: format!(" transform=\"{next_transform}\""),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slide::scan::scan_document;

    #[test]
    fn apply_splices_applies_widest_start_first_without_invalidating_earlier_offsets() {
        let svg = r#"<svg><a id="1"/><b id="2"/></svg>"#;
        let roots = scan_document(svg).unwrap();
        let svg_root = &roots[0];
        let a = &svg_root.children[0];
        let b = &svg_root.children[1];
        let updated = apply_splices(
            svg,
            &[
                Splice {
                    start: a.start,
                    end: a.end,
                    text: "<a id=\"A\"/>".to_string(),
                },
                Splice {
                    start: b.start,
                    end: b.end,
                    text: "<b id=\"B\"/>".to_string(),
                },
            ],
        );
        assert_eq!(updated, r#"<svg><a id="A"/><b id="B"/></svg>"#);
    }

    /// The load-bearing case: a splice whose target sits AFTER a CJK
    /// character earlier in the document must land on the right bytes.
    /// Each CJK character here is 1 UTF-16 unit but 3 UTF-8 bytes, so a
    /// byte-offset bug (treating `node.start`/`.end` as bytes) would apply
    /// this splice several bytes too early and corrupt the markup — this
    /// test fails loudly under that bug and passes under the correct
    /// UTF-16-aware conversion.
    #[test]
    fn apply_splices_handles_a_target_after_leading_cjk_text() {
        let svg = r#"<svg><text>投影片標題</text><g id="1"/></svg>"#;
        let roots = scan_document(svg).unwrap();
        let svg_root = &roots[0];
        let target = &svg_root.children[1];
        assert_eq!(target.tag, "g");
        let updated = apply_splices(
            svg,
            &[Splice {
                start: target.start,
                end: target.end,
                text: "<g id=\"REPLACED\"/>".to_string(),
            }],
        );
        assert_eq!(
            updated,
            r#"<svg><text>投影片標題</text><g id="REPLACED"/></svg>"#
        );
    }

    #[test]
    fn set_attr_splice_inserts_after_tag_name_when_absent() {
        let svg = r#"<g><rect/></g>"#;
        let roots = scan_document(svg).unwrap();
        let node = &roots[0];
        let splice = set_attr_splice(node, "data-comot-lock", "true");
        let updated = apply_splices(svg, &[splice]);
        assert_eq!(updated, r#"<g data-comot-lock="true"><rect/></g>"#);
    }

    #[test]
    fn set_attr_splice_replaces_existing_value() {
        let svg = r#"<g data-comot-lock="false"><rect/></g>"#;
        let roots = scan_document(svg).unwrap();
        let node = &roots[0];
        let splice = set_attr_splice(node, "data-comot-lock", "true");
        let updated = apply_splices(svg, &[splice]);
        assert_eq!(updated, r#"<g data-comot-lock="true"><rect/></g>"#);
    }

    #[test]
    fn attribute_removal_splice_also_removes_the_leading_space() {
        let svg = r#"<g id="x" data-comot-lock="true"><rect/></g>"#;
        let roots = scan_document(svg).unwrap();
        let node = &roots[0];
        let attr = attribute_of(node, "data-comot-lock").unwrap();
        let splice = attribute_removal_splice(node.start, svg, attr);
        let updated = apply_splices(svg, &[splice]);
        assert_eq!(updated, r#"<g id="x"><rect/></g>"#);
    }

    #[test]
    fn build_transform_splice_inserts_when_absent_and_removes_when_identity() {
        let svg = r#"<g id="x"><rect/></g>"#;
        let roots = scan_document(svg).unwrap();
        let node = &roots[0];
        let inserted = build_transform_splice(svg, node, |mut parts| {
            parts.translate_x += 10.0;
            parts
        })
        .unwrap();
        let updated = apply_splices(svg, &[inserted]);
        // Inserted right after the tag name (`<g`), same as every other
        // TS/Rust attribute-insertion splice in this crate — BEFORE any
        // attribute that was already there, not appended after it.
        assert_eq!(
            updated,
            r#"<g transform="translate(10 0)" id="x"><rect/></g>"#
        );

        let roots2 = scan_document(&updated).unwrap();
        let node2 = &roots2[0];
        let removed = build_transform_splice(&updated, node2, |mut parts| {
            parts.translate_x -= 10.0;
            parts
        })
        .unwrap();
        let back = apply_splices(&updated, &[removed]);
        assert_eq!(back, svg);
    }
}
