//! Whole-page SVG ingest for `slide add --svg` / `slide set --svg` (#303,
//! ADR-0018): the agent authors one complete page, CoMotion makes it a
//! compliant slide. Steps, in order:
//!
//! 1. The root must be `<svg>`; a missing `viewBox` is filled with the
//!    canvas, a different one is rejected.
//! 2. Every top-level `<text data-comot-text-width="…">` *declaration* is
//!    replaced by a real text box — the same markup `textbox add` writes
//!    (`element::text::build_text_box_markup`), so the page is editable,
//!    wraps, supports lists and is visible to `validate`'s text rules.
//! 3. `normalise_slide_svg` wraps remaining bare primitives, mints missing
//!    ids and lifts transforms; anything it cannot repair (`<script>`,
//!    duplicate ids, …) rejects the whole write — nothing lands.
//!
//! Declarations are an accepted *input* form only; the stored file never
//! contains one.

use crate::element::splice::{Splice, apply_splices};
use crate::element::text::{AddTextBoxInput, build_text_box_markup};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::id::generate_element_id;
use crate::slide::format::{TEXT_WIDTH_ATTRIBUTE, TextAlign};
use crate::slide::normalise::normalise_slide_svg;
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::list::{ListKind, parse_list_tokens};
use crate::text::runs::utf16_slice;

/// The composition roles an element may declare (#303 §B), borrowed from
/// ppt-master's shape-role grammar. They say what an element *is for*, which
/// is what `validate` can check once coordinates are the page's own
/// business: `field` — the region a relationship operates in; `node` — a
/// semantic unit; `spine` — the page's reading scaffold; `edge` — a
/// necessary connection; `label` — text attached to an owner; `garnish` —
/// decoration added *after* the relationship works, carrying no meaning.
///
/// `background` is in the list because the CLI writes it on the background
/// image container; authors never set it by hand.
pub const ELEMENT_ROLES: &[&str] = &[
    "field",
    "node",
    "spine",
    "edge",
    "label",
    "garnish",
    "background",
];

/// The attribute both authored SVG and the normalised page use.
pub const ROLE_ATTRIBUTE: &str = "data-comot-role";
use crate::text::{DEFAULT_FONT_FAMILY, FontMetrics, unescape_xml_text};
use std::collections::HashMap;

const DEFAULT_FONT_SIZE: f64 = 24.0;
const TEXT_ALIGN_ATTRIBUTE: &str = "data-comot-text-align";
const LIST_ATTRIBUTE: &str = "data-comot-list";

#[derive(Debug, Clone, PartialEq)]
pub struct IngestResult {
    pub svg: String,
    /// Every top-level container id, in document order.
    pub element_ids: Vec<String>,
}

fn root_svg(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    let mut elements = roots
        .iter()
        .filter(|n| !n.tag.starts_with('?') && !n.tag.starts_with('!'));
    match (elements.next(), elements.next()) {
        (Some(root), None) if root.tag == "svg" => Ok(root),
        _ => Err(CoMotionError::invalid(
            "--svg 的內容必須是一份以 <svg> 為根節點的完整投影片",
        )),
    }
}

/// Fills a missing `viewBox` with the canvas, rejects a different one.
fn viewbox_splice(
    svg: &str,
    root: &ScannedNode,
    canvas_width: f64,
    canvas_height: f64,
) -> CoMotionResult<Option<Splice>> {
    let expected = format!(
        "0 0 {} {}",
        format_svg_number(canvas_width),
        format_svg_number(canvas_height)
    );
    match attribute_value(root, "viewBox") {
        None => {
            let insert_at = root.start + 1 + root.tag.encode_utf16().count();
            Ok(Some(Splice {
                start: insert_at,
                end: insert_at,
                text: format!(" viewBox=\"{expected}\""),
            }))
        }
        Some(raw) => {
            let numbers: Vec<f64> = raw
                .split_whitespace()
                .filter_map(|part| part.parse::<f64>().ok())
                .collect();
            let matches = numbers.len() == 4
                && numbers[0].abs() < 0.5
                && numbers[1].abs() < 0.5
                && (numbers[2] - canvas_width).abs() < 0.5
                && (numbers[3] - canvas_height).abs() < 0.5;
            if matches {
                let _ = svg;
                Ok(None)
            } else {
                Err(CoMotionError::invalid(format!(
                    "--svg 的 viewBox 是「{raw}」，與畫布 {} × {} 不符，必須是「{expected}」或省略",
                    format_svg_number(canvas_width),
                    format_svg_number(canvas_height)
                )))
            }
        }
    }
}

fn number_attr(node: &ScannedNode, name: &str, what: &str) -> CoMotionResult<Option<f64>> {
    match attribute_value(node, name) {
        None => Ok(None),
        Some(raw) => raw
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| {
                CoMotionError::invalid(format!("文字框宣告 {what} 的 {name} 不是合法數字：{raw}"))
            }),
    }
}

fn is_declaration(node: &ScannedNode) -> bool {
    node.tag == "text" && attribute_of(node, TEXT_WIDTH_ATTRIBUTE).is_some()
}

fn any_nested_declaration(node: &ScannedNode) -> bool {
    node.children
        .iter()
        .any(|child| is_declaration(child) || any_nested_declaration(child))
}

/// Turns one `<text data-comot-text-width>` declaration into text-box markup.
fn declaration_markup(
    svg: &str,
    node: &ScannedNode,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    used_ids: &mut Vec<String>,
) -> CoMotionResult<String> {
    let id = match attribute_value(node, "id") {
        Some(id) => id,
        None => generate_element_id(),
    };
    let what = id.clone();
    if used_ids.contains(&id) {
        return Err(CoMotionError::invalid(format!("識別碼重複：{id}")));
    }
    used_ids.push(id.clone());

    if node.children.iter().any(|c| !c.tag.starts_with('!')) {
        return Err(CoMotionError::invalid(format!(
            "文字框宣告 {what} 只能放純文字，不能含 <tspan> 等子元素；一行一段，用換行分段"
        )));
    }
    let raw_text = utf16_slice(svg, node.content_start, node.content_end);
    let text = unescape_xml_text(&raw_text);
    let width = number_attr(node, TEXT_WIDTH_ATTRIBUTE, &what)?.ok_or_else(|| {
        CoMotionError::invalid(format!(
            "文字框宣告 {what} 的 {TEXT_WIDTH_ATTRIBUTE} 不是合法數字"
        ))
    })?;
    let x = number_attr(node, "x", &what)?.unwrap_or(0.0);
    let y = number_attr(node, "y", &what)?.unwrap_or(0.0);
    let font_size = number_attr(node, "font-size", &what)?.unwrap_or(DEFAULT_FONT_SIZE);
    let font_weight = match attribute_value(node, "font-weight") {
        None => None,
        Some(raw) => match raw.trim() {
            "bold" => Some(700.0),
            "normal" => Some(400.0),
            other => Some(other.parse::<f64>().map_err(|_| {
                CoMotionError::invalid(format!(
                    "文字框宣告 {what} 的 font-weight 不是合法數字：{raw}"
                ))
            })?),
        },
    };
    let font_family =
        attribute_value(node, "font-family").unwrap_or_else(|| DEFAULT_FONT_FAMILY.to_string());
    let fill = attribute_value(node, "fill");
    let align = match attribute_value(node, TEXT_ALIGN_ATTRIBUTE).as_deref() {
        None | Some("left") => TextAlign::Left,
        Some("center") => TextAlign::Center,
        Some("right") => TextAlign::Right,
        Some(other) => {
            return Err(CoMotionError::invalid(format!(
                "文字框宣告 {what} 的 {TEXT_ALIGN_ATTRIBUTE} 必須是 left、center 或 right：{other}"
            )));
        }
    };
    let paragraph_count = text.split('\n').count();
    let tokens: Vec<ListKind> = parse_list_tokens(
        attribute_value(node, LIST_ATTRIBUTE).as_deref(),
        paragraph_count,
        &what,
    )?;
    let name = attribute_value(node, "data-comot-name");
    // A declaration's role has to be carried onto the wrapper the builder
    // emits: the declaration `<text>` itself is replaced, so anything left
    // on it is lost (#303 §B).
    let role = match attribute_value(node, ROLE_ATTRIBUTE) {
        None => None,
        Some(role) if ELEMENT_ROLES.contains(&role.as_str()) => Some(role),
        Some(other) => {
            return Err(CoMotionError::invalid(format!(
                "文字框宣告 {what} 的 {ROLE_ATTRIBUTE} 不是合法角色：{other}（可用：{}）",
                ELEMENT_ROLES.join("、")
            )));
        }
    };
    let input = AddTextBoxInput {
        x,
        y,
        width,
        text: &text,
        font_size,
        font_family: &font_family,
        font_weight,
        fill: fill.as_deref(),
        align,
    };
    let (markup, _) = build_text_box_markup(&id, name.as_deref(), &input, &tokens, fonts)?;
    Ok(splice_role_attribute(markup, role.as_deref()))
}

/// Inserts `data-comot-role` into the wrapper `<g …>` the text-box builder
/// produced, right after its `id`. Returns the markup untouched when the
/// declaration carried no role.
fn splice_role_attribute(markup: String, role: Option<&str>) -> String {
    let Some(role) = role else { return markup };
    let Some(id_end) = markup.find("\" ").or_else(|| markup.find("\">")) else {
        return markup;
    };
    let insert_at = id_end + 1;
    let mut out = String::with_capacity(markup.len() + role.len() + 20);
    out.push_str(&markup[..insert_at]);
    out.push_str(&format!(" {ROLE_ATTRIBUTE}=\"{role}\""));
    out.push_str(&markup[insert_at..]);
    out
}

/// Runs the whole ingest pipeline on an agent-authored page.
pub fn ingest_slide_svg(
    raw: &str,
    canvas_width: f64,
    canvas_height: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
) -> CoMotionResult<IngestResult> {
    let roots = scan_document(raw)?;
    let root = root_svg(&roots)?;
    let mut splices: Vec<Splice> = Vec::new();
    if let Some(splice) = viewbox_splice(raw, root, canvas_width, canvas_height)? {
        splices.push(splice);
    }

    let mut used_ids: Vec<String> = Vec::new();
    collect_ids(&roots, &mut used_ids);
    // Declarations consume their own id above; drop them from the "already
    // used" list first so a declaration's own id does not collide with itself.
    for child in &root.children {
        if is_declaration(child) {
            if let Some(id) = attribute_value(child, "id") {
                used_ids.retain(|existing| existing != &id);
            }
        }
    }
    for child in &root.children {
        if is_declaration(child) {
            let markup = declaration_markup(raw, child, fonts, &mut used_ids)?;
            splices.push(Splice {
                start: child.start,
                end: child.end,
                text: markup,
            });
        } else if any_nested_declaration(child) {
            return Err(CoMotionError::invalid(
                "文字框宣告（帶 data-comot-text-width 的 <text>）必須直接放在根 <svg> 底下，不能包在 <g> 裡",
            ));
        }
    }
    let declared = apply_splices(raw, &splices);

    let normalised = normalise_slide_svg(&declared, &mut generate_element_id)?;
    // An agent-authored background image (#303 §13) is kept and locked.
    let locked = crate::slide::background::lock_declared_background(&normalised.svg)?;
    let final_roots = scan_document(&locked)?;
    let final_root = root_svg(&final_roots)?;
    let element_ids = final_root
        .children
        .iter()
        .filter(|c| c.tag == "g")
        .filter_map(|c| attribute_value(c, "id"))
        .collect();
    Ok(IngestResult {
        svg: locked,
        element_ids,
    })
}

fn collect_ids(nodes: &[ScannedNode], into: &mut Vec<String>) {
    for node in nodes {
        if let Some(id) = attribute_value(node, "id") {
            into.push(id);
        }
        collect_ids(&node.children, into);
    }
}

/// `slide set --svg` keeps the old page's `<metadata>` (notes, comments,
/// effects, transition) when the new markup carries none of its own.
pub fn carry_metadata(new_svg: &str, old_svg: &str) -> CoMotionResult<String> {
    let new_roots = scan_document(new_svg)?;
    let new_root = root_svg(&new_roots)?;
    if new_root.children.iter().any(|c| c.tag == "metadata") {
        return Ok(new_svg.to_string());
    }
    let old_roots = scan_document(old_svg)?;
    let Some(old_root) = old_roots.iter().find(|n| n.tag == "svg") else {
        return Ok(new_svg.to_string());
    };
    let Some(metadata) = old_root.children.iter().find(|c| c.tag == "metadata") else {
        return Ok(new_svg.to_string());
    };
    let metadata_text = utf16_slice(old_svg, metadata.start, metadata.end);
    let splice = Splice {
        start: new_root.content_start,
        end: new_root.content_start,
        text: metadata_text,
    };
    Ok(apply_splices(new_svg, &[splice]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{DEFAULT_FONT_BYTES, parse_font};

    fn fonts() -> HashMap<String, Box<dyn FontMetrics>> {
        let mut book: HashMap<String, Box<dyn FontMetrics>> = HashMap::new();
        book.insert(
            DEFAULT_FONT_FAMILY.to_string(),
            Box::new(parse_font(DEFAULT_FONT_BYTES).unwrap()),
        );
        book
    }

    fn ingest(raw: &str) -> CoMotionResult<IngestResult> {
        ingest_slide_svg(raw, 1280.0, 720.0, &fonts())
    }

    #[test]
    fn fills_a_missing_viewbox_and_rejects_a_different_one() {
        let out = ingest(r##"<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10"/></svg>"##).unwrap();
        assert!(
            out.svg
                .starts_with(r##"<svg viewBox="0 0 1280 720" xmlns="##),
            "{}",
            out.svg
        );
        assert_eq!(out.element_ids.len(), 1);
        let err = ingest(r##"<svg viewBox="0 0 1920 1080"></svg>"##).unwrap_err();
        assert!(err.message().contains("1280 × 720"), "{}", err.message());
        let err = ingest("<g></g>").unwrap_err();
        assert!(err.message().contains("<svg>"), "{}", err.message());
    }

    #[test]
    fn declaration_becomes_a_text_box_with_defaults() {
        let out = ingest(r##"<svg viewBox="0 0 1280 720"><text data-comot-text-width="300" x="80" y="176">hi</text></svg>"##).unwrap();
        assert!(
            out.svg
                .contains(r##"data-comot-text-width="300" data-comot-text-height="##),
            "{}",
            out.svg
        );
        assert!(
            out.svg.contains(r##"transform="translate(80 176)""##),
            "{}",
            out.svg
        );
        assert!(
            out.svg
                .contains(r##"font-family="Noto Sans TC" font-size="24" xml:space="preserve""##),
            "{}",
            out.svg
        );
        assert!(out.svg.contains("<tspan"), "{}", out.svg);
        assert!(
            !out.svg.contains(r##"<text data-comot-text-width"##),
            "{}",
            out.svg
        );
        assert_eq!(out.element_ids.len(), 1);
        assert!(out.element_ids[0].starts_with("el-"));
    }

    #[test]
    fn declaration_keeps_id_name_align_weight_fill_and_list_tokens() {
        let out = ingest(r##"<svg viewBox="0 0 1280 720"><text id="el-bullets" data-comot-name="要點" data-comot-text-width="1120" x="80" y="176" font-size="24" font-weight="700" fill="#F4F6F8" data-comot-text-align="center" data-comot-list="bullet bullet">一
二
三</text></svg>"##).unwrap();
        assert!(
            out.svg.contains(
                r##"<g id="el-bullets" data-comot-name="要點" data-comot-text-width="1120""##
            ),
            "{}",
            out.svg
        );
        assert!(
            out.svg.contains(r##"data-comot-text-align="center""##),
            "{}",
            out.svg
        );
        assert!(out.svg.contains(r##"<text data-comot-list="bullet bullet none" font-family="Noto Sans TC" font-size="24" font-weight="700" fill="#F4F6F8" xml:space="preserve">"##), "{}", out.svg);
        assert!(out.svg.contains("data-comot-list-marker"), "{}", out.svg);
        assert_eq!(out.element_ids, vec!["el-bullets".to_string()]);
    }

    #[test]
    fn declaration_with_child_elements_or_nested_placement_is_rejected() {
        let err = ingest(r##"<svg viewBox="0 0 1280 720"><text data-comot-text-width="300" x="0" y="0"><tspan>a</tspan></text></svg>"##).unwrap_err();
        assert!(err.message().contains("純文字"), "{}", err.message());
        let err = ingest(r##"<svg viewBox="0 0 1280 720"><g><text data-comot-text-width="300" x="0" y="0">a</text></g></svg>"##).unwrap_err();
        assert!(err.message().contains("根 <svg> 底下"), "{}", err.message());
    }

    #[test]
    fn duplicate_ids_and_forbidden_tags_are_rejected() {
        let err = ingest(r##"<svg viewBox="0 0 1280 720"><text id="a" data-comot-text-width="300" x="0" y="0">x</text><g id="a"><rect width="1" height="1"/></g></svg>"##).unwrap_err();
        assert!(
            err.message().contains("重複") || err.message().contains("不合規"),
            "{}",
            err.message()
        );
        let err =
            ingest(r##"<svg viewBox="0 0 1280 720"><script>evil()</script></svg>"##).unwrap_err();
        assert!(err.message().contains("不合規"), "{}", err.message());
    }

    #[test]
    fn defs_gradients_and_bleeding_ellipses_pass_through_and_get_wrapped() {
        let out = ingest(r##"<svg viewBox="0 0 1280 720"><defs><linearGradient id="glow"><stop offset="0"/></linearGradient></defs><ellipse cx="1180" cy="60" rx="420" ry="420" fill="url(#glow)" opacity="0.12"/></svg>"##).unwrap();
        assert!(out.svg.contains("<defs>"), "{}", out.svg);
        assert!(out.svg.contains(r##"<g id="el-"##), "{}", out.svg);
        assert_eq!(out.element_ids.len(), 1);
    }

    #[test]
    fn carry_metadata_only_when_the_new_page_has_none() {
        let old = r##"<svg viewBox="0 0 1280 720"><metadata><comot:notes xmlns:comot="https://co-motion.dev/ns">舊備忘</comot:notes></metadata><g id="a"><rect width="1" height="1"/></g></svg>"##;
        let fresh =
            r##"<svg viewBox="0 0 1280 720"><g id="b"><rect width="1" height="1"/></g></svg>"##;
        let carried = carry_metadata(fresh, old).unwrap();
        assert!(
            carried.starts_with(r##"<svg viewBox="0 0 1280 720"><metadata>"##),
            "{carried}"
        );
        assert!(carried.contains("舊備忘"), "{carried}");
        let own = r##"<svg viewBox="0 0 1280 720"><metadata></metadata><g id="b"><rect width="1" height="1"/></g></svg>"##;
        assert_eq!(carry_metadata(own, old).unwrap(), own);
    }
}
