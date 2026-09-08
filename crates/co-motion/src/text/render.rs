//! `renderTextBoxContent`, ported from `packages/core/src/text/render.ts`
//! (69 lines, ported in full).
//!
//! Concatenates wrapped lines into `<tspan>` elements with NO whitespace of
//! any kind between adjacent tags — the `<text>` this is spliced into
//! carries `xml:space="preserve"` in the TS caller (`element-text.ts`), so
//! any indentation here would be rendered content, not formatting.

use super::escape::{escape_xml_attr, escape_xml_text};
use super::runs::{utf16_len, utf16_slice, TextRun};
use super::wrap::WrappedLine;
use crate::svgnum::format_svg_number;

/// Serializes wrapped lines into the inner markup of a text box's `<text>`
/// element: one `<tspan x="…" y="…">…</tspan>` per line, with
/// `data-comot-break="1"` on a line that ends on a hard break, and — when
/// `runs` covers part of a line — a nested `<tspan font-weight="…"
/// font-style="…">` per run segment.
pub fn render_text_box_content(lines: &[WrappedLine], runs: &[TextRun]) -> String {
    let mut cursor = 0usize;
    let mut out = String::new();
    for line in lines {
        let line_start = cursor;
        cursor = line_start + utf16_len(&line.text) + if line.hard_break { 1 } else { 0 };
        let break_attr = if line.hard_break { " data-comot-break=\"1\"" } else { "" };
        let inner = render_line_runs(&line.text, line_start, runs);
        out.push_str(&format!(
            "<tspan x=\"{}\" y=\"{}\"{}>{}</tspan>",
            format_svg_number(line.x),
            format_svg_number(line.y),
            break_attr,
            inner
        ));
    }
    out
}

/// One line's inner markup: plain escaped text where no run covers a
/// character, a nested `<tspan font-weight="…" font-style="…">` for each run
/// segment that overlaps the line. `line_start` is `text`'s offset in the
/// content-string UTF-16 index space `runs`' ranges are expressed in (see
/// `runs.rs`'s module doc comment).
fn render_line_runs(text: &str, line_start: usize, runs: &[TextRun]) -> String {
    let line_end = line_start + utf16_len(text);
    let mut relevant: Vec<&TextRun> = runs.iter().filter(|run| run.start < line_end && run.end > line_start).collect();
    relevant.sort_by_key(|run| run.start);

    let mut result = String::new();
    let mut pos = line_start;
    for run in relevant {
        let seg_start = run.start.max(line_start);
        let seg_end = run.end.min(line_end);
        if seg_start > pos {
            result.push_str(&escape_xml_text(&utf16_slice(text, pos - line_start, seg_start - line_start)));
        }
        let weight_attr = match &run.font_weight {
            Some(weight) => format!(" font-weight=\"{}\"", escape_xml_attr(weight)),
            None => String::new(),
        };
        let style_attr = match &run.font_style {
            Some(style) => format!(" font-style=\"{}\"", escape_xml_attr(style)),
            None => String::new(),
        };
        result.push_str(&format!(
            "<tspan{}{}>{}</tspan>",
            weight_attr,
            style_attr,
            escape_xml_text(&utf16_slice(text, seg_start - line_start, seg_end - line_start))
        ));
        pos = seg_end;
    }
    if pos < line_end {
        result.push_str(&escape_xml_text(&utf16_slice(text, pos - line_start, line_end - line_start)));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f64, y: f64, hard_break: bool) -> WrappedLine {
        WrappedLine { text: text.to_string(), x, y, width: 0.0, hard_break }
    }

    #[test]
    fn single_plain_line_with_no_runs() {
        let lines = vec![line("hello", 0.0, 27.84, false)];
        let out = render_text_box_content(&lines, &[]);
        assert_eq!(out, "<tspan x=\"0\" y=\"27.84\">hello</tspan>");
    }

    #[test]
    fn hard_break_line_gets_the_data_attribute_non_hard_break_does_not() {
        let lines = vec![line("line one", 0.0, 27.84, true), line("line two", 0.0, 62.592, false)];
        let out = render_text_box_content(&lines, &[]);
        assert_eq!(
            out,
            "<tspan x=\"0\" y=\"27.84\" data-comot-break=\"1\">line one</tspan><tspan x=\"0\" y=\"62.592\">line two</tspan>"
        );
    }

    #[test]
    fn no_whitespace_between_adjacent_tspans() {
        let lines = vec![line("a", 0.0, 10.0, false), line("b", 0.0, 20.0, false)];
        let out = render_text_box_content(&lines, &[]);
        assert!(!out.contains('\n'));
        assert_eq!(out, "<tspan x=\"0\" y=\"10\">a</tspan><tspan x=\"0\" y=\"20\">b</tspan>");
    }

    #[test]
    fn text_content_is_xml_escaped() {
        let lines = vec![line("<a> & </a>", 0.0, 10.0, false)];
        let out = render_text_box_content(&lines, &[]);
        assert_eq!(out, "<tspan x=\"0\" y=\"10\">&lt;a&gt; &amp; &lt;/a&gt;</tspan>");
    }

    #[test]
    fn run_covering_the_whole_line_wraps_it_in_one_nested_tspan() {
        let lines = vec![line("hello", 0.0, 10.0, false)];
        let runs = vec![TextRun { start: 0, end: 5, font_weight: Some("bold".to_string()), font_style: None }];
        let out = render_text_box_content(&lines, &runs);
        assert_eq!(out, "<tspan x=\"0\" y=\"10\"><tspan font-weight=\"bold\">hello</tspan></tspan>");
    }

    #[test]
    fn run_covering_part_of_a_line_splits_into_plain_and_nested_segments() {
        // Content "AABBCC" split into one line; run covers "BB" (offsets 2..4).
        let lines = vec![line("AABBCC", 0.0, 10.0, false)];
        let runs = vec![TextRun { start: 2, end: 4, font_weight: None, font_style: Some("italic".to_string()) }];
        let out = render_text_box_content(&lines, &runs);
        assert_eq!(out, "<tspan x=\"0\" y=\"10\">AA<tspan font-style=\"italic\">BB</tspan>CC</tspan>");
    }

    #[test]
    fn run_spanning_multiple_lines_is_clipped_to_each_lines_bounds() {
        // Content "AABB" wrapped into two lines "AA" and "BB"; one run [1,3)
        // spans the boundary and must be clipped per line.
        let lines = vec![line("AA", 0.0, 10.0, false), line("BB", 0.0, 20.0, false)];
        let runs = vec![TextRun { start: 1, end: 3, font_weight: Some("bold".to_string()), font_style: None }];
        let out = render_text_box_content(&lines, &runs);
        assert_eq!(
            out,
            "<tspan x=\"0\" y=\"10\">A<tspan font-weight=\"bold\">A</tspan></tspan><tspan x=\"0\" y=\"20\"><tspan font-weight=\"bold\">B</tspan>B</tspan>"
        );
    }

    #[test]
    fn hard_break_advances_the_cursor_by_one_extra_utf16_unit_for_the_next_line() {
        // Content is conceptually "AA\nBB" (2 hard-break lines); a run on the
        // *second* line only should start at offset 3 (2 chars + 1 for the
        // implied '\n'), not offset 2.
        let lines = vec![line("AA", 0.0, 10.0, true), line("BB", 0.0, 20.0, false)];
        let runs = vec![TextRun { start: 3, end: 5, font_weight: Some("bold".to_string()), font_style: None }];
        let out = render_text_box_content(&lines, &runs);
        assert_eq!(
            out,
            "<tspan x=\"0\" y=\"10\" data-comot-break=\"1\">AA</tspan><tspan x=\"0\" y=\"20\"><tspan font-weight=\"bold\">BB</tspan></tspan>"
        );
    }

    #[test]
    fn empty_lines_slice_produces_empty_string() {
        assert_eq!(render_text_box_content(&[], &[]), "");
    }
}
