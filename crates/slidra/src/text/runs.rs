// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `TextRun`, `apply_run_style`, and `read_text_box_runs`.
//!
//! ## The UTF-16 index space (critical, load-bearing)
//!
//! `TextRun.start`/`end` are indices into the **UTF-16 code-unit space** of
//! the content string — exactly what JavaScript's `String#length` and
//! `String#slice` use. This is NOT a byte offset and NOT a Unicode scalar
//! (`char`) count. A sibling module (`slide/format.rs`) depends on
//! `TextRun` verbatim and needs this index space preserved exactly, because
//! it is the same index space `text style set`'s user-visible range
//! parameters use — nothing exercises that CLI command end-to-end yet, but
//! the type must already speak its index space.
//!
//! Concretely: a 4-byte UTF-8 astral character (e.g. most emoji) is ONE
//! `char` in Rust but TWO UTF-16 code units in JS — `char_indices()`-based
//! counting would disagree with the TS source for any such character. A
//! 3-byte UTF-8 CJK character is one UTF-16 code unit but three UTF-8
//! bytes — raw byte-offset counting would disagree there instead. Every
//! function in this module that turns a UTF-16 offset into an actual `&str`
//! slice goes through `utf16_offset_to_byte_offset` below — never raw byte
//! offsets, never `char_indices()` counts, as a substitute.

/// A character-range style override on a text box's content string. Ranges
/// are half-open `[start, end)` in the content string's UTF-16 code-unit
/// index space — see the module doc comment above.
///
/// `font_weight`/`font_style` are the exact SVG attribute values to write
/// (`"bold"`, `"700"`, `"italic"`) — never `"normal"`, which this module
/// represents as the attribute's absence (`None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextRun {
    pub start: usize,
    pub end: usize,
    pub font_weight: Option<String>,
    pub font_style: Option<String>,
}

/// Converts a UTF-16 code-unit offset into `s` to a Rust (UTF-8) byte
/// offset. Needed anywhere a `TextRun` boundary — or a `ScannedNode` content
/// offset (see `ScannedNode` below), which lives in the same index space —
/// must be turned into an actual substring. Do NOT use `char_indices()`
/// counts or raw byte offsets in its place; see the module doc comment for
/// why they disagree for non-BMP and multi-byte-but-single-UTF16-unit
/// characters respectively.
///
/// `utf16_offset` beyond `s`'s own UTF-16 length clamps to `s.len()` (the
/// byte length) rather than panicking — every call site in this module only
/// ever passes offsets already known to be within range, but a clamp is
/// cheap insurance against an off-by-one becoming a slice-index panic.
pub fn utf16_offset_to_byte_offset(s: &str, utf16_offset: usize) -> usize {
    if utf16_offset == 0 {
        return 0;
    }
    let mut utf16_count = 0usize;
    for (byte_idx, ch) in s.char_indices() {
        if utf16_count >= utf16_offset {
            return byte_idx;
        }
        utf16_count += ch.len_utf16();
    }
    s.len()
}

/// `s.encode_utf16().count()` — the Rust equivalent of JS's `s.length` for a
/// content string. Named so every UTF-16-space length computation in this
/// module (and `render.rs`) is visibly the same operation, not an ad hoc
/// `.chars().count()` or `.len()` that would silently mean something else.
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Slices `s` using UTF-16 code-unit offsets `[start, end)` (see the module
/// doc comment) rather than byte offsets, returning an owned `String`.
pub(crate) fn utf16_slice(s: &str, start: usize, end: usize) -> String {
    let byte_start = utf16_offset_to_byte_offset(s, start);
    let byte_end = utf16_offset_to_byte_offset(s, end);
    s[byte_start..byte_end].to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct RunAttrs {
    font_weight: Option<String>,
    font_style: Option<String>,
}

fn attrs_at(runs: &[TextRun], pos: usize) -> RunAttrs {
    runs.iter()
        .find(|run| run.start <= pos && pos < run.end)
        .map(|run| RunAttrs {
            font_weight: run.font_weight.clone(),
            font_style: run.font_style.clone(),
        })
        .unwrap_or_default()
}

fn merge_adjacent(runs: &[TextRun]) -> Vec<TextRun> {
    let mut sorted: Vec<TextRun> = runs.to_vec();
    sorted.sort_by_key(|run| run.start);
    let mut merged: Vec<TextRun> = Vec::new();
    for run in sorted {
        if let Some(last) = merged.last_mut() {
            if last.end == run.start
                && last.font_weight == run.font_weight
                && last.font_style == run.font_style
            {
                last.end = run.end;
                continue;
            }
        }
        merged.push(run);
    }
    merged
}

/// Either field may be left `None` in `update` to leave that axis untouched
/// over the whole range; `Some(None)` clears it (the `--font-weight normal`
/// / `--font-style normal` case, TS's `null`); `Some(Some(value))` sets it.
/// This three-state shape is why the field is `Option<Option<String>>`
/// rather than a plain `Option<String>` — TS distinguishes "key omitted from
/// `update`" from "key present with value `null`", and a single `Option`
/// can't.
#[derive(Debug, Clone, Default)]
pub struct RunStyleUpdate {
    pub font_weight: Option<Option<String>>,
    pub font_style: Option<Option<String>>,
}

/// Sets (or clears) `font_weight`/`font_style` over `[start, end)`,
/// returning a brand-new run list — `runs` itself is never mutated.
///
/// Existing runs that only partially overlap `[start, end)` are split at
/// the boundary, so the untouched portion keeps its original attributes
/// exactly. Adjacent runs whose attributes end up identical are merged back
/// into one; a resulting run with neither attribute set is dropped rather
/// than kept as an empty tspan.
pub fn apply_run_style(
    runs: &[TextRun],
    start: usize,
    end: usize,
    update: &RunStyleUpdate,
) -> Vec<TextRun> {
    let mut boundary_set: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    boundary_set.insert(start);
    boundary_set.insert(end);
    for run in runs {
        if run.start > start && run.start < end {
            boundary_set.insert(run.start);
        }
        if run.end > start && run.end < end {
            boundary_set.insert(run.end);
        }
    }
    let boundaries: Vec<usize> = boundary_set.into_iter().collect();

    let untouched: Vec<TextRun> = runs
        .iter()
        .filter(|run| run.end <= start || run.start >= end)
        .cloned()
        .collect();
    let clipped_before: Vec<TextRun> = runs
        .iter()
        .filter(|run| run.start < start && run.end > start)
        .map(|run| TextRun {
            start: run.start,
            end: start,
            font_weight: run.font_weight.clone(),
            font_style: run.font_style.clone(),
        })
        .collect();
    let clipped_after: Vec<TextRun> = runs
        .iter()
        .filter(|run| run.start < end && run.end > end)
        .map(|run| TextRun {
            start: end,
            end: run.end,
            font_weight: run.font_weight.clone(),
            font_style: run.font_style.clone(),
        })
        .collect();

    let mut new_segments: Vec<TextRun> = Vec::new();
    for window in boundaries.windows(2) {
        let (seg_start, seg_end) = (window[0], window[1]);
        if seg_start >= seg_end {
            continue;
        }
        let current = attrs_at(runs, seg_start);
        let font_weight = match &update.font_weight {
            None => current.font_weight,
            Some(None) => None,
            Some(Some(value)) => Some(value.clone()),
        };
        let font_style = match &update.font_style {
            None => current.font_style,
            Some(None) => None,
            Some(Some(value)) => Some(value.clone()),
        };
        if font_weight.is_some() || font_style.is_some() {
            new_segments.push(TextRun {
                start: seg_start,
                end: seg_end,
                font_weight,
                font_style,
            });
        }
    }

    let mut all: Vec<TextRun> = Vec::new();
    all.extend(untouched);
    all.extend(clipped_before);
    all.extend(clipped_after);
    all.extend(new_segments);
    all.retain(|run| run.start < run.end);
    all.sort_by_key(|run| run.start);

    merge_adjacent(&all)
}

// `ScannedNode` used to be a local placeholder (this file landed before
// `slide::scan` did). Now that the real scanner exists, `read_text_box_runs`
// operates on its actual `ScannedNode`/`attribute_of` — same field shape
// this file assumed, so the swap needed no logic changes.
use crate::slide::scan::{ScannedNode, attribute_of};

fn attribute_value<'a>(node: &'a ScannedNode, name: &str) -> Option<&'a str> {
    attribute_of(node, name).map(|attribute| attribute.value.as_str())
}

/// The content string plus its runs, in one interleaved read —
/// `read_text_box_runs`'s per-line worker. `svg_content` is indexed in the
/// same UTF-16 code-unit space as `ScannedNode`'s offsets and `TextRun`'s
/// `start`/`end` — see the module doc comment.
fn read_line_content(
    line_node: &ScannedNode,
    svg_content: &str,
    offset: usize,
) -> (String, Vec<TextRun>) {
    let unescape = crate::text::escape::unescape_xml_text;
    let mut text = String::new();
    let mut runs = Vec::new();
    let mut cursor = line_node.content_start;
    for child in &line_node.children {
        if child.start > cursor {
            text.push_str(&unescape(&utf16_slice(svg_content, cursor, child.start)));
        }
        let start = offset + utf16_len(&text);
        text.push_str(&unescape(&utf16_slice(
            svg_content,
            child.content_start,
            child.content_end,
        )));
        let font_weight = attribute_value(child, "font-weight").map(str::to_string);
        let font_style = attribute_value(child, "font-style").map(str::to_string);
        if font_weight.is_some() || font_style.is_some() {
            runs.push(TextRun {
                start,
                end: offset + utf16_len(&text),
                font_weight,
                font_style,
            });
        }
        cursor = child.end;
    }
    if line_node.content_end > cursor {
        text.push_str(&unescape(&utf16_slice(
            svg_content,
            cursor,
            line_node.content_end,
        )));
    }
    (text, runs)
}

/// Reads a text box's `<text>` content back into its content string plus the
/// `TextRun`s its nested tspans encode. `text_node`'s direct `<tspan>`
/// children are the per-line tspans; each line's own children, if any, are
/// its run tspans.
///
/// A line whose own opening tspan carries `data-slidra-break="1"` had a
/// `"\n"` after it in the original content string — that character is
/// appended here, and — matching `wrap_text`'s own contract — it is never
/// covered by a run.
pub fn read_text_box_runs(text_node: &ScannedNode, svg_content: &str) -> (String, Vec<TextRun>) {
    let line_nodes: Vec<&ScannedNode> = text_node
        .children
        .iter()
        .filter(|child| child.tag == "tspan")
        .collect();
    let mut content = String::new();
    let mut runs: Vec<TextRun> = Vec::new();
    for line_node in line_nodes {
        let (text, line_runs) = read_line_content(line_node, svg_content, utf16_len(&content));
        content.push_str(&text);
        runs.extend(line_runs);
        if attribute_value(line_node, "data-slidra-break") == Some("1") {
            content.push('\n');
        }
    }
    (content, merge_adjacent(&runs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(start: usize, end: usize, weight: Option<&str>, style: Option<&str>) -> TextRun {
        TextRun {
            start,
            end,
            font_weight: weight.map(String::from),
            font_style: style.map(String::from),
        }
    }

    // --- utf16_offset_to_byte_offset / utf16_len / utf16_slice ---

    #[test]
    fn utf16_len_counts_code_units_not_bytes_or_chars() {
        // U+1F600 (😀) is 4 UTF-8 bytes, 1 Rust char, 2 UTF-16 code units.
        assert_eq!(utf16_len("😀"), 2);
        // A CJK character is 3 UTF-8 bytes, 1 Rust char, 1 UTF-16 code unit.
        assert_eq!(utf16_len("中"), 1);
        assert_eq!(utf16_len("ab"), 2);
    }

    #[test]
    fn utf16_offset_to_byte_offset_skips_a_full_astral_character() {
        let s = "a😀b"; // bytes: 'a'(1) + 😀(4) + 'b'(1) = 6 bytes; UTF-16: 1+2+1 = 4 units.
        assert_eq!(utf16_offset_to_byte_offset(s, 0), 0);
        assert_eq!(utf16_offset_to_byte_offset(s, 1), 1); // right after 'a'
        assert_eq!(utf16_offset_to_byte_offset(s, 3), 5); // right after the 2-unit emoji
        assert_eq!(utf16_offset_to_byte_offset(s, 4), 6); // end of string
    }

    #[test]
    fn utf16_slice_extracts_using_utf16_offsets() {
        let s = "中a😀b";
        // UTF-16 units: 中(1) a(1) 😀(2) b(1) -> total 5.
        assert_eq!(utf16_slice(s, 0, 1), "中");
        assert_eq!(utf16_slice(s, 1, 2), "a");
        assert_eq!(utf16_slice(s, 2, 4), "😀");
        assert_eq!(utf16_slice(s, 4, 5), "b");
    }

    // --- apply_run_style ---

    #[test]
    fn setting_style_on_empty_runs_creates_one_new_run() {
        let update = RunStyleUpdate {
            font_weight: Some(Some("bold".to_string())),
            font_style: None,
        };
        let result = apply_run_style(&[], 2, 5, &update);
        assert_eq!(result, vec![run(2, 5, Some("bold"), None)]);
    }

    #[test]
    fn partial_overlap_splits_existing_run_and_keeps_untouched_portion_exact() {
        // Existing run [0,10) bold; apply italic-only over [4,7).
        let existing = vec![run(0, 10, Some("bold"), None)];
        let update = RunStyleUpdate {
            font_weight: None,
            font_style: Some(Some("italic".to_string())),
        };
        let mut result = apply_run_style(&existing, 4, 7, &update);
        result.sort_by_key(|r| r.start);
        assert_eq!(
            result,
            vec![
                run(0, 4, Some("bold"), None),
                run(4, 7, Some("bold"), Some("italic")),
                run(7, 10, Some("bold"), None),
            ]
        );
    }

    #[test]
    fn exact_match_replaces_the_whole_run() {
        let existing = vec![run(0, 5, Some("bold"), None)];
        let update = RunStyleUpdate {
            font_weight: Some(None),
            font_style: Some(Some("italic".to_string())),
        };
        let result = apply_run_style(&existing, 0, 5, &update);
        assert_eq!(result, vec![run(0, 5, None, Some("italic"))]);
    }

    #[test]
    fn clearing_the_only_attribute_drops_the_run_entirely() {
        let existing = vec![run(0, 5, Some("bold"), None)];
        let update = RunStyleUpdate {
            font_weight: Some(None),
            font_style: None,
        };
        let result = apply_run_style(&existing, 0, 5, &update);
        assert_eq!(result, Vec::<TextRun>::new());
    }

    #[test]
    fn adjacent_runs_with_identical_resulting_attrs_are_merged() {
        // Two existing runs [0,5) and [5,10), both bold; applying "bold" again
        // over [3,8) must not leave a seam at 5 or at the update boundaries.
        let existing = vec![
            run(0, 5, Some("bold"), None),
            run(5, 10, Some("bold"), None),
        ];
        let update = RunStyleUpdate {
            font_weight: Some(Some("bold".to_string())),
            font_style: None,
        };
        let result = apply_run_style(&existing, 3, 8, &update);
        assert_eq!(result, vec![run(0, 10, Some("bold"), None)]);
    }

    #[test]
    fn untouched_axis_is_preserved_when_update_omits_it() {
        // Existing run has both weight and style; update only weight -> style survives.
        let existing = vec![run(0, 5, Some("bold"), Some("italic"))];
        let update = RunStyleUpdate {
            font_weight: Some(Some("700".to_string())),
            font_style: None,
        };
        let result = apply_run_style(&existing, 0, 5, &update);
        assert_eq!(result, vec![run(0, 5, Some("700"), Some("italic"))]);
    }

    // --- read_text_box_runs ---

    fn tspan(
        content_start: usize,
        content_end: usize,
        start: usize,
        end: usize,
        attrs: Vec<(&str, &str)>,
        children: Vec<ScannedNode>,
    ) -> ScannedNode {
        node(
            "tspan",
            content_start,
            content_end,
            start,
            end,
            attrs,
            children,
        )
    }

    fn node(
        tag: &str,
        content_start: usize,
        content_end: usize,
        start: usize,
        end: usize,
        attrs: Vec<(&str, &str)>,
        children: Vec<ScannedNode>,
    ) -> ScannedNode {
        ScannedNode {
            tag: tag.to_string(),
            content_start,
            content_end,
            start,
            end,
            self_closing: false,
            attributes: attrs
                .into_iter()
                .enumerate()
                .map(|(i, (name, value))| crate::slide::scan::ScannedAttribute {
                    name: name.to_string(),
                    value: value.to_string(),
                    start: start + i,
                    end: start + i,
                })
                .collect(),
            children,
        }
    }

    #[test]
    fn reads_plain_line_with_no_runs() {
        // <text><tspan x="0" y="10">hello</tspan></text>, svg_content sliced
        // so tspan's contentStart/contentEnd bracket exactly "hello".
        let svg = "hello";
        let line = tspan(0, 5, 0, 5, vec![], vec![]);
        let text_node = node("text", 0, 5, 0, 5, vec![], vec![line]);
        let (content, runs) = read_text_box_runs(&text_node, svg);
        assert_eq!(content, "hello");
        assert!(runs.is_empty());
    }

    #[test]
    fn hard_break_attribute_appends_newline_not_covered_by_a_run() {
        let svg = "line one";
        let line = tspan(0, 8, 0, 8, vec![("data-slidra-break", "1")], vec![]);
        let text_node = node("text", 0, 8, 0, 8, vec![], vec![line]);
        let (content, runs) = read_text_box_runs(&text_node, svg);
        assert_eq!(content, "line one\n");
        assert!(runs.is_empty());
    }

    #[test]
    fn nested_run_tspan_produces_a_text_run_with_correct_offsets() {
        // svg content for the whole document: "AA<tspan font-weight=\"bold\">BB</tspan>CC"
        // line's own contentStart/contentEnd bracket "AABBCC" as seen through
        // the run child in the middle.
        let svg = "AABBCC";
        let run_child = tspan(2, 4, 2, 4, vec![("font-weight", "bold")], vec![]);
        let line = tspan(0, 6, 0, 6, vec![], vec![run_child]);
        let text_node = node("text", 0, 6, 0, 6, vec![], vec![line]);
        let (content, runs) = read_text_box_runs(&text_node, svg);
        assert_eq!(content, "AABBCC");
        assert_eq!(runs, vec![run(2, 4, Some("bold"), None)]);
    }

    #[test]
    fn multiple_lines_offset_runs_by_prior_lines_content_length() {
        let svg = "AABB"; // line 1 = "AA" (no run), line 2 = "BB" (all bold via a run child)
        let line1 = tspan(0, 2, 0, 2, vec![], vec![]);
        let bold_child = tspan(2, 4, 2, 4, vec![("font-weight", "bold")], vec![]);
        let line2 = tspan(2, 4, 2, 4, vec![], vec![bold_child]);
        let text_node = node("text", 0, 4, 0, 4, vec![], vec![line1, line2]);
        let (content, runs) = read_text_box_runs(&text_node, svg);
        assert_eq!(content, "AABB");
        // The run covers "BB", which starts at content offset 2 (after "AA").
        assert_eq!(runs, vec![run(2, 4, Some("bold"), None)]);
    }
}
