//! Speaker notes (`slide notes set`): a pure string -> string splice — every
//! other byte of `svg_content` is preserved exactly. Notes live in the same
//! `<metadata>` a slide's `<slidra:effects>`/`<slidra:transition>` use, as
//! `<slidra:notes>`.

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::scan::{ScannedNode, attribute_of, scan_document};
use crate::text::escape::escape_xml_text;
use crate::text::runs::utf16_offset_to_byte_offset;

const NOTES_TAG: &str = "slidra:notes";
const METADATA_TAG: &str = "metadata";
/// Same namespace URI `<slidra:effects>`/`<slidra:transition>` bind — an
/// unbound `slidra:` prefix is a fatal XML parse error, not a tolerated one.
pub const NOTES_NS: &str = "https://slidra.app/ns/2026";

fn require_svg_root(roots: Vec<ScannedNode>) -> SlidraResult<ScannedNode> {
    roots
        .into_iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("投影片的根節點不是 <svg>"))
}

/// Sets a slide's speaker notes to `text` (`slidra slide notes set`).
/// Creates `<metadata>` as the `<svg>`'s first child when absent; appends
/// `<slidra:notes>` to an existing `<metadata>` when it has none yet (leaving
/// any existing `<slidra:effects>`/`<slidra:transition>` untouched); replaces
/// the content of an existing `<slidra:notes>` otherwise. An empty `text` is a
/// legal way to clear the notes — it writes `<slidra:notes></slidra:notes>`,
/// never removes the element and never errors.
pub fn set_slide_notes(svg_content: &str, text: &str) -> SlidraResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(roots)?;
    let escaped = escape_xml_text(text);

    let metadata = svg_root
        .children
        .iter()
        .find(|child| child.tag == METADATA_TAG);
    let Some(metadata) = metadata else {
        let markup = format!(
            "<{METADATA_TAG}><{NOTES_TAG} xmlns:slidra=\"{NOTES_NS}\">{escaped}</{NOTES_TAG}></{METADATA_TAG}>"
        );
        let insert_at = utf16_offset_to_byte_offset(svg_content, svg_root.content_start);
        return Ok(format!(
            "{}{}{}",
            &svg_content[..insert_at],
            markup,
            &svg_content[insert_at..]
        ));
    };

    let notes = metadata
        .children
        .iter()
        .find(|child| child.tag == NOTES_TAG);
    let Some(notes) = notes else {
        let markup = format!("<{NOTES_TAG} xmlns:slidra=\"{NOTES_NS}\">{escaped}</{NOTES_TAG}>");
        let insert_at = utf16_offset_to_byte_offset(svg_content, metadata.content_start);
        return Ok(format!(
            "{}{}{}",
            &svg_content[..insert_at],
            markup,
            &svg_content[insert_at..]
        ));
    };

    // A `<slidra:notes>` written without this namespace (or with the wrong
    // one) would parse fine here — this scanner doesn't validate namespaces
    // — but produce a fatal parse error the moment a namespace-aware
    // consumer reads it. Rewrite the open tag along with the content so
    // every write leaves the element namespace-valid, not just freshly
    // created ones.
    let has_correct_ns =
        attribute_of(notes, "xmlns:slidra").map(|a| a.value.as_str()) == Some(NOTES_NS);
    if !has_correct_ns {
        let markup = format!("<{NOTES_TAG} xmlns:slidra=\"{NOTES_NS}\">{escaped}");
        let start = utf16_offset_to_byte_offset(svg_content, notes.start);
        let end = utf16_offset_to_byte_offset(svg_content, notes.content_end);
        return Ok(format!(
            "{}{}{}",
            &svg_content[..start],
            markup,
            &svg_content[end..]
        ));
    }

    let start = utf16_offset_to_byte_offset(svg_content, notes.content_start);
    let end = utf16_offset_to_byte_offset(svg_content, notes.content_end);
    Ok(format!(
        "{}{}{}",
        &svg_content[..start],
        escaped,
        &svg_content[end..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLANK_SVG: &str =
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>\n";

    /// Has a real child (`<g id="el-a"/>`) so `content_start` (before it) and
    /// `content_end` (after it, before `</svg>`) are distinct byte offsets —
    /// `BLANK_SVG` above has none, so both offsets collapse to the same
    /// point and a `starts_with`/`contains` assertion on it cannot tell a
    /// "first child" insert from a "last child" one apart (confirmed by
    /// mutating the insertion point to `content_end`: `cargo test` still
    /// passed). Mirrors real slides — `demo/slides/001.svg`/`002.svg` have
    /// no `<metadata>` but do have sibling content — so this is the
    /// production-shaped case, not an edge case.
    const SVG_WITH_CHILD: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><g id=\"el-a\"/></svg>\n";

    #[test]
    fn creates_metadata_as_first_child_when_absent() {
        let updated = set_slide_notes(SVG_WITH_CHILD, "hello").unwrap();
        assert_eq!(
            updated,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\">hello</slidra:notes></metadata><g id=\"el-a\"/></svg>\n"
        );
    }

    #[test]
    fn empty_text_writes_empty_element_not_error() {
        let updated = set_slide_notes(BLANK_SVG, "").unwrap();
        assert!(
            updated.contains(
                "<slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\"></slidra:notes>"
            )
        );
    }

    #[test]
    fn escapes_special_characters() {
        let updated = set_slide_notes(BLANK_SVG, "a < b & c > d").unwrap();
        assert!(updated.contains("a &lt; b &amp; c &gt; d"));
    }

    #[test]
    fn replaces_existing_notes_content_leaving_effects_untouched() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:effects xmlns:slidra=\"https://slidra.app/ns/2026\"></slidra:effects><slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\">old</slidra:notes></metadata></svg>\n";
        let updated = set_slide_notes(svg, "new").unwrap();
        assert!(updated.contains(
            "<slidra:effects xmlns:slidra=\"https://slidra.app/ns/2026\"></slidra:effects>"
        ));
        assert!(updated.contains(
            "<slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\">new</slidra:notes>"
        ));
        assert!(!updated.contains(">old<"));
    }

    #[test]
    fn inserts_notes_at_the_start_of_existing_metadata_before_effects() {
        // Inserted at `metadata.content_start` — i.e. prepended, not
        // appended after existing children (matches `setSlideTransition`'s
        // same insertion point for a sibling `<slidra:*>` element).
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:effects xmlns:slidra=\"https://slidra.app/ns/2026\"></slidra:effects></metadata></svg>\n";
        let updated = set_slide_notes(svg, "note").unwrap();
        assert!(updated.contains(
            "<slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\">note</slidra:notes><slidra:effects xmlns:slidra=\"https://slidra.app/ns/2026\"></slidra:effects>"
        ));
    }

    #[test]
    fn missing_svg_root_errors() {
        let err = set_slide_notes("<g id=\"a\"/>", "x").unwrap_err();
        assert!(err.message().contains("根節點不是 <svg>"));
    }

    #[test]
    fn cjk_content_before_insertion_point_uses_correct_offset() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><text>中文標題</text></svg>\n";
        let updated = set_slide_notes(svg, "note").unwrap();
        assert!(updated.contains("<text>中文標題</text>"));
        assert!(updated.contains(
            "<slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\">note</slidra:notes>"
        ));
    }
}
