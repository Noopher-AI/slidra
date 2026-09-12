//! `wrapText`.
//!
//! Every width, ascent and line-height number here comes from
//! `measure_text_width`/`FontMetrics` — this module never re-measures or
//! estimates a width on its own, and never inspects glyph/cmap data
//! directly. Iterates by Unicode scalar value (`char`) throughout, matching
//! the TS source's `Array.from(text, ...)` (which iterates full code
//! points, not UTF-16 code units) — UTF-16 offsets only matter for
//! `TextRun`, a completely separate concern in `runs.rs`.

use crate::errors::{SlidraError, SlidraResult};
use crate::text::font::FontMetrics;
use crate::text::metrics::measure_text_width;
use std::collections::HashSet;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

// Every field is `Copy` (`f64`, `Align`, a shared reference, and
// `Option<&[f64]>`), so the whole struct can be too — handy for tests that
// build several option sets sharing most fields.
#[derive(Clone, Copy)]
pub struct WrapOptions<'a> {
    /// Box width in user units. Finite, > 0.
    pub width: f64,
    pub font: &'a dyn FontMetrics,
    /// User units (SVG px). Must be a finite number greater than 0; decimals
    /// are legal (this constraint is `measure_text_width`'s, not enforced
    /// again here).
    pub font_size_px: f64,
    /// Horizontal alignment, baked into each line's `x`.
    pub align: Align,
    /// Per-paragraph left indent, in user units — paragraph `i` (0-based,
    /// `text` split on `"\n"`) is wrapped at `width - indents[i]` and its
    /// lines' `x` starts at `indents[i]`. Missing entries default to 0.
    pub indents: Option<&'a [f64]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WrappedLine {
    pub text: String,
    /// Baseline y relative to the box's top-left corner.
    pub y: f64,
    /// Measured advance width of this line.
    pub width: f64,
    /// Baked-in horizontal position, from alignment + the line's paragraph indent.
    pub x: f64,
    /// True when this line ends because the source text had a `"\n"` there
    /// (a hard break, not a wrap-induced break). The `"\n"` itself is never
    /// part of any line's `text`.
    pub hard_break: bool,
}

#[derive(Debug)]
pub struct WrappedText {
    pub lines: Vec<WrappedLine>,
    pub line_height: f64,
    pub ascent: f64,
    /// `lines.len() * line_height`.
    pub height: f64,
}

// CJK-ish code point ranges: CJK symbols/punctuation, hiragana/katakana, CJK
// unified ideographs (BMP and extension A), hangul syllables, CJK
// compatibility ideographs, halfwidth/fullwidth forms, and the
// supplementary-plane CJK unified ideographs extension B.
const CJK_RANGES: &[(u32, u32)] = &[
    (0x3000, 0x303f),
    (0x3040, 0x30ff),
    (0x3400, 0x4dbf),
    (0x4e00, 0x9fff),
    (0xac00, 0xd7af),
    (0xf900, 0xfaff),
    (0xff00, 0xff60),
    (0x20000, 0x2a6df),
];

fn is_cjk(code_point: u32) -> bool {
    CJK_RANGES
        .iter()
        .any(|&(start, end)| code_point >= start && code_point <= end)
}

// Closing/trailing punctuation a line must never end immediately before, and
// opening punctuation a line must never end immediately after — do not
// retype these from memory or description if they ever need touching.
const NO_BREAK_BEFORE_CHARS: &str = "」』）］｝〉》、，。．！？：；・…〜ー";
const NO_BREAK_AFTER_CHARS: &str = "「『（［｛〈《";

/// The parsed `NO_BREAK_BEFORE_CHARS` set, exposed as part of this module's
/// public surface.
pub fn no_break_before() -> &'static HashSet<u32> {
    static SET: OnceLock<HashSet<u32>> = OnceLock::new();
    SET.get_or_init(|| NO_BREAK_BEFORE_CHARS.chars().map(|ch| ch as u32).collect())
}

/// The parsed `NO_BREAK_AFTER_CHARS` set.
pub fn no_break_after() -> &'static HashSet<u32> {
    static SET: OnceLock<HashSet<u32>> = OnceLock::new();
    SET.get_or_init(|| NO_BREAK_AFTER_CHARS.chars().map(|ch| ch as u32).collect())
}

const SPACE: u32 = 0x0020;

/// Whether a line is permitted to break between `previous` and `next`
/// (adjacent code points, `previous` immediately before `next`). Order
/// matters: the punctuation rules are checked first so they override the
/// space/CJK rules — e.g. a break is never allowed right before `」` even
/// when the previous code point is CJK and would otherwise permit it.
pub fn break_allowed_between(previous: u32, next: u32) -> bool {
    if no_break_before().contains(&next) {
        return false;
    }
    if no_break_after().contains(&previous) {
        return false;
    }
    if previous == SPACE {
        return true;
    }
    if is_cjk(previous) || is_cjk(next) {
        return true;
    }
    false
}

fn assert_width(width: f64) -> SlidraResult<()> {
    if !width.is_finite() || width <= 0.0 {
        return Err(SlidraError::invalid(
            "text box width must be a number greater than 0",
        ));
    }
    Ok(())
}

/// One paragraph's wrapped lines, before the caller assigns global `y`/`x`.
struct WrappedParagraphLine {
    text: String,
    width: f64,
}

fn code_points_to_string(code_points: &[u32], from: usize, to: usize) -> String {
    code_points[from..to]
        .iter()
        .filter_map(|&cp| char::from_u32(cp))
        .collect()
}

/// Greedy first-fit line breaking of one paragraph (no `"\n"` inside it), by
/// code point.
///
/// Never deletes a character: a break after a space leaves the space at the
/// end of the previous line rather than dropping it.
///
/// A single code point wider than `width` gets its own line, and that line
/// is the one case allowed to exceed `width`. Every other emergency break —
/// an unbroken run wider than the box, e.g. one long Latin word — breaks
/// immediately before the code point that would overflow, so those lines
/// never exceed `width`.
fn wrap_paragraph(
    text: &str,
    width: f64,
    font: &dyn FontMetrics,
    font_size_px: f64,
) -> SlidraResult<Vec<WrappedParagraphLine>> {
    let code_points: Vec<u32> = text.chars().map(|ch| ch as u32).collect();

    if code_points.is_empty() {
        // One empty line, so an empty paragraph still occupies a line. Note
        // this path never calls measure_text_width — an invalid
        // font_size_px is NOT caught for a wholly-empty paragraph, exactly
        // mirroring the TS source's own early return.
        return Ok(vec![WrappedParagraphLine {
            text: String::new(),
            width: 0.0,
        }]);
    }

    let mut lines: Vec<WrappedParagraphLine> = Vec::new();
    let mut start = 0usize;
    // Invariant: start < code_points.len() on every loop entry — the
    // empty-text case is handled above, so the loop cannot spin an extra,
    // spurious empty final line after the last real character is consumed.
    while start < code_points.len() {
        let mut accumulated = 0.0f64;
        // Index right after the last code point of a permitted break, or `None`.
        let mut break_at: Option<usize> = None;
        let mut break_width = 0.0f64;
        let mut cursor = start;
        while cursor < code_points.len() {
            // The whole candidate run is measured as one string, every
            // time — never a per-code-point advance summed incrementally —
            // so ligature substitution and pair kerning across the run (and
            // a cmap-uncovered code point, which just measures as
            // .notdef's advance) are always measure_text_width's call,
            // never this function's own arithmetic.
            let candidate_str = code_points_to_string(&code_points, start, cursor + 1);
            let candidate = measure_text_width(font, &candidate_str, font_size_px)?;
            if candidate > width {
                break;
            }
            accumulated = candidate;
            if cursor + 1 < code_points.len()
                && break_allowed_between(code_points[cursor], code_points[cursor + 1])
            {
                break_at = Some(cursor + 1);
                break_width = accumulated;
            }
            cursor += 1;
        }

        if cursor == code_points.len() {
            // Everything from `start` fits on one final line.
            lines.push(WrappedParagraphLine {
                text: code_points_to_string(&code_points, start, cursor),
                width: accumulated,
            });
            break;
        }

        if cursor == start {
            // The very first code point of this line is already wider than
            // the box on its own: it takes its own (overflowing) line.
            let sole_text = code_points_to_string(&code_points, start, start + 1);
            let sole_width = measure_text_width(font, &sole_text, font_size_px)?;
            lines.push(WrappedParagraphLine {
                text: sole_text,
                width: sole_width,
            });
            start += 1;
            continue;
        }

        // break_at, when set, is always > start (it is cursor + 1 for some
        // cursor >= start) — the `> start` check mirrors the TS source's own
        // `if (breakAt > start)` guard against its `-1` sentinel exactly.
        if let Some(break_at) = break_at.filter(|&b| b > start) {
            lines.push(WrappedParagraphLine {
                text: code_points_to_string(&code_points, start, break_at),
                width: break_width,
            });
            start = break_at;
        } else {
            // No permitted break anywhere in this run: character-level
            // emergency break right before the code point that overflowed.
            lines.push(WrappedParagraphLine {
                text: code_points_to_string(&code_points, start, cursor),
                width: accumulated,
            });
            start = cursor;
        }
    }

    Ok(lines)
}

/// `x` for one line, from the paragraph's alignment and indent.
///
/// `right` deliberately does NOT subtract `indent` — a preserved quirk from
/// the TS source (`text/wrap.ts`'s `lineX`), not a bug to "fix" here: only
/// `center` and `left` incorporate `indent`.
fn line_x(align: Align, width: f64, indent: f64, line_width: f64) -> f64 {
    match align {
        Align::Center => indent + (width - indent - line_width) / 2.0,
        Align::Right => width - line_width,
        Align::Left => indent,
    }
}

/// Splits `text` into paragraphs on `"\n"`, wraps each independently (a
/// paragraph never merges with its neighbour across the break), and
/// concatenates the results with a single, box-wide baseline sequence.
///
/// Hard breaks are baked in as a boolean flag, never as a character in any
/// line's `text`: the line ending a paragraph (every paragraph but the
/// last) carries `hard_break: true`.
pub fn wrap_text(text: &str, options: &WrapOptions) -> SlidraResult<WrappedText> {
    assert_width(options.width)?;
    if text.contains('\r') {
        return Err(SlidraError::invalid(
            "text content does not accept \\r, use \\n for hard line breaks",
        ));
    }

    let units_per_em = f64::from(options.font.units_per_em());
    let ascent = (f64::from(options.font.ascender()) / units_per_em) * options.font_size_px;
    // hhea-derived line height (ascender - descender + lineGap), per em.
    let line_height = ((f64::from(options.font.ascender()) - f64::from(options.font.descender())
        + f64::from(options.font.line_gap()))
        / units_per_em)
        * options.font_size_px;

    let paragraphs: Vec<&str> = text.split('\n').collect();
    let mut lines: Vec<WrappedLine> = Vec::new();

    for (paragraph_index, paragraph) in paragraphs.iter().enumerate() {
        let indent = options
            .indents
            .and_then(|indents| indents.get(paragraph_index))
            .copied()
            .unwrap_or(0.0);
        if indent >= options.width {
            return Err(SlidraError::invalid(
                "list indent is greater than text box width, cannot lay out",
            ));
        }
        let paragraph_lines = wrap_paragraph(
            paragraph,
            options.width - indent,
            options.font,
            options.font_size_px,
        )?;
        let is_last_paragraph = paragraph_index == paragraphs.len() - 1;
        let paragraph_line_count = paragraph_lines.len();
        for (line_index, paragraph_line) in paragraph_lines.into_iter().enumerate() {
            let is_last_line_of_paragraph = line_index == paragraph_line_count - 1;
            let y = ascent + (lines.len() as f64) * line_height;
            lines.push(WrappedLine {
                x: line_x(options.align, options.width, indent, paragraph_line.width),
                y,
                width: paragraph_line.width,
                text: paragraph_line.text,
                hard_break: is_last_line_of_paragraph && !is_last_paragraph,
            });
        }
    }

    let height = (lines.len() as f64) * line_height;
    Ok(WrappedText {
        lines,
        line_height,
        ascent,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::metrics::test_support::MockFont;

    /// A monospace-ish mock: every ASCII letter/space/digit is 100 units
    /// wide, CJK/punctuation test characters are individually registered by
    /// each test that needs them. units_per_em=1000, so 100 units = 1/10 em.
    fn monospace_font() -> MockFont {
        let mut font = MockFont::default();
        for ch in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .".chars() {
            font = font.with_glyph(ch, ch as u32 as u16, 100.0);
        }
        font
    }

    // --- break_allowed_between ---

    #[test]
    fn space_allows_a_break_after_it() {
        assert!(break_allowed_between(' ' as u32, 'a' as u32));
    }

    #[test]
    fn cjk_adjacent_to_cjk_allows_a_break() {
        assert!(break_allowed_between('中' as u32, '文' as u32));
    }

    #[test]
    fn cjk_adjacent_to_latin_allows_a_break_either_direction() {
        assert!(break_allowed_between('中' as u32, 'a' as u32));
        assert!(break_allowed_between('a' as u32, '中' as u32));
    }

    #[test]
    fn latin_to_latin_does_not_allow_a_break() {
        assert!(!break_allowed_between('a' as u32, 'b' as u32));
    }

    #[test]
    fn no_break_before_closing_punctuation_overrides_cjk_rule() {
        // '」' is in NO_BREAK_BEFORE; even though the previous char is CJK
        // (which alone would allow a break), breaking right before '」' must
        // still be forbidden.
        let close_paren = '」' as u32;
        assert!(!break_allowed_between('中' as u32, close_paren));
    }

    #[test]
    fn no_break_after_opening_punctuation_overrides_cjk_rule() {
        let open_paren = '「' as u32;
        assert!(!break_allowed_between(open_paren, '中' as u32));
    }

    // --- wrap_text: basic behaviors ---

    #[test]
    fn empty_string_produces_one_empty_line() {
        let font = monospace_font();
        let options = WrapOptions {
            width: 500.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("", &options).unwrap();
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].text, "");
        assert_eq!(result.lines[0].width, 0.0);
    }

    #[test]
    fn text_that_fits_on_one_line_produces_a_single_line() {
        let font = monospace_font();
        // Each char is 100 units * 10px / 1000 upm = 1px; 5 chars = 5px total; width 100 is plenty.
        let options = WrapOptions {
            width: 100.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("hello", &options).unwrap();
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].text, "hello");
        assert!(!result.lines[0].hard_break);
    }

    #[test]
    fn greedy_wrap_breaks_at_the_last_allowed_space_before_overflow() {
        let font = monospace_font();
        // Each char = 100 units * 10px / 1000upm = 1px. "aaa bbb" is 7 chars = 7px.
        // width=5 -> "aaa " (4px, then adding 'b' would make 5px... let's
        // just assert the space-break behavior qualitatively.
        let options = WrapOptions {
            width: 4.5,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("aaa bbb", &options).unwrap();
        // "aaa " fits at 4px (accumulated at cursor pointing at the space),
        // adding 'b' would make it 5 chars = 5px > 4.5, so break after the
        // space, keeping it on the first line.
        assert_eq!(result.lines[0].text, "aaa ");
        assert_eq!(result.lines[1].text, "bbb");
    }

    #[test]
    fn single_overlong_code_point_gets_its_own_overflowing_line() {
        let font = monospace_font();
        // width smaller than a single character's width (1px) -> emergency
        // single-char line that is allowed to overflow.
        let options = WrapOptions {
            width: 0.5,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("ab", &options).unwrap();
        assert_eq!(result.lines.len(), 2);
        assert_eq!(result.lines[0].text, "a");
        assert_eq!(result.lines[1].text, "b");
        // The line is allowed to exceed `width` (1px > 0.5px).
        assert!(result.lines[0].width > options.width);
    }

    #[test]
    fn emergency_character_break_when_no_allowed_break_point_exists() {
        let font = monospace_font();
        // "aaaaaa" (no spaces/CJK/punctuation anywhere) at width=3px (3 chars) forces
        // a character-level break exactly at the overflow point.
        let options = WrapOptions {
            width: 3.5,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("aaaaaa", &options).unwrap();
        assert_eq!(result.lines[0].text, "aaa");
        assert_eq!(result.lines[1].text, "aaa");
    }

    #[test]
    fn hard_break_flag_set_only_on_final_line_of_non_last_paragraph() {
        let font = monospace_font();
        let options = WrapOptions {
            width: 1000.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("aa\nbb\ncc", &options).unwrap();
        assert_eq!(result.lines.len(), 3);
        assert!(result.lines[0].hard_break); // end of paragraph "aa", not the last paragraph
        assert!(result.lines[1].hard_break); // end of paragraph "bb", not the last paragraph
        assert!(!result.lines[2].hard_break); // end of "cc", the LAST paragraph
    }

    #[test]
    fn y_increases_by_line_height_across_the_whole_wrapped_text_not_per_paragraph() {
        let font = monospace_font();
        let options = WrapOptions {
            width: 1000.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("a\nb\nc", &options).unwrap();
        let step = result.lines[1].y - result.lines[0].y;
        assert!((step - result.line_height).abs() < 1e-9);
        let step2 = result.lines[2].y - result.lines[1].y;
        assert!((step2 - result.line_height).abs() < 1e-9);
    }

    #[test]
    fn alignment_center_uses_indent_and_right_does_not() {
        let font = monospace_font();
        let indents = [20.0];
        let base = WrapOptions {
            width: 100.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: Some(&indents),
        };
        let left = wrap_text("hi", &base).unwrap();
        let center = wrap_text(
            "hi",
            &WrapOptions {
                align: Align::Center,
                ..base
            },
        )
        .unwrap();
        let right = wrap_text(
            "hi",
            &WrapOptions {
                align: Align::Right,
                ..base
            },
        )
        .unwrap();

        let line_width = left.lines[0].width;
        assert_eq!(left.lines[0].x, 20.0); // left: x == indent
        assert_eq!(center.lines[0].x, 20.0 + (100.0 - 20.0 - line_width) / 2.0);
        // Right deliberately ignores indent entirely (preserved TS quirk).
        assert_eq!(right.lines[0].x, 100.0 - line_width);
    }

    #[test]
    fn list_indent_greater_than_or_equal_to_width_errors() {
        let font = monospace_font();
        let indents = [50.0];
        let options = WrapOptions {
            width: 50.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: Some(&indents),
        };
        let err = wrap_text("hi", &options).unwrap_err();
        assert_eq!(
            err.message(),
            "list indent is greater than text box width, cannot lay out"
        );
    }

    #[test]
    fn zero_or_negative_width_errors() {
        let font = monospace_font();
        let options = WrapOptions {
            width: 0.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let err = wrap_text("hi", &options).unwrap_err();
        assert_eq!(
            err.message(),
            "text box width must be a number greater than 0"
        );

        let options_neg = WrapOptions {
            width: -5.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        assert!(wrap_text("hi", &options_neg).is_err());
    }

    #[test]
    fn carriage_return_in_text_errors() {
        let font = monospace_font();
        let options = WrapOptions {
            width: 100.0,
            font: &font,
            font_size_px: 10.0,
            align: Align::Left,
            indents: None,
        };
        let err = wrap_text("a\rb", &options).unwrap_err();
        assert_eq!(
            err.message(),
            "text content does not accept \\r, use \\n for hard line breaks"
        );
    }

    #[test]
    fn ascent_and_line_height_derive_from_font_metrics() {
        let font = monospace_font(); // ascender=800, descender=-200, line_gap=0, upm=1000
        let options = WrapOptions {
            width: 1000.0,
            font: &font,
            font_size_px: 100.0,
            align: Align::Left,
            indents: None,
        };
        let result = wrap_text("hi", &options).unwrap();
        // ascent = 800/1000 * 100 = 80
        assert_eq!(result.ascent, 80.0);
        // line_height = (800 - (-200) + 0)/1000 * 100 = 100
        assert_eq!(result.line_height, 100.0);
        assert_eq!(
            result.height,
            result.lines.len() as f64 * result.line_height
        );
    }
}
