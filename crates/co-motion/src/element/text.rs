//! `text set` / `text style set` / `text list set` / `textbox add` /
//! `textbox width` / `textbox align` (plan section 1.1, phase P6). Ported
//! from `packages/core/src/element-text.ts` and the pure-logic half of
//! `packages/core/src/workspace.ts`'s `addTextBox`.
//!
//! None of these six commands call `assert_slide_compliant` — verified by
//! grepping the TS source (`element-text.ts` never imports it, and
//! `workspace.ts`'s `addTextBox` doc comment explains why: gating text-box
//! creation on compliance would make it impossible to add one to a
//! freshly-created deck, whose default slide is itself non-compliant until
//! `convert` runs). This is a real divergence from every `element::edit`/
//! `element::group`/`element::arrange` command, which all open with it — do
//! not "fix" it by adding the call here.
//!
//! `fonts` is a required (non-`Option`) parameter on every function here,
//! unlike the TS originals' `fontBook?`/`ReplaceElementTextOptions.fontBook?`
//! optional shape: TS's own comment on `renderPlainTextContent` notes "every
//! real `text set` goes through `setElementText`, which always resolves the
//! presentation's fonts" — the optionality exists only for the pure
//! function's other (non-CLI) callers, which this ticket has none of.

use crate::element::assert_not_locked;
use crate::element::splice::{Splice, apply_splices, set_attr_splice};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::format::{
    TEXT_HEIGHT_ATTRIBUTE, TEXT_WIDTH_ATTRIBUTE, TextAlign, read_text_align,
};
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::list::{ListKind, list_indents, parse_list_tokens};
use crate::text::render::render_text_box_content;
use crate::text::runs::{RunStyleUpdate, TextRun, apply_run_style, read_text_box_runs};
use crate::text::wrap::{Align, WrapOptions, WrappedText, wrap_text};
use crate::text::{DEFAULT_FONT_FAMILY, FontMetrics, escape_xml_attr, escape_xml_text};
use std::collections::HashMap;

/// `data-comot-text-align` (NOOP-65 決定 D). Duplicated as a literal rather
/// than imported from `slide::format` — that module's own copy is private
/// (only `read_text_align` is exported), mirroring the TS original's
/// module-cycle-driven duplication of this exact constant.
const TEXT_ALIGN_ATTRIBUTE: &str = "data-comot-text-align";

/// `data-comot-list` (NOOP-65 決定 E): one whitespace-separated token per
/// paragraph, on the content `<text>` (not the container).
const LIST_ATTRIBUTE: &str = "data-comot-list";

/// `data-comot-list-marker="true"`: marks the second `<text>` a text box's
/// container may carry — the list-bullet/number glyphs, rendered as their
/// own sibling `<text>` so they never enter the content `<text>`'s
/// character-index space.
const LIST_MARKER_ATTRIBUTE: &str = "data-comot-list-marker";

fn align_to_wrap_align(align: TextAlign) -> Align {
    match align {
        TextAlign::Left => Align::Left,
        TextAlign::Center => Align::Center,
        TextAlign::Right => Align::Right,
    }
}

fn text_align_as_str(align: TextAlign) -> &'static str {
    match align {
        TextAlign::Left => "left",
        TextAlign::Center => "center",
        TextAlign::Right => "right",
    }
}

// ---------------------------------------------------------------------------
// shared small helpers (own copies — see module doc comment on duplication)
// ---------------------------------------------------------------------------

/// The container's content `<text>` children — every direct `<text>` child
/// EXCEPT the list-marker one, if any. Every "find the text child" call
/// site in this module goes through this, not a raw `tag == "text"` filter,
/// so a list marker never gets mistaken for (or counted alongside) the real
/// content.
fn content_text_children(container: &ScannedNode) -> Vec<&ScannedNode> {
    container
        .children
        .iter()
        .filter(|child| {
            child.tag == "text"
                && attribute_value(child, LIST_MARKER_ATTRIBUTE).as_deref() != Some("true")
        })
        .collect()
}

/// The container's list-marker `<text>` child, or `None` when the box has
/// no list markers at all.
fn marker_text_child(container: &ScannedNode) -> Option<&ScannedNode> {
    container.children.iter().find(|child| {
        child.tag == "text"
            && attribute_value(child, LIST_MARKER_ATTRIBUTE).as_deref() == Some("true")
    })
}

/// Reads `data-comot-list` off the content `<text>`, padded/truncated to
/// exactly `paragraph_count` tokens.
fn read_list_tokens(
    text_node: &ScannedNode,
    paragraph_count: usize,
    element_id: &str,
) -> CoMotionResult<Vec<ListKind>> {
    parse_list_tokens(
        attribute_value(text_node, LIST_ATTRIBUTE).as_deref(),
        paragraph_count,
        element_id,
    )
}

/// The index, in `lines`, of the FIRST wrapped line of each paragraph.
fn first_line_index_per_paragraph(lines: &[crate::text::wrap::WrappedLine]) -> Vec<usize> {
    let mut firsts = vec![0];
    for (i, line) in lines.iter().enumerate() {
        if line.hard_break {
            firsts.push(i + 1);
        }
    }
    firsts
}

/// The marker glyph for each paragraph, or `None` for a `"none"` paragraph
/// — `•` for bullet, `1.`/`2.`/… for number. The counter resets after any
/// non-number paragraph.
fn marker_glyphs(tokens: &[ListKind]) -> Vec<Option<String>> {
    let mut counter = 0u32;
    tokens
        .iter()
        .map(|kind| match kind {
            ListKind::Number => {
                counter += 1;
                Some(format!("{counter}."))
            }
            ListKind::Bullet => {
                counter = 0;
                Some("•".to_string())
            }
            ListKind::None => {
                counter = 0;
                None
            }
        })
        .collect()
}

/// Builds the list-marker `<text>` element's full markup, or `None` when
/// every paragraph is `"none"` (no marker element should exist at all).
fn build_marker_markup(
    tokens: &[ListKind],
    wrapped: &WrappedText,
    font_family: &str,
    font_size: f64,
    fill: Option<&str>,
) -> Option<String> {
    let glyphs = marker_glyphs(tokens);
    if glyphs.iter().all(Option::is_none) {
        return None;
    }
    let firsts = first_line_index_per_paragraph(&wrapped.lines);
    let tspans: String = glyphs
        .iter()
        .enumerate()
        .map(|(i, glyph)| match glyph {
            None => String::new(),
            Some(glyph) => {
                let y = wrapped.lines[firsts[i]].y;
                format!(
                    "<tspan x=\"0\" y=\"{}\">{}</tspan>",
                    format_svg_number(y),
                    escape_xml_text(glyph)
                )
            }
        })
        .collect();
    let fill_attr = fill
        .map(|f| format!(" fill=\"{}\"", escape_xml_attr(f)))
        .unwrap_or_default();
    Some(format!(
        "<text {LIST_MARKER_ATTRIBUTE}=\"true\" font-family=\"{}\" font-size=\"{}\"{fill_attr} xml:space=\"preserve\">{tspans}</text>",
        escape_xml_attr(font_family),
        format_svg_number(font_size)
    ))
}

/// Splices marker markup into place: replaces an existing marker node's
/// full span, inserts a brand-new one right after the content `<text>`
/// closes (so it stays the container's LAST child), or removes an existing
/// marker entirely when `markup` is `None`.
fn list_marker_splices(
    content_text_node: &ScannedNode,
    marker_node: Option<&ScannedNode>,
    markup: Option<&str>,
) -> Vec<Splice> {
    match (markup, marker_node) {
        (None, Some(marker)) => vec![Splice {
            start: marker.start,
            end: marker.end,
            text: String::new(),
        }],
        (None, None) => Vec::new(),
        (Some(markup), Some(marker)) => vec![Splice {
            start: marker.start,
            end: marker.end,
            text: markup.to_string(),
        }],
        (Some(markup), None) => vec![Splice {
            start: content_text_node.end,
            end: content_text_node.end,
            text: markup.to_string(),
        }],
    }
}

/// Removes `attr` from `node` entirely (including the whitespace right
/// before it), or `None` when it is already absent — `set_attr_splice`'s
/// missing inverse.
fn remove_attr_splice(node: &ScannedNode, attr: &str) -> Option<Splice> {
    let existing = attribute_of(node, attr)?;
    Some(Splice {
        start: existing.start,
        end: existing.end,
        text: String::new(),
    })
}

/// Same replace-if-present behavior as `set_attr_splice`, but a new
/// attribute is appended at the END of the opening tag (right before its
/// own `>`) instead of right after the tag name — needed so a rewrap that
/// adds `data-comot-text-height` to an EXISTING container (one that has
/// had other attributes, `id` included, for a long time) never reorders
/// `id` out of first position.
fn set_trailing_attr_splice(node: &ScannedNode, attr: &str, value: &str) -> Splice {
    if let Some(existing) = attribute_of(node, attr) {
        return Splice {
            start: existing.start,
            end: existing.end,
            text: format!("{attr}=\"{}\"", escape_xml_attr(value)),
        };
    }
    let insert_at = node.content_start - 1;
    Splice {
        start: insert_at,
        end: insert_at,
        text: format!(" {attr}=\"{}\"", escape_xml_attr(value)),
    }
}

fn resolve_font<'a>(
    fonts: &'a HashMap<String, Box<dyn FontMetrics>>,
    font_family: &str,
    element_id: &str,
) -> CoMotionResult<&'a dyn FontMetrics> {
    fonts
        .get(font_family)
        .map(|boxed| boxed.as_ref())
        .ok_or_else(|| {
            CoMotionError::invalid(format!(
                "簡報未內嵌字型 {font_family}，無法重新換行：{element_id}"
            ))
        })
}

/// Reads the family + size a `<text>` node's own attributes declare, for
/// re-wrapping a text box's content.
fn read_text_font_info(text_node: &ScannedNode, element_id: &str) -> CoMotionResult<(String, f64)> {
    let declared_family = attribute_value(text_node, "font-family");
    let font_family = declared_family
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_FONT_FAMILY)
        .to_string();
    let font_size_raw = attribute_value(text_node, "font-size");
    let font_size = match font_size_raw
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => 16.0,
        Some(raw) => raw.parse::<f64>().unwrap_or(f64::NAN),
    };
    if !font_size.is_finite() || font_size <= 0.0 {
        return Err(CoMotionError::invalid(format!(
            "文字框的 font-size 不是合法的正數，無法重新換行：{element_id}"
        )));
    }
    let anchor = attribute_value(text_node, "text-anchor");
    if anchor.is_some() && anchor.as_deref() != Some("start") {
        return Err(CoMotionError::invalid(format!(
            "文字框的 <text> 不可使用 text-anchor（尚未支援對齊）：{element_id}"
        )));
    }
    Ok((font_family, font_size))
}

// The set of code points XML 1.0 permits in character data (spec production
// [2] Char) — hand-written range check, no `regex` crate (plan decision D4).
fn is_xml_1_0_char(c: char) -> bool {
    matches!(c,
        '\t' | '\n' | '\r'
        | '\u{20}'..='\u{D7FF}'
        | '\u{E000}'..='\u{FFFD}'
        | '\u{10000}'..='\u{10FFFF}'
    )
}

fn assert_valid_xml_text(new_text: &str) -> CoMotionResult<()> {
    if new_text.chars().all(is_xml_1_0_char) {
        Ok(())
    } else {
        Err(CoMotionError::invalid("文字內容包含 XML 不允許的字元"))
    }
}

/// Depth-first search of the SCANNED (not parsed-slide) document tree for
/// `element_id`, over EVERY tag — not just `<g>` containers (unlike
/// `element::edit`/`element::arrange`'s `find_container`): a `text set`
/// target may be a bare `<text id="…">` with no `<g>` wrapper at all.
fn find_node_by_id<'a>(nodes: &'a [ScannedNode], element_id: &str) -> Option<&'a ScannedNode> {
    for node in nodes {
        if attribute_value(node, "id").as_deref() == Some(element_id) {
            return Some(node);
        }
        if let Some(found) = find_node_by_id(&node.children, element_id) {
            return Some(found);
        }
    }
    None
}

fn number_from(node: Option<&ScannedNode>, name: &str) -> Option<f64> {
    let raw = attribute_value(node?, name)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: f64 = trimmed.parse().ok()?;
    value.is_finite().then_some(value)
}

// ---------------------------------------------------------------------------
// text set
// ---------------------------------------------------------------------------

/// Rewrites a plain (non-text-box) `<text>`'s content for `text set`. SVG's
/// `<text>` does not break lines on newline characters, so this rebuilds
/// one `<tspan>` per line. Geometry is taken from what is already there,
/// never invented: `x`/first line's `y` come from the existing first
/// `<tspan>` (or the `<text>` itself), and the line step comes from the gap
/// between the first two existing `<tspan>`s — or, with no such gap to
/// read, the font's own line height.
fn render_plain_text_content(
    text_node: &ScannedNode,
    new_text: &str,
    element_id: &str,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
) -> CoMotionResult<String> {
    let tspans: Vec<&ScannedNode> = text_node
        .children
        .iter()
        .filter(|c| c.tag == "tspan")
        .collect();
    let lines: Vec<&str> = new_text.split('\n').collect();
    if lines.len() == 1 && tspans.is_empty() {
        return Ok(escape_xml_text(new_text));
    }

    let x = number_from(tspans.first().copied(), "x")
        .or_else(|| number_from(Some(text_node), "x"))
        .unwrap_or(0.0);
    let first_y = number_from(tspans.first().copied(), "y")
        .or_else(|| number_from(Some(text_node), "y"))
        .unwrap_or(0.0);
    let second_y = number_from(tspans.get(1).copied(), "y");

    let step = match second_y {
        Some(second_y) => second_y - first_y,
        None => {
            let (font_family, font_size) = {
                let declared_family = attribute_value(text_node, "font-family");
                let font_family = declared_family
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(DEFAULT_FONT_FAMILY)
                    .to_string();
                let font_size_raw = attribute_value(text_node, "font-size");
                let font_size = match font_size_raw
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    None => 16.0,
                    Some(raw) => raw.parse::<f64>().unwrap_or(f64::NAN),
                };
                if !font_size.is_finite() || font_size <= 0.0 {
                    return Err(CoMotionError::invalid(format!(
                        "元素的 font-size 不是合法的正數，無法排出多行文字：{element_id}"
                    )));
                }
                (font_family, font_size)
            };
            let font = resolve_font(fonts, &font_family, element_id)?;
            ((f64::from(font.ascender()) - f64::from(font.descender())
                + f64::from(font.line_gap()))
                / f64::from(font.units_per_em()))
                * font_size
        }
    };

    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        use std::fmt::Write as _;
        write!(
            out,
            "<tspan x=\"{}\" y=\"{}\">{}</tspan>",
            format_svg_number(x),
            format_svg_number(first_y + index as f64 * step),
            escape_xml_text(line)
        )
        .expect("writing to a String never fails");
    }
    Ok(out)
}

fn replace_container_text(
    svg_content: &str,
    element_id: &str,
    container: &ScannedNode,
    new_text: &str,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
) -> CoMotionResult<String> {
    let group_children_present = container.children.iter().any(|c| c.tag == "g");
    let text_children = content_text_children(container);
    if group_children_present || text_children.len() != 1 {
        return Err(CoMotionError::invalid(format!(
            "元素不是文字元素：{element_id}"
        )));
    }
    let text_node = text_children[0];
    if text_node.self_closing {
        return Err(CoMotionError::invalid(format!(
            "元素沒有文字內容：{element_id}"
        )));
    }

    let text_width_raw = attribute_value(container, TEXT_WIDTH_ATTRIBUTE);
    if let Some(text_width_raw) = text_width_raw {
        let width: f64 = text_width_raw.parse().unwrap_or(f64::NAN);
        if !width.is_finite() || width <= 0.0 {
            return Err(CoMotionError::invalid(format!(
                "元素 {element_id} 的 {TEXT_WIDTH_ATTRIBUTE} 不是合法的正數：{text_width_raw}"
            )));
        }
        let (font_family, font_size) = read_text_font_info(text_node, element_id)?;
        let font = resolve_font(fonts, &font_family, element_id)?;
        let align = read_text_align(container, element_id)?;
        // A full replace has no way to remap existing runs' character
        // ranges against the new text, and drops any existing list state
        // for the same reason (a paragraph index into text that no longer
        // exists has no defined meaning).
        let wrapped = wrap_text(
            new_text,
            &WrapOptions {
                width,
                font,
                font_size_px: font_size,
                align: align_to_wrap_align(align),
                indents: None,
            },
        )?;
        let content = render_text_box_content(&wrapped.lines, &[]);
        let list_attr_removal = remove_attr_splice(text_node, LIST_ATTRIBUTE);
        let marker_removal = list_marker_splices(text_node, marker_text_child(container), None);
        let mut splices = vec![
            Splice {
                start: text_node.content_start,
                end: text_node.content_end,
                text: content,
            },
            set_trailing_attr_splice(
                container,
                TEXT_HEIGHT_ATTRIBUTE,
                &format_svg_number(wrapped.height),
            ),
        ];
        if let Some(removal) = list_attr_removal {
            splices.push(removal);
        }
        splices.extend(marker_removal);
        return Ok(apply_splices(svg_content, &splices));
    }

    let rendered = render_plain_text_content(text_node, new_text, element_id, fonts)?;
    Ok(format!(
        "{}{}{}",
        &svg_content[..content_byte_start(svg_content, text_node.content_start)],
        rendered,
        &svg_content[content_byte_start(svg_content, text_node.content_end)..]
    ))
}

/// Converts a `ScannedNode`'s UTF-16 `content_start`/`content_end` offset
/// into the Rust byte offset a `&str` slice needs — the one place in this
/// function that is NOT routed through `apply_splices` (there is exactly
/// one substitution here, not a splice LIST, so a direct slice is simpler
/// than building a one-element `Splice` array).
fn content_byte_start(svg: &str, utf16_offset: usize) -> usize {
    crate::text::utf16_offset_to_byte_offset(svg, utf16_offset)
}

/// Replaces the text content of the element identified by `element_id`
/// (`co-motion text set`). Does NOT call `assert_slide_compliant` (see
/// module doc comment).
pub fn replace_element_text(
    svg_content: &str,
    element_id: &str,
    new_text: &str,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    assert_valid_xml_text(new_text)?;

    let roots = scan_document(svg_content)?;
    let node = find_node_by_id(&roots, element_id)
        .ok_or_else(|| CoMotionError::invalid(format!("找不到元素：{element_id}")))?;
    assert_not_locked(node, element_id, force)?;

    if node.tag == "g" {
        return replace_container_text(svg_content, element_id, node, new_text, fonts);
    }
    if node.tag != "text" {
        return Err(CoMotionError::invalid(format!(
            "元素不是文字元素：{element_id}"
        )));
    }
    if node.self_closing {
        return Err(CoMotionError::invalid(format!(
            "元素沒有文字內容：{element_id}"
        )));
    }
    let rendered = render_plain_text_content(node, new_text, element_id, fonts)?;
    Ok(format!(
        "{}{}{}",
        &svg_content[..content_byte_start(svg_content, node.content_start)],
        rendered,
        &svg_content[content_byte_start(svg_content, node.content_end)..]
    ))
}

// ---------------------------------------------------------------------------
// rewrap_text_box_content — shared by textbox width / textbox align /
// text style set / text list set, AND by element::edit's scale/resize/style
// set once they stop deferring the text-box case (see that module's doc
// comments naming this function as their eventual replacement).
// ---------------------------------------------------------------------------

struct RewrappedContent {
    updated: String,
    lines: usize,
}

/// Re-wraps a text box's `<text>` content at `new_width`/`font_family`/
/// `font_size` and splices the container's `data-comot-text-width`/
/// `data-comot-text-height` attributes and the `<text>`'s content into
/// `svg_content`. The content itself never changes here — only how it lays
/// out — so its existing runs and alignment are read back from the current
/// markup and carried forward unchanged.
#[allow(clippy::too_many_arguments)] // mirrors element-text.ts's rewrapTextBoxContent's 1:1 parameter shape
fn rewrap_text_box_content(
    svg_content: &str,
    container: &ScannedNode,
    text_node: &ScannedNode,
    width_attr_start: usize,
    width_attr_end: usize,
    new_width: f64,
    font_family: &str,
    font_size: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    element_id: &str,
) -> CoMotionResult<RewrappedContent> {
    let (source_text, runs) = read_text_box_runs(text_node, svg_content);
    let align = read_text_align(container, element_id)?;
    let font = resolve_font(fonts, font_family, element_id)?;
    let paragraph_count = source_text.split('\n').count();
    let list_tokens = read_list_tokens(text_node, paragraph_count, element_id)?;
    let indents = list_indents(&list_tokens, font_size);
    let wrapped = wrap_text(
        &source_text,
        &WrapOptions {
            width: new_width,
            font,
            font_size_px: font_size,
            align: align_to_wrap_align(align),
            indents: Some(&indents),
        },
    )?;
    let content = render_text_box_content(&wrapped.lines, &runs);
    let marker_markup = build_marker_markup(
        &list_tokens,
        &wrapped,
        font_family,
        font_size,
        attribute_value(text_node, "fill").as_deref(),
    );
    let marker_splices = list_marker_splices(
        text_node,
        marker_text_child(container),
        marker_markup.as_deref(),
    );

    let width_value = format_svg_number(new_width);
    let mut splices = vec![
        Splice {
            start: text_node.content_start,
            end: text_node.content_end,
            text: content,
        },
        Splice {
            start: width_attr_start,
            end: width_attr_end,
            text: format!("{TEXT_WIDTH_ATTRIBUTE}=\"{width_value}\""),
        },
        set_trailing_attr_splice(
            container,
            TEXT_HEIGHT_ATTRIBUTE,
            &format_svg_number(wrapped.height),
        ),
    ];
    splices.extend(marker_splices);

    Ok(RewrappedContent {
        updated: apply_splices(svg_content, &splices),
        lines: wrapped.lines.len(),
    })
}

/// Locates a text box's container/content-text-node/width-attribute triple
/// by id, with the shared "not a text box"/"not a text element" error
/// shapes every one of `textbox width`/`textbox align`/`text style set`/
/// `text list set` needs.
fn require_text_box<'a>(
    roots: &'a [ScannedNode],
    element_id: &str,
) -> CoMotionResult<(&'a ScannedNode, &'a ScannedNode)> {
    let container = find_node_by_id(roots, element_id)
        .ok_or_else(|| CoMotionError::invalid(format!("元素不是文字元素：{element_id}")))?;
    if attribute_of(container, TEXT_WIDTH_ATTRIBUTE).is_none() {
        return Err(CoMotionError::invalid(format!(
            "元素不是文字框：{element_id}"
        )));
    }
    let group_children_present = container.children.iter().any(|c| c.tag == "g");
    let text_children = content_text_children(container);
    if group_children_present || text_children.len() != 1 {
        return Err(CoMotionError::invalid(format!(
            "元素不是文字元素：{element_id}"
        )));
    }
    let text_node = text_children[0];
    if text_node.self_closing {
        return Err(CoMotionError::invalid(format!(
            "元素沒有文字內容：{element_id}"
        )));
    }
    Ok((container, text_node))
}

// ---------------------------------------------------------------------------
// textbox width
// ---------------------------------------------------------------------------

/// Re-wraps a text box's EXISTING content at a new declared width
/// (`co-motion textbox width`). The text itself is unchanged; only
/// `data-comot-text-width` and the baked-in `<tspan>`s move.
pub fn resize_text_box(
    svg_content: &str,
    element_id: &str,
    new_width: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<(String, usize)> {
    if !new_width.is_finite() || new_width <= 0.0 {
        return Err(CoMotionError::invalid("文字框寬度必須是大於 0 的數字"));
    }
    // Wrap against the value that will actually be written (4-decimal
    // `format_svg_number`), not the raw input — a positive width below
    // that rounding floor would otherwise serialize as "0" while the wrap
    // ran against the un-rounded number.
    let rounded_width: f64 = format_svg_number(new_width)
        .parse()
        .expect("format_svg_number output always reparses");
    if rounded_width <= 0.0 {
        return Err(CoMotionError::invalid(
            "文字框寬度四捨五入後不是大於 0 的數字",
        ));
    }

    let roots = scan_document(svg_content)?;
    let (container, text_node) = require_text_box(&roots, element_id)?;
    assert_not_locked(container, element_id, force)?;
    let width_attr = attribute_of(container, TEXT_WIDTH_ATTRIBUTE)
        .expect("require_text_box already checked presence");
    let (font_family, font_size) = read_text_font_info(text_node, element_id)?;

    let result = rewrap_text_box_content(
        svg_content,
        container,
        text_node,
        width_attr.start,
        width_attr.end,
        rounded_width,
        &font_family,
        font_size,
        fonts,
        element_id,
    )?;
    Ok((result.updated, result.lines))
}

// ---------------------------------------------------------------------------
// textbox align
// ---------------------------------------------------------------------------

/// `co-motion textbox align`: sets a text box's `data-comot-text-align` and
/// re-wraps its content against the new alignment. `align` is written to
/// the container FIRST, then the document is re-scanned so the rewrap's own
/// `read_text_align` call picks up the new value — every other caller of
/// `rewrap_text_box_content` carries the EXISTING alignment forward
/// unchanged, so setting it here is the one legal way to make a rewrap
/// actually change it.
pub fn realign_text_box(
    svg_content: &str,
    element_id: &str,
    align: TextAlign,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<(String, usize)> {
    let roots = scan_document(svg_content)?;
    let (container, text_node) = require_text_box(&roots, element_id)?;
    assert_not_locked(container, element_id, force)?;
    let (font_family, font_size) = read_text_font_info(text_node, element_id)?;

    let with_align = apply_splices(
        svg_content,
        &[set_attr_splice(
            container,
            TEXT_ALIGN_ATTRIBUTE,
            text_align_as_str(align),
        )],
    );
    let refreshed_roots = scan_document(&with_align)?;
    let refreshed_container = find_node_by_id(&refreshed_roots, element_id)
        .expect("the container just written to must still be findable by the same id");
    let refreshed_text_node = content_text_children(refreshed_container)[0];
    let refreshed_width_attr = attribute_of(refreshed_container, TEXT_WIDTH_ATTRIBUTE)
        .expect("require_text_box already checked presence");
    let width: f64 = refreshed_width_attr.value.parse().unwrap_or(f64::NAN);

    let result = rewrap_text_box_content(
        &with_align,
        refreshed_container,
        refreshed_text_node,
        refreshed_width_attr.start,
        refreshed_width_attr.end,
        width,
        &font_family,
        font_size,
        fonts,
        element_id,
    )?;
    Ok((result.updated, result.lines))
}

// ---------------------------------------------------------------------------
// text style set
// ---------------------------------------------------------------------------

const FONT_WEIGHT_KEYWORDS: [&str; 2] = ["normal", "bold"];

fn is_legal_font_weight(value: &str) -> bool {
    if FONT_WEIGHT_KEYWORDS.contains(&value) {
        return true;
    }
    if !value.chars().all(|c| c.is_ascii_digit()) || value.is_empty() {
        return false;
    }
    let n: u32 = match value.parse() {
        Ok(n) => n,
        Err(_) => return false,
    };
    (100..=900).contains(&n) && n % 100 == 0
}

/// `"normal"` -> clear (`None` as an update value); anything else -> set to
/// itself; the flag being absent is threaded through as `Option<Option<_>>`
/// one level up in `TextStyleUpdate`, not here.
fn to_run_style_value(raw: &str) -> Option<String> {
    if raw == "normal" {
        None
    } else {
        Some(raw.to_string())
    }
}

/// `--font-weight`/`--font-style`: `None` means the flag was omitted
/// entirely (leave that axis untouched); `Some("normal")` clears it;
/// `Some(other)` sets it.
pub struct TextStyleUpdate {
    pub font_weight: Option<String>,
    pub font_style: Option<String>,
}

/// `co-motion text style set`'s mutation primitive: sets or clears
/// `font-weight`/`font-style` over `[start, end)` of the text box's content
/// string, then re-wraps and re-renders.
pub fn set_text_run_style(
    svg_content: &str,
    element_id: &str,
    start: usize,
    end: usize,
    update: &TextStyleUpdate,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<(String, usize)> {
    if update.font_weight.is_none() && update.font_style.is_none() {
        return Err(CoMotionError::invalid(
            "text style set 至少要給 --font-weight 或 --font-style",
        ));
    }
    if let Some(weight) = &update.font_weight {
        if !is_legal_font_weight(weight) {
            return Err(CoMotionError::invalid(format!(
                "--font-weight 必須是 normal、bold 或 100 的倍數（100–900）：{weight}"
            )));
        }
    }
    if let Some(style) = &update.font_style {
        if style != "normal" && style != "italic" {
            return Err(CoMotionError::invalid(format!(
                "--font-style 必須是 normal 或 italic：{style}"
            )));
        }
    }
    if start >= end {
        return Err(CoMotionError::invalid("--range 的起點必須小於終點"));
    }

    let roots = scan_document(svg_content)?;
    let (container, text_node) = require_text_box(&roots, element_id)?;
    assert_not_locked(container, element_id, force)?;

    let (content, runs) = read_text_box_runs(text_node, svg_content);
    if end > content.encode_utf16().count() {
        return Err(CoMotionError::invalid(format!(
            "--range 超出內容長度（{}）：{start}:{end}",
            content.encode_utf16().count()
        )));
    }

    let run_update = RunStyleUpdate {
        font_weight: update.font_weight.as_deref().map(to_run_style_value),
        font_style: update.font_style.as_deref().map(to_run_style_value),
    };
    let next_runs: Vec<TextRun> = apply_run_style(&runs, start, end, &run_update);

    let (font_family, font_size) = read_text_font_info(text_node, element_id)?;
    let align = read_text_align(container, element_id)?;
    let font = resolve_font(fonts, &font_family, element_id)?;
    let width_attr = attribute_of(container, TEXT_WIDTH_ATTRIBUTE)
        .expect("require_text_box already checked presence");
    let width: f64 = width_attr.value.parse().unwrap_or(f64::NAN);
    let paragraph_count = content.split('\n').count();
    let list_tokens = read_list_tokens(text_node, paragraph_count, element_id)?;
    let indents = list_indents(&list_tokens, font_size);
    let wrapped = wrap_text(
        &content,
        &WrapOptions {
            width,
            font,
            font_size_px: font_size,
            align: align_to_wrap_align(align),
            indents: Some(&indents),
        },
    )?;
    let rendered_content = render_text_box_content(&wrapped.lines, &next_runs);
    // Styling a character range never changes the paragraph count, so any
    // existing list markers are carried forward unchanged in content —
    // only their `y` needs resyncing with the (possibly reflowed) lines.
    let marker_markup = build_marker_markup(
        &list_tokens,
        &wrapped,
        &font_family,
        font_size,
        attribute_value(text_node, "fill").as_deref(),
    );
    let marker_splices = list_marker_splices(
        text_node,
        marker_text_child(container),
        marker_markup.as_deref(),
    );

    let mut splices = vec![
        Splice {
            start: text_node.content_start,
            end: text_node.content_end,
            text: rendered_content,
        },
        set_trailing_attr_splice(
            container,
            TEXT_HEIGHT_ATTRIBUTE,
            &format_svg_number(wrapped.height),
        ),
    ];
    splices.extend(marker_splices);
    let updated = apply_splices(svg_content, &splices);
    Ok((updated, next_runs.len()))
}

// ---------------------------------------------------------------------------
// text list set
// ---------------------------------------------------------------------------

/// `co-motion text list set`'s mutation primitive: sets one paragraph's
/// list kind, re-wraps, and syncs the marker `<text>` accordingly. `kind:
/// None` on a paragraph that is already `None` is a legal no-op: returns
/// `svg_content` completely UNCHANGED (`updated == svg_content`) so the
/// caller can skip the write and occupy no undo step.
pub fn set_paragraph_list(
    svg_content: &str,
    element_id: &str,
    paragraph: usize,
    kind: ListKind,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<(String, usize)> {
    let roots = scan_document(svg_content)?;
    let (container, text_node) = require_text_box(&roots, element_id)?;
    assert_not_locked(container, element_id, force)?;

    let (content, runs) = read_text_box_runs(text_node, svg_content);
    let paragraph_count = content.split('\n').count();
    if paragraph >= paragraph_count {
        return Err(CoMotionError::invalid(format!(
            "第 {paragraph} 段不存在，這個文字框有 {paragraph_count} 段：{element_id}"
        )));
    }

    let mut next_tokens = read_list_tokens(text_node, paragraph_count, element_id)?;
    if next_tokens[paragraph] == kind && kind == ListKind::None {
        return Ok((svg_content.to_string(), paragraph_count));
    }
    next_tokens[paragraph] = kind;

    let (font_family, font_size) = read_text_font_info(text_node, element_id)?;
    let align = read_text_align(container, element_id)?;
    let font = resolve_font(fonts, &font_family, element_id)?;
    let width_attr = attribute_of(container, TEXT_WIDTH_ATTRIBUTE)
        .expect("require_text_box already checked presence");
    let width: f64 = width_attr.value.parse().unwrap_or(f64::NAN);
    let indents = list_indents(&next_tokens, font_size);
    let wrapped = wrap_text(
        &content,
        &WrapOptions {
            width,
            font,
            font_size_px: font_size,
            align: align_to_wrap_align(align),
            indents: Some(&indents),
        },
    )?;
    let rendered_content = render_text_box_content(&wrapped.lines, &runs);

    let all_none = next_tokens.iter().all(|token| *token == ListKind::None);
    let list_attr_splice = if all_none {
        remove_attr_splice(text_node, LIST_ATTRIBUTE)
    } else {
        let joined = next_tokens
            .iter()
            .map(|kind| match kind {
                ListKind::Bullet => "bullet",
                ListKind::Number => "number",
                ListKind::None => "none",
            })
            .collect::<Vec<_>>()
            .join(" ");
        Some(set_attr_splice(text_node, LIST_ATTRIBUTE, &joined))
    };
    let marker_markup = build_marker_markup(
        &next_tokens,
        &wrapped,
        &font_family,
        font_size,
        attribute_value(text_node, "fill").as_deref(),
    );
    let marker_splices = list_marker_splices(
        text_node,
        marker_text_child(container),
        marker_markup.as_deref(),
    );

    let mut splices = vec![
        Splice {
            start: text_node.content_start,
            end: text_node.content_end,
            text: rendered_content,
        },
        set_trailing_attr_splice(
            container,
            TEXT_HEIGHT_ATTRIBUTE,
            &format_svg_number(wrapped.height),
        ),
    ];
    if let Some(splice) = list_attr_splice {
        splices.push(splice);
    }
    splices.extend(marker_splices);
    let updated = apply_splices(svg_content, &splices);
    Ok((updated, paragraph_count))
}

// ---------------------------------------------------------------------------
// textbox add
// ---------------------------------------------------------------------------

pub struct AddTextBoxInput<'a> {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub text: &'a str,
    pub font_size: f64,
    pub font_family: &'a str,
    pub font_weight: Option<f64>,
    pub fill: Option<&'a str>,
    pub align: TextAlign,
}

/// Creates a new text box on a slide: a `<g>` container carrying
/// `data-comot-text-width`, appended as the last child of `<svg>`, wrapping
/// a `<text>` whose content is the wrap of `input.text` at `input.width`
/// baked into `<tspan>`s (`co-motion textbox add`). Does NOT call
/// `assert_slide_compliant` (see module doc comment). `element_id` is
/// generated by the caller, matching every other `element *`/`textbox add`
/// insert-shaped command in this crate.
pub fn add_text_box(
    svg_content: &str,
    element_id: &str,
    input: &AddTextBoxInput,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
) -> CoMotionResult<(String, usize)> {
    if !input.x.is_finite() || !input.y.is_finite() {
        return Err(CoMotionError::invalid("文字框的座標必須是有限數字"));
    }
    let font = resolve_font(fonts, input.font_family, element_id)?;

    // Wrap against the value that will actually be written, not the raw
    // input (same #76 W1-R11 reasoning as `resize_text_box`): reject before
    // any splice happens rather than persisting a width/size the wrap never
    // agreed to.
    let normalized_width: f64 = format_svg_number(input.width).parse().unwrap_or(f64::NAN);
    if normalized_width <= 0.0 {
        return Err(CoMotionError::invalid(
            "文字框寬度四捨五入後不是大於 0 的數字",
        ));
    }
    let normalized_font_size: f64 = format_svg_number(input.font_size)
        .parse()
        .unwrap_or(f64::NAN);
    if normalized_font_size <= 0.0 {
        return Err(CoMotionError::invalid(
            "文字框的 font-size 四捨五入後不是大於 0 的數字",
        ));
    }

    let wrapped = wrap_text(
        input.text,
        &WrapOptions {
            width: normalized_width,
            font,
            font_size_px: normalized_font_size,
            align: align_to_wrap_align(input.align),
            indents: None,
        },
    )?;
    let content = render_text_box_content(&wrapped.lines, &[]);

    let weight_attr = input
        .font_weight
        .map(|w| format!(" font-weight=\"{}\"", format_svg_number(w)))
        .unwrap_or_default();
    let fill_attr = input
        .fill
        .map(|f| format!(" fill=\"{}\"", escape_xml_attr(f)))
        .unwrap_or_default();
    // "只在建立當下決定" (align only ever set at insert time): `left` writes
    // no attribute at all, matching every rewrap path's "absent means left"
    // default read.
    let align_attr = match input.align {
        TextAlign::Left => String::new(),
        other => format!(" {TEXT_ALIGN_ATTRIBUTE}=\"{}\"", text_align_as_str(other)),
    };
    let markup = format!(
        "<g id=\"{element_id}\" {TEXT_WIDTH_ATTRIBUTE}=\"{}\" {TEXT_HEIGHT_ATTRIBUTE}=\"{}\"{align_attr} transform=\"translate({} {})\">\
<text font-family=\"{}\" font-size=\"{}\"{weight_attr}{fill_attr} xml:space=\"preserve\">{content}</text></g>",
        format_svg_number(normalized_width),
        format_svg_number(wrapped.height),
        format_svg_number(input.x),
        format_svg_number(input.y),
        escape_xml_attr(input.font_family),
        format_svg_number(normalized_font_size),
    );

    let updated = append_markup(svg_content, &markup)?;
    Ok((updated, wrapped.lines.len()))
}

fn append_markup(svg_content: &str, markup: &str) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))?;
    Ok(apply_splices(
        svg_content,
        &[Splice {
            start: svg_root.content_end,
            end: svg_root.content_end,
            text: markup.to_string(),
        }],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{DEFAULT_FONT_BYTES, parse_font};

    fn slide(children: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">{children}</svg>"#
        )
    }

    fn font_book() -> HashMap<String, Box<dyn FontMetrics>> {
        let mut book: HashMap<String, Box<dyn FontMetrics>> = HashMap::new();
        book.insert(
            DEFAULT_FONT_FAMILY.to_string(),
            Box::new(parse_font(DEFAULT_FONT_BYTES).unwrap()),
        );
        book
    }

    // --- text set: plain (non-text-box) <text> ---

    #[test]
    fn text_set_single_line_no_existing_tspans_is_a_plain_escaped_replace() {
        let svg = slide(r#"<text id="a">old &amp; busted</text>"#);
        let updated = replace_element_text(&svg, "a", "new <shiny>", &font_book(), false).unwrap();
        assert_eq!(updated, slide(r#"<text id="a">new &lt;shiny&gt;</text>"#));
    }

    #[test]
    fn text_set_multiline_reuses_the_gap_between_existing_tspans() {
        let svg = slide(
            r#"<text id="a"><tspan x="10" y="20">one</tspan><tspan x="10" y="35">two</tspan></text>"#,
        );
        let updated =
            replace_element_text(&svg, "a", "第一行\n第二行\n第三行", &font_book(), false).unwrap();
        assert_eq!(
            updated,
            slide(concat!(
                r#"<text id="a">"#,
                r#"<tspan x="10" y="20">第一行</tspan>"#,
                r#"<tspan x="10" y="35">第二行</tspan>"#,
                r#"<tspan x="10" y="50">第三行</tspan>"#,
                "</text>"
            ))
        );
    }

    #[test]
    fn text_set_growing_single_line_into_multiline_measures_font_line_height() {
        let svg = slide(r#"<text id="a" font-family="Noto Sans TC" font-size="16">one</text>"#);
        let updated =
            replace_element_text(&svg, "a", "第一行\n第二行", &font_book(), false).unwrap();
        // No existing tspan gap to copy, so the step must come from the
        // font's own line height — just assert it actually wrapped into two
        // distinct, increasing `y` tspans rather than pin an exact pixel
        // value to the embedded font's metrics.
        assert!(
            updated.contains(r#"<tspan x="0" y="0">第一行</tspan>"#),
            "{updated}"
        );
        assert!(updated.contains("第二行"), "{updated}");
        assert!(
            !updated.contains(r#"y="0">第二行"#),
            "second line must not sit at the same y as the first: {updated}"
        );
    }

    #[test]
    fn text_set_empty_string_clears_content() {
        let svg = slide(r#"<text id="a">hello</text>"#);
        let updated = replace_element_text(&svg, "a", "", &font_book(), false).unwrap();
        assert_eq!(updated, slide(r#"<text id="a"></text>"#));
    }

    #[test]
    fn text_set_rejects_xml_invalid_characters() {
        let svg = slide(r#"<text id="a">hi</text>"#);
        let err =
            replace_element_text(&svg, "a", "bad\u{0001}char", &font_book(), false).unwrap_err();
        assert_eq!(err.message(), "文字內容包含 XML 不允許的字元");
    }

    #[test]
    fn text_set_missing_element_is_not_found() {
        let svg = slide(r#"<text id="a">hi</text>"#);
        let err = replace_element_text(&svg, "nope", "x", &font_book(), false).unwrap_err();
        assert_eq!(err.message(), "找不到元素：nope");
    }

    #[test]
    fn text_set_respects_lock_and_force() {
        let svg = slide(r#"<text id="a" data-comot-lock="true">hi</text>"#);
        let err = replace_element_text(&svg, "a", "x", &font_book(), false).unwrap_err();
        assert!(err.message().contains("鎖定的版面骨架"));
        let updated = replace_element_text(&svg, "a", "x", &font_book(), true).unwrap();
        assert!(updated.contains(">x<"));
        assert!(updated.contains(r#"data-comot-lock="true""#));
    }

    #[test]
    fn text_set_self_closing_text_has_no_content_to_replace() {
        let svg = slide(r#"<text id="a"/>"#);
        let err = replace_element_text(&svg, "a", "x", &font_book(), false).unwrap_err();
        assert_eq!(err.message(), "元素沒有文字內容：a");
    }

    #[test]
    fn text_set_on_a_non_text_bearing_element_errors() {
        let svg = slide(r#"<rect id="a" x="0" y="0" width="1" height="1"/>"#);
        let err = replace_element_text(&svg, "a", "x", &font_book(), false).unwrap_err();
        assert_eq!(err.message(), "元素不是文字元素：a");
    }

    // --- text set: text box (<g data-comot-text-width>) ---

    /// A text box fixture whose content `<text>` is already shaped the way a
    /// real `wrap_text`/`render_text_box_content` pass would leave it — one
    /// `<tspan>` per paragraph, `data-comot-break="1"` on every tspan but
    /// the last — since `read_text_box_runs` only ever reads paragraph
    /// structure back from tspans, never from a raw `\n` character sitting
    /// directly in the `<text>` content.
    fn textbox_svg(width: &str, paragraphs: &[&str]) -> String {
        use std::fmt::Write as _;
        let mut tspans = String::new();
        for (i, text) in paragraphs.iter().enumerate() {
            let break_attr = if i + 1 < paragraphs.len() {
                " data-comot-break=\"1\""
            } else {
                ""
            };
            write!(
                tspans,
                r#"<tspan x="0" y="{}"{break_attr}>{text}</tspan>"#,
                i as f64 * 20.0
            )
            .unwrap();
        }
        slide(&format!(
            r#"<g id="tb" data-comot-text-width="{width}"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve">{tspans}</text></g>"#
        ))
    }

    #[test]
    fn text_set_on_a_text_box_rewraps_and_clears_stale_list_state() {
        let svg = slide(
            r#"<g id="tb" data-comot-text-width="200"><text font-family="Noto Sans TC" font-size="16" data-comot-list="bullet" xml:space="preserve"><tspan x="0" y="0">old</tspan></text><text data-comot-list-marker="true" font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">•</tspan></text></g>"#,
        );
        let updated = replace_element_text(&svg, "tb", "new text", &font_book(), false).unwrap();
        assert!(updated.contains(">new text<"), "{updated}");
        assert!(
            !updated.contains("data-comot-list="),
            "a full replace must clear stale list state: {updated}"
        );
        assert!(
            !updated.contains("data-comot-list-marker"),
            "a full replace must remove the stale marker element: {updated}"
        );
        assert!(updated.contains("data-comot-text-height="), "{updated}");
    }

    #[test]
    fn text_set_on_text_box_with_malformed_width_errors() {
        let svg = textbox_svg("not-a-number", &["hi"]);
        let err = replace_element_text(&svg, "tb", "x", &font_book(), false).unwrap_err();
        assert!(err.message().contains("data-comot-text-width"));
    }

    // --- textbox width ---

    #[test]
    fn textbox_width_rewraps_at_the_new_width() {
        let svg = textbox_svg("500", &["hello world"]);
        let (updated, lines) = resize_text_box(&svg, "tb", 50.0, &font_book(), false).unwrap();
        assert!(
            updated.contains(r#"data-comot-text-width="50""#),
            "{updated}"
        );
        assert!(lines >= 1);
    }

    #[test]
    fn textbox_width_non_positive_errors() {
        let svg = textbox_svg("500", &["hi"]);
        let err = resize_text_box(&svg, "tb", 0.0, &font_book(), false).unwrap_err();
        assert_eq!(err.message(), "文字框寬度必須是大於 0 的數字");
    }

    #[test]
    fn textbox_width_on_a_non_text_box_errors() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = resize_text_box(&svg, "a", 100.0, &font_book(), false).unwrap_err();
        assert_eq!(err.message(), "元素不是文字框：a");
    }

    #[test]
    fn textbox_width_respects_lock() {
        let svg = slide(
            r#"<g id="tb" data-comot-lock="true" data-comot-text-width="500"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve">hi</text></g>"#,
        );
        let err = resize_text_box(&svg, "tb", 100.0, &font_book(), false).unwrap_err();
        assert!(err.message().contains("鎖定的版面骨架"));
        assert!(resize_text_box(&svg, "tb", 100.0, &font_book(), true).is_ok());
    }

    // --- textbox align ---

    #[test]
    fn textbox_align_writes_the_attribute_and_rewraps() {
        let svg = textbox_svg("500", &["hi"]);
        let (updated, _lines) =
            realign_text_box(&svg, "tb", TextAlign::Center, &font_book(), false).unwrap();
        assert!(
            updated.contains(r#"data-comot-text-align="center""#),
            "{updated}"
        );
    }

    #[test]
    fn textbox_align_left_after_center_removes_the_attribute_on_the_next_left_call() {
        let svg = textbox_svg("500", &["hi"]);
        let (centered, _) =
            realign_text_box(&svg, "tb", TextAlign::Center, &font_book(), false).unwrap();
        let (left_again, _) =
            realign_text_box(&centered, "tb", TextAlign::Left, &font_book(), false).unwrap();
        // `set_attr_splice` always WRITES the attribute (it has no "value
        // means absent" special case) — `left` after `center` therefore
        // still leaves a literal `data-comot-text-align="left"` attribute,
        // it does not remove it the way `textbox add`'s own left-is-default
        // omission does at creation time.
        assert!(
            left_again.contains(r#"data-comot-text-align="left""#),
            "{left_again}"
        );
    }

    // --- text style set ---

    #[test]
    fn text_style_set_bold_over_a_range_wraps_it_in_a_run_tspan() {
        let svg = textbox_svg("500", &["hello world"]);
        let update = TextStyleUpdate {
            font_weight: Some("bold".to_string()),
            font_style: None,
        };
        let (updated, runs) =
            set_text_run_style(&svg, "tb", 0, 5, &update, &font_book(), false).unwrap();
        assert!(updated.contains(r#"font-weight="bold""#), "{updated}");
        // `TextRun`s are sparse — only STYLED ranges get a run object, an
        // untouched plain range is never represented as one (`apply_run_style`
        // drops a run with neither attribute set) — so "hello" bold plus
        // " world" plain is 1 run, not 2.
        assert_eq!(runs, 1);
    }

    #[test]
    fn text_style_set_requires_at_least_one_of_font_weight_or_font_style() {
        let svg = textbox_svg("500", &["hi"]);
        let update = TextStyleUpdate {
            font_weight: None,
            font_style: None,
        };
        let err = set_text_run_style(&svg, "tb", 0, 1, &update, &font_book(), false).unwrap_err();
        assert_eq!(
            err.message(),
            "text style set 至少要給 --font-weight 或 --font-style"
        );
    }

    #[test]
    fn text_style_set_rejects_illegal_font_weight_values() {
        let svg = textbox_svg("500", &["hi"]);
        let update = TextStyleUpdate {
            font_weight: Some("thicc".to_string()),
            font_style: None,
        };
        let err = set_text_run_style(&svg, "tb", 0, 1, &update, &font_book(), false).unwrap_err();
        assert!(err.message().contains("--font-weight"));
    }

    #[test]
    fn text_style_set_rejects_range_start_not_less_than_end() {
        let svg = textbox_svg("500", &["hello"]);
        let update = TextStyleUpdate {
            font_weight: Some("bold".to_string()),
            font_style: None,
        };
        let err = set_text_run_style(&svg, "tb", 3, 3, &update, &font_book(), false).unwrap_err();
        assert_eq!(err.message(), "--range 的起點必須小於終點");
    }

    #[test]
    fn text_style_set_rejects_range_beyond_content_length() {
        let svg = textbox_svg("500", &["hi"]);
        let update = TextStyleUpdate {
            font_weight: Some("bold".to_string()),
            font_style: None,
        };
        let err = set_text_run_style(&svg, "tb", 0, 99, &update, &font_book(), false).unwrap_err();
        assert!(err.message().contains("--range 超出內容長度"));
    }

    // --- text list set ---

    #[test]
    fn text_list_set_bullet_writes_the_list_attribute_and_a_marker() {
        let svg = textbox_svg("500", &["one\ntwo"]);
        let (updated, paragraphs) =
            set_paragraph_list(&svg, "tb", 0, ListKind::Bullet, &font_book(), false).unwrap();
        assert_eq!(paragraphs, 2);
        assert!(
            updated.contains(r#"data-comot-list="bullet none""#),
            "{updated}"
        );
        assert!(updated.contains("data-comot-list-marker"), "{updated}");
    }

    #[test]
    fn text_list_set_none_to_none_is_a_legal_no_op_that_writes_nothing() {
        let svg = textbox_svg("500", &["one\ntwo"]);
        let (updated, paragraphs) =
            set_paragraph_list(&svg, "tb", 0, ListKind::None, &font_book(), false).unwrap();
        assert_eq!(paragraphs, 2);
        assert_eq!(
            updated, svg,
            "a none-to-none call must not change a single byte"
        );
    }

    #[test]
    fn text_list_set_paragraph_out_of_range_errors() {
        let svg = textbox_svg("500", &["only one paragraph"]);
        let err =
            set_paragraph_list(&svg, "tb", 5, ListKind::Bullet, &font_book(), false).unwrap_err();
        assert!(err.message().contains("第 5 段不存在"));
    }

    #[test]
    fn text_list_set_all_none_after_removing_the_last_list_paragraph_clears_the_attribute() {
        let svg = textbox_svg("500", &["one\ntwo"]);
        let (with_bullet, _) =
            set_paragraph_list(&svg, "tb", 0, ListKind::Bullet, &font_book(), false).unwrap();
        let (cleared, _) =
            set_paragraph_list(&with_bullet, "tb", 0, ListKind::None, &font_book(), false).unwrap();
        assert!(!cleared.contains("data-comot-list="), "{cleared}");
        assert!(!cleared.contains("data-comot-list-marker"), "{cleared}");
    }

    // --- textbox add ---

    #[test]
    fn textbox_add_creates_a_text_box_with_declared_width_and_wraps_content() {
        let svg = slide("");
        let input = AddTextBoxInput {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            text: "hello",
            font_size: 24.0,
            font_family: DEFAULT_FONT_FAMILY,
            font_weight: None,
            fill: None,
            align: TextAlign::Left,
        };
        let (updated, lines) = add_text_box(&svg, "el-new", &input, &font_book()).unwrap();
        assert_eq!(lines, 1);
        assert!(
            updated.contains(r#"<g id="el-new" data-comot-text-width="300""#),
            "{updated}"
        );
        assert!(
            updated.contains(r#"transform="translate(10 20)""#),
            "{updated}"
        );
        // `left` is the default: no alignment attribute should be written.
        assert!(!updated.contains("data-comot-text-align"), "{updated}");
    }

    #[test]
    fn textbox_add_non_left_align_writes_the_attribute() {
        let svg = slide("");
        let input = AddTextBoxInput {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            text: "hi",
            font_size: 24.0,
            font_family: DEFAULT_FONT_FAMILY,
            font_weight: None,
            fill: None,
            align: TextAlign::Center,
        };
        let (updated, _) = add_text_box(&svg, "el-new", &input, &font_book()).unwrap();
        assert!(
            updated.contains(r#"data-comot-text-align="center""#),
            "{updated}"
        );
    }

    #[test]
    fn textbox_add_unembedded_font_family_errors() {
        let svg = slide("");
        let input = AddTextBoxInput {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            text: "hi",
            font_size: 24.0,
            font_family: "Comic Sans MS",
            font_weight: None,
            fill: None,
            align: TextAlign::Left,
        };
        let err = add_text_box(&svg, "el-new", &input, &font_book()).unwrap_err();
        assert!(err.message().contains("簡報未內嵌字型"));
    }

    #[test]
    fn textbox_add_non_positive_width_or_font_size_after_rounding_errors() {
        let svg = slide("");
        let mut input = AddTextBoxInput {
            x: 0.0,
            y: 0.0,
            width: 0.00001,
            text: "hi",
            font_size: 24.0,
            font_family: DEFAULT_FONT_FAMILY,
            font_weight: None,
            fill: None,
            align: TextAlign::Left,
        };
        let err = add_text_box(&svg, "el-new", &input, &font_book()).unwrap_err();
        assert_eq!(err.message(), "文字框寬度四捨五入後不是大於 0 的數字");

        input.width = 300.0;
        input.font_size = 0.00001;
        let err = add_text_box(&svg, "el-new", &input, &font_book()).unwrap_err();
        assert_eq!(
            err.message(),
            "文字框的 font-size 四捨五入後不是大於 0 的數字"
        );
    }
}
