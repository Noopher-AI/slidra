//! Whole-page SVG ingest for `slide add --svg` / `slide set --svg` (#303,
//! ADR-0018): the agent authors one complete page, Slidra makes it a
//! compliant slide. Steps, in order:
//!
//! 1. The root must be `<svg>`; a missing `viewBox` is filled with the
//!    canvas, a different one is rejected.
//! 2. Every top-level `<text data-slidra-text-width="…">` *declaration* is
//!    replaced by a real text box — the same markup `textbox add` writes
//!    (`element::text::build_text_box_markup`), so the page is editable,
//!    wraps, supports lists and is visible to `validate`'s text rules.
//! 3. `normalise_slide_svg` wraps remaining bare primitives, mints missing
//!    ids and lifts transforms; anything it cannot repair (`<script>`,
//!    duplicate ids, …) rejects the whole write — nothing lands.
//!
//! Declarations are an accepted *input* form only; the stored file never
//! contains one.

use crate::element::splice::{Splice, apply_splices, set_attr_splice};
use crate::element::text::{AddTextBoxInput, build_text_box_markup};
use crate::errors::{SlidraError, SlidraResult};
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
pub const ROLE_ATTRIBUTE: &str = "data-slidra-role";
use crate::text::{DEFAULT_FONT_FAMILY, FontMetrics, unescape_xml_text};
use std::collections::HashMap;

const DEFAULT_FONT_SIZE: f64 = 24.0;
const TEXT_ALIGN_ATTRIBUTE: &str = "data-slidra-text-align";
const LIST_ATTRIBUTE: &str = "data-slidra-list";

#[derive(Debug, Clone, PartialEq)]
pub struct IngestResult {
    pub svg: String,
    /// Every top-level container id, in document order.
    pub element_ids: Vec<String>,
}

fn root_svg(roots: &[ScannedNode]) -> SlidraResult<&ScannedNode> {
    let mut elements = roots
        .iter()
        .filter(|n| !n.tag.starts_with('?') && !n.tag.starts_with('!'));
    match (elements.next(), elements.next()) {
        (Some(root), None) if root.tag == "svg" => Ok(root),
        _ => Err(SlidraError::invalid(
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
) -> SlidraResult<Option<Splice>> {
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
                Err(SlidraError::invalid(format!(
                    "--svg 的 viewBox 是「{raw}」，與畫布 {} × {} 不符，必須是「{expected}」或省略",
                    format_svg_number(canvas_width),
                    format_svg_number(canvas_height)
                )))
            }
        }
    }
}

fn number_attr(node: &ScannedNode, name: &str, what: &str) -> SlidraResult<Option<f64>> {
    match attribute_value(node, name) {
        None => Ok(None),
        Some(raw) => raw
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| {
                SlidraError::invalid(format!("文字框宣告 {what} 的 {name} 不是合法數字：{raw}"))
            }),
    }
}

/// The attributes an element points at an asset with. `href` is the image
/// form, `data-slidra-media` the video/audio one; `xlink:href` is the legacy
/// spelling a pasted-in SVG may still carry.
const ASSET_REFERENCE_ATTRIBUTES: &[&str] = &["href", "xlink:href", "data-slidra-media"];

/// Rewrites a bare `assets/x.jpg` reference into `../assets/x.jpg`.
///
/// Slides live in `slides/`, so an asset reference inside a page is written
/// relative to that directory — the only form the stage's `/api/raw/slides/`
/// base resolves (#303). But every command that hands an asset path back
/// (`asset import`, `ls`) speaks *virtual* paths, which are rooted at the
/// presentation: `assets/x.jpg`. An agent that pastes what it was just given
/// therefore writes a href that resolves to `slides/assets/x.jpg` and renders
/// as a broken image — with nothing on screen saying why. Ingest closes that
/// gap the same way `slide background set` does, by prepending `../` on the
/// way in; `validate`'s `asset.missing` rule still catches everything else
/// (a typo, a deleted asset, a path that was never right).
fn asset_reference_splices(node: &ScannedNode, into: &mut Vec<Splice>) {
    for name in ASSET_REFERENCE_ATTRIBUTES {
        let Some(attribute) = attribute_of(node, name) else {
            continue;
        };
        if attribute.value.starts_with("assets/") {
            into.push(set_attr_splice(
                node,
                name,
                &format!("../{}", attribute.value),
            ));
        }
    }
    for child in &node.children {
        asset_reference_splices(child, into);
    }
}

/// Refuses a `data-slidra-role` the grammar does not define, anywhere on the
/// page. A misspelled role is not a small thing: `validate`'s role rules
/// (`role.required`, `role.node-label`, …) read the page through these
/// values, so an element carrying `headline` instead of `label` is simply
/// not seen by them — the page passes for a reason that is not true.
/// Declarations check their own role in `declaration_markup`, before they
/// are replaced; this covers every other element.
fn check_roles(node: &ScannedNode) -> SlidraResult<()> {
    if let Some(role) = attribute_value(node, ROLE_ATTRIBUTE) {
        if !ELEMENT_ROLES.contains(&role.as_str()) {
            let id = attribute_value(node, "id").unwrap_or_else(|| node.tag.clone());
            return Err(SlidraError::invalid(format!(
                "{id} 的 {ROLE_ATTRIBUTE} 不是合法角色：{role}（可用：{}）",
                ELEMENT_ROLES.join("、")
            )));
        }
    }
    for child in &node.children {
        check_roles(child)?;
    }
    Ok(())
}

/// Refuses a `<text>` that is not part of a text box.
///
/// Text on a Slidra slide is always a *text box*: it has a width, it wraps
/// by itself, and `validate`'s text rules can measure it. A raw `<text>`
/// renders — which is exactly why it is worth refusing — but it never wraps,
/// the author cannot edit it in the editor, and every text rule looks
/// straight through it, so a page full of raw text validates clean and is
/// still wrong. Legal shapes are the authored declaration (a top-level
/// `<text data-slidra-text-width>`) and a built text box (a `<text>` inside a
/// container carrying that attribute); a table or chart container
/// (`data-slidra-type`) keeps its own internal text.
///
/// The one documented raw `<text>` — a chapter page's oversized number
/// watermark — stays legal by saying what it is: `data-slidra-role="garnish"`
/// on the text or its container. That is the same word the design language
/// already uses for it, and it is the difference between decoration the
/// author meant and content that lost its text box by accident.
fn check_text_is_boxed(node: &ScannedNode, boxed: bool, top_level: bool) -> SlidraResult<()> {
    let garnish_here = attribute_value(node, ROLE_ATTRIBUTE).as_deref() == Some("garnish");
    for child in &node.children {
        if child.tag == "text" {
            let garnish = garnish_here
                || attribute_value(child, ROLE_ATTRIBUTE).as_deref() == Some("garnish");
            if boxed || garnish || (top_level && is_declaration(child)) {
                continue;
            }
            let id = attribute_value(node, "id").unwrap_or_else(|| "（無識別碼）".to_string());
            return Err(SlidraError::invalid(format!(
                "{id} 裡的 <text> 不是文字框：投影片上的文字一律寫成文字框宣告——在根 <svg> 底下放 <text {TEXT_WIDTH_ATTRIBUTE}=\"<寬度>\" x=\"…\" y=\"…\">，Slidra 會替你換行、量測，作者也才編輯得到。真的是裝飾（例如章節頁的編號浮水印）就標 {ROLE_ATTRIBUTE}=\"garnish\""
            )));
        }
        let boxed_here = attribute_of(child, TEXT_WIDTH_ATTRIBUTE).is_some()
            || attribute_of(child, "data-slidra-type").is_some();
        check_text_is_boxed(child, boxed_here, false)?;
    }
    Ok(())
}

fn is_declaration(node: &ScannedNode) -> bool {
    node.tag == "text" && attribute_of(node, TEXT_WIDTH_ATTRIBUTE).is_some()
}

fn any_nested_declaration(node: &ScannedNode) -> bool {
    node.children
        .iter()
        .any(|child| is_declaration(child) || any_nested_declaration(child))
}

/// Turns one `<text data-slidra-text-width>` declaration into text-box markup.
fn declaration_markup(
    svg: &str,
    node: &ScannedNode,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    used_ids: &mut Vec<String>,
) -> SlidraResult<String> {
    let id = match attribute_value(node, "id") {
        Some(id) => id,
        None => generate_element_id(),
    };
    let what = id.clone();
    if used_ids.contains(&id) {
        return Err(SlidraError::invalid(format!("識別碼重複：{id}")));
    }
    used_ids.push(id.clone());

    if node.children.iter().any(|c| !c.tag.starts_with('!')) {
        return Err(SlidraError::invalid(format!(
            "文字框宣告 {what} 只能放純文字，不能含 <tspan> 等子元素；一行一段，用換行分段"
        )));
    }
    let raw_text = utf16_slice(svg, node.content_start, node.content_end);
    let text = unescape_xml_text(&raw_text);
    let width = number_attr(node, TEXT_WIDTH_ATTRIBUTE, &what)?.ok_or_else(|| {
        SlidraError::invalid(format!(
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
                SlidraError::invalid(format!(
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
            return Err(SlidraError::invalid(format!(
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
    let name = attribute_value(node, "data-slidra-name");
    // A declaration's role has to be carried onto the wrapper the builder
    // emits: the declaration `<text>` itself is replaced, so anything left
    // on it is lost (#303 §B).
    let role = match attribute_value(node, ROLE_ATTRIBUTE) {
        None => None,
        Some(role) if ELEMENT_ROLES.contains(&role.as_str()) => Some(role),
        Some(other) => {
            return Err(SlidraError::invalid(format!(
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

/// Inserts `data-slidra-role` into the wrapper `<g …>` the text-box builder
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
) -> SlidraResult<IngestResult> {
    let roots = scan_document(raw)?;
    let root = root_svg(&roots)?;
    check_roles(root)?;
    check_text_is_boxed(root, false, true)?;
    let mut splices: Vec<Splice> = Vec::new();
    if let Some(splice) = viewbox_splice(raw, root, canvas_width, canvas_height)? {
        splices.push(splice);
    }
    asset_reference_splices(root, &mut splices);

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
            return Err(SlidraError::invalid(
                "文字框宣告（帶 data-slidra-text-width 的 <text>）必須直接放在根 <svg> 底下，不能包在 <g> 裡",
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
pub fn carry_metadata(new_svg: &str, old_svg: &str) -> SlidraResult<String> {
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

    fn ingest(raw: &str) -> SlidraResult<IngestResult> {
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
    fn bare_asset_reference_is_rewritten_relative_to_the_slides_directory() {
        let out = ingest(
            r##"<svg viewBox="0 0 1280 720"><image id="el-photo" x="0" y="0" width="10" height="10" href="assets/a.png"/><image id="el-keep" x="0" y="0" width="10" height="10" href="../assets/b.png"/><g id="el-clip" data-slidra-media="assets/c.webm"><rect x="0" y="0" width="10" height="10"/></g><image id="el-remote" x="0" y="0" width="10" height="10" href="https://example.com/assets/d.png"/></svg>"##,
        )
        .unwrap();
        assert!(
            out.svg.contains(r##"href="../assets/a.png""##),
            "{}",
            out.svg
        );
        assert!(
            out.svg.contains(r##"href="../assets/b.png""##),
            "{}",
            out.svg
        );
        assert!(
            out.svg
                .contains(r##"data-slidra-media="../assets/c.webm""##),
            "{}",
            out.svg
        );
        assert!(
            out.svg
                .contains(r##"href="https://example.com/assets/d.png""##),
            "{}",
            out.svg
        );
    }

    #[test]
    fn declaration_becomes_a_text_box_with_defaults() {
        let out = ingest(r##"<svg viewBox="0 0 1280 720"><text data-slidra-text-width="300" x="80" y="176">hi</text></svg>"##).unwrap();
        assert!(
            out.svg
                .contains(r##"data-slidra-text-width="300" data-slidra-text-height="##),
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
            !out.svg.contains(r##"<text data-slidra-text-width"##),
            "{}",
            out.svg
        );
        assert_eq!(out.element_ids.len(), 1);
        assert!(out.element_ids[0].starts_with("el-"));
    }

    #[test]
    fn declaration_keeps_id_name_align_weight_fill_and_list_tokens() {
        let out = ingest(r##"<svg viewBox="0 0 1280 720"><text id="el-bullets" data-slidra-name="要點" data-slidra-text-width="1120" x="80" y="176" font-size="24" font-weight="700" fill="#F4F6F8" data-slidra-text-align="center" data-slidra-list="bullet bullet">一
二
三</text></svg>"##).unwrap();
        assert!(
            out.svg.contains(
                r##"<g id="el-bullets" data-slidra-name="要點" data-slidra-text-width="1120""##
            ),
            "{}",
            out.svg
        );
        assert!(
            out.svg.contains(r##"data-slidra-text-align="center""##),
            "{}",
            out.svg
        );
        assert!(out.svg.contains(r##"<text data-slidra-list="bullet bullet none" font-family="Noto Sans TC" font-size="24" font-weight="700" fill="#F4F6F8" xml:space="preserve">"##), "{}", out.svg);
        assert!(out.svg.contains("data-slidra-list-marker"), "{}", out.svg);
        assert_eq!(out.element_ids, vec!["el-bullets".to_string()]);
    }

    #[test]
    fn declaration_with_child_elements_or_nested_placement_is_rejected() {
        let err = ingest(r##"<svg viewBox="0 0 1280 720"><text data-slidra-text-width="300" x="0" y="0"><tspan>a</tspan></text></svg>"##).unwrap_err();
        assert!(err.message().contains("純文字"), "{}", err.message());
        let err = ingest(r##"<svg viewBox="0 0 1280 720"><g><text data-slidra-text-width="300" x="0" y="0">a</text></g></svg>"##).unwrap_err();
        assert!(err.message().contains("根 <svg> 底下"), "{}", err.message());
    }

    #[test]
    fn duplicate_ids_and_forbidden_tags_are_rejected() {
        let err = ingest(r##"<svg viewBox="0 0 1280 720"><text id="a" data-slidra-text-width="300" x="0" y="0">x</text><g id="a"><rect width="1" height="1"/></g></svg>"##).unwrap_err();
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
        let old = r##"<svg viewBox="0 0 1280 720"><metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">舊備忘</slidra:notes></metadata><g id="a"><rect width="1" height="1"/></g></svg>"##;
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
