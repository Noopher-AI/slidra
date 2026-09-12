//! Author comments pinned to an element or a whole slide (ADR-0008, plan
//! section 1.1, phase P8). Ported from `packages/core/src/slide/comments.ts`
//! (166 lines, in full) — a pure `svg_content: &str -> String` splice,
//! modeled on the same `<metadata>` shape `<comot:effects>`/`<comot:notes>`
//! already use. Every other byte of `svg_content` is preserved exactly.
//!
//! `escape_xml_text`/`unescape_xml_text`/`escape_xml_attr` are their own
//! copies here, not reused from `crate::text::escape` — mirroring the TS
//! original's own duplication (that file's comment names it a deliberate,
//! not-this-ticket's-scope, consolidation opportunity: [E2.T8]'s plan scope
//! boundary #9).

use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};

fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unescape_xml_text(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn escape_xml_attr(value: &str) -> String {
    escape_xml_text(value).replace('"', "&quot;")
}

const COMMENTS_TAG: &str = "comot:comments";
const COMMENT_TAG: &str = "comot:comment";
const METADATA_TAG: &str = "metadata";
/// Same namespace URI `<comot:notes>`/`<comot:effects>` bind.
const COMMENTS_NS: &str = "https://co-motion.dev/ns";

#[derive(Debug, Clone, PartialEq)]
pub struct SlideComment {
    pub id: String,
    /// An element id, or the literal string `"page"`.
    pub target: String,
    pub author: String,
    /// ISO 8601.
    pub created: String,
    pub text: String,
}

fn require_svg_root(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
}

fn find_comments_list(svg_root: &ScannedNode) -> Option<&ScannedNode> {
    let metadata = svg_root.children.iter().find(|c| c.tag == METADATA_TAG)?;
    metadata.children.iter().find(|c| c.tag == COMMENTS_TAG)
}

fn read_comment(node: &ScannedNode, svg_content: &str) -> CoMotionResult<SlideComment> {
    let id = attribute_value(node, "id");
    let target = attribute_value(node, "target");
    let author = attribute_value(node, "author");
    let created = attribute_value(node, "created");
    let (Some(id), Some(target), Some(author), Some(created)) = (id, target, author, created)
    else {
        return Err(CoMotionError::invalid("留言缺少必要屬性"));
    };
    let raw = crate::text::runs::utf16_slice(svg_content, node.content_start, node.content_end);
    Ok(SlideComment {
        id,
        target,
        author,
        created,
        text: unescape_xml_text(&raw),
    })
}

/// Reads out a slide's comments in document order. A missing `<metadata>`,
/// a missing `<comot:comments>`, and an empty list all read the same: `[]`.
pub fn read_slide_comments(svg_content: &str) -> CoMotionResult<Vec<SlideComment>> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let Some(list) = find_comments_list(svg_root) else {
        return Ok(Vec::new());
    };
    list.children
        .iter()
        .filter(|c| c.tag == COMMENT_TAG)
        .map(|c| read_comment(c, svg_content))
        .collect()
}

fn serialize_comment(comment: &SlideComment) -> String {
    format!(
        "<{COMMENT_TAG} id=\"{}\" target=\"{}\" author=\"{}\" created=\"{}\">{}</{COMMENT_TAG}>",
        escape_xml_attr(&comment.id),
        escape_xml_attr(&comment.target),
        escape_xml_attr(&comment.author),
        escape_xml_attr(&comment.created),
        escape_xml_text(&comment.text)
    )
}

fn splice_insert(svg: &str, utf16_offset: usize, text: &str) -> String {
    let byte_offset = crate::text::utf16_offset_to_byte_offset(svg, utf16_offset);
    format!("{}{}{}", &svg[..byte_offset], text, &svg[byte_offset..])
}

/// Appends `comment` to the end of `<comot:comments>`; creates `<metadata>`
/// and/or `<comot:comments>` as needed. `id`/`created` are given by the
/// caller (injectable, for deterministic tests) — this function never mints
/// either.
pub fn add_slide_comment(svg_content: &str, comment: &SlideComment) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let markup = serialize_comment(comment);

    let Some(metadata) = svg_root.children.iter().find(|c| c.tag == METADATA_TAG) else {
        let wrapped = format!(
            "<{METADATA_TAG}><{COMMENTS_TAG} xmlns:comot=\"{COMMENTS_NS}\">{markup}</{COMMENTS_TAG}></{METADATA_TAG}>"
        );
        return Ok(splice_insert(svg_content, svg_root.content_start, &wrapped));
    };

    let Some(list) = metadata.children.iter().find(|c| c.tag == COMMENTS_TAG) else {
        let wrapped =
            format!("<{COMMENTS_TAG} xmlns:comot=\"{COMMENTS_NS}\">{markup}</{COMMENTS_TAG}>");
        return Ok(splice_insert(svg_content, metadata.content_start, &wrapped));
    };

    // A `<comot:comments>` written without this namespace declaration would
    // parse fine via this scanner but throw the moment a namespace-aware
    // consumer (e.g. a browser `DOMParser`) reads it. Rewrite the open tag
    // along with the content so every write leaves the element
    // namespace-valid.
    if attribute_of(list, "xmlns:comot").map(|a| a.value.as_str()) != Some(COMMENTS_NS) {
        let existing_content =
            crate::text::runs::utf16_slice(svg_content, list.content_start, list.content_end);
        let rewritten =
            format!("<{COMMENTS_TAG} xmlns:comot=\"{COMMENTS_NS}\">{existing_content}{markup}");
        let start_byte = crate::text::utf16_offset_to_byte_offset(svg_content, list.start);
        let end_byte = crate::text::utf16_offset_to_byte_offset(svg_content, list.content_end);
        return Ok(format!(
            "{}{}{}",
            &svg_content[..start_byte],
            rewritten,
            &svg_content[end_byte..]
        ));
    }

    Ok(splice_insert(svg_content, list.content_end, &markup))
}

fn find_comment<'a>(
    svg_root: &'a ScannedNode,
    comment_id: &str,
) -> CoMotionResult<&'a ScannedNode> {
    let list = find_comments_list(svg_root);
    let found = list.and_then(|list| {
        list.children.iter().find(|c| {
            c.tag == COMMENT_TAG && attribute_value(c, "id").as_deref() == Some(comment_id)
        })
    });
    found.ok_or_else(|| CoMotionError::not_found(format!("找不到留言：{comment_id}")))
}

/// Replaces `comment_id`'s content. `created` is left untouched. Unknown
/// `comment_id` -> `CoMotionError::NotFound` (maps to `FailureKind::NotFound`,
/// not `Failed` — table E of the plan).
pub fn edit_slide_comment(
    svg_content: &str,
    comment_id: &str,
    text: &str,
) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let comment = find_comment(svg_root, comment_id)?;
    let start_byte = crate::text::utf16_offset_to_byte_offset(svg_content, comment.content_start);
    let end_byte = crate::text::utf16_offset_to_byte_offset(svg_content, comment.content_end);
    Ok(format!(
        "{}{}{}",
        &svg_content[..start_byte],
        escape_xml_text(text),
        &svg_content[end_byte..]
    ))
}

/// Removes `comment_id`. Removing the last comment in a list leaves an
/// empty `<comot:comments></comot:comments>` behind — the container is
/// never deleted. Unknown `comment_id` -> `CoMotionError::NotFound`.
pub fn delete_slide_comment(svg_content: &str, comment_id: &str) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let comment = find_comment(svg_root, comment_id)?;
    let start_byte = crate::text::utf16_offset_to_byte_offset(svg_content, comment.start);
    let end_byte = crate::text::utf16_offset_to_byte_offset(svg_content, comment.end);
    Ok(format!(
        "{}{}",
        &svg_content[..start_byte],
        &svg_content[end_byte..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slide(children: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">{children}</svg>"#
        )
    }

    fn comment(id: &str, target: &str, author: &str, created: &str, text: &str) -> SlideComment {
        SlideComment {
            id: id.to_string(),
            target: target.to_string(),
            author: author.to_string(),
            created: created.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn read_slide_comments_returns_empty_for_no_metadata_no_list_and_empty_list() {
        assert_eq!(read_slide_comments(&slide("")).unwrap(), Vec::new());
        assert_eq!(
            read_slide_comments(&slide("<metadata></metadata>")).unwrap(),
            Vec::new()
        );
        assert_eq!(
            read_slide_comments(&slide(&format!(
                r#"<metadata><comot:comments xmlns:comot="{COMMENTS_NS}"></comot:comments></metadata>"#
            )))
            .unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn add_then_read_round_trips_with_no_existing_metadata() {
        let svg = slide("<g id=\"el-a\"><rect x=\"0\" y=\"0\" width=\"1\" height=\"1\"/></g>");
        let c = comment(
            "c-1",
            "el-a",
            "agent",
            "2026-01-01T00:00:00.000Z",
            "hi <there> & bye",
        );
        let updated = add_slide_comment(&svg, &c).unwrap();
        let read_back = read_slide_comments(&updated).unwrap();
        assert_eq!(read_back, vec![c]);
    }

    #[test]
    fn add_appends_to_an_existing_list_in_document_order() {
        let svg = slide(&format!(
            r#"<metadata><comot:comments xmlns:comot="{COMMENTS_NS}"><comot:comment id="c-1" target="page" author="agent" created="2026-01-01T00:00:00.000Z">first</comot:comment></comot:comments></metadata>"#
        ));
        let c2 = comment("c-2", "page", "agent", "2026-01-02T00:00:00.000Z", "second");
        let updated = add_slide_comment(&svg, &c2).unwrap();
        let read_back = read_slide_comments(&updated).unwrap();
        assert_eq!(read_back.len(), 2);
        assert_eq!(read_back[0].id, "c-1");
        assert_eq!(read_back[1].id, "c-2");
    }

    #[test]
    fn add_rewrites_a_comments_list_missing_the_namespace_declaration() {
        // Written by a hypothetical older/foreign tool without the
        // `xmlns:comot` declaration — a namespace-aware consumer would
        // choke on this even though this scanner reads it fine.
        let svg = slide(
            r#"<metadata><comot:comments><comot:comment id="c-1" target="page" author="agent" created="2026-01-01T00:00:00.000Z">first</comot:comment></comot:comments></metadata>"#,
        );
        let c2 = comment("c-2", "page", "agent", "2026-01-02T00:00:00.000Z", "second");
        let updated = add_slide_comment(&svg, &c2).unwrap();
        assert!(updated.contains(&format!(r#"<comot:comments xmlns:comot="{COMMENTS_NS}">"#)));
        let read_back = read_slide_comments(&updated).unwrap();
        assert_eq!(read_back.len(), 2);
    }

    #[test]
    fn escapes_and_unescapes_text_content_through_a_round_trip() {
        let svg = slide("");
        let c = comment(
            "c-1",
            "page",
            "agent",
            "2026-01-01T00:00:00.000Z",
            "a < b & c > d",
        );
        let updated = add_slide_comment(&svg, &c).unwrap();
        assert!(updated.contains("a &lt; b &amp; c &gt; d"));
        let read_back = read_slide_comments(&updated).unwrap();
        assert_eq!(read_back[0].text, "a < b & c > d");
    }

    #[test]
    fn edit_replaces_content_and_leaves_created_untouched() {
        let svg = slide(&format!(
            r#"<metadata><comot:comments xmlns:comot="{COMMENTS_NS}"><comot:comment id="c-1" target="page" author="agent" created="2026-01-01T00:00:00.000Z">old</comot:comment></comot:comments></metadata>"#
        ));
        let updated = edit_slide_comment(&svg, "c-1", "new text").unwrap();
        let read_back = read_slide_comments(&updated).unwrap();
        assert_eq!(read_back[0].text, "new text");
        assert_eq!(read_back[0].created, "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn edit_unknown_comment_id_is_not_found() {
        let svg = slide("");
        let err = edit_slide_comment(&svg, "c-nope", "x").unwrap_err();
        assert_eq!(err.message(), "找不到留言：c-nope");
        assert!(matches!(err, CoMotionError::NotFound(_)));
    }

    #[test]
    fn delete_removes_the_comment_but_keeps_an_empty_list_container() {
        let svg = slide(&format!(
            r#"<metadata><comot:comments xmlns:comot="{COMMENTS_NS}"><comot:comment id="c-1" target="page" author="agent" created="2026-01-01T00:00:00.000Z">only</comot:comment></comot:comments></metadata>"#
        ));
        let updated = delete_slide_comment(&svg, "c-1").unwrap();
        assert!(!updated.contains("comot:comment "));
        assert!(updated.contains(&format!(
            r#"<comot:comments xmlns:comot="{COMMENTS_NS}"></comot:comments>"#
        )));
        assert_eq!(read_slide_comments(&updated).unwrap(), Vec::new());
    }

    #[test]
    fn delete_unknown_comment_id_is_not_found() {
        let svg = slide("");
        let err = delete_slide_comment(&svg, "c-nope").unwrap_err();
        assert!(matches!(err, CoMotionError::NotFound(_)));
    }

    #[test]
    fn read_comment_missing_a_required_attribute_errors() {
        let svg = slide(&format!(
            r#"<metadata><comot:comments xmlns:comot="{COMMENTS_NS}"><comot:comment id="c-1" target="page" author="agent">missing created</comot:comment></comot:comments></metadata>"#
        ));
        let err = read_slide_comments(&svg).unwrap_err();
        assert_eq!(err.message(), "留言缺少必要屬性");
    }
}
