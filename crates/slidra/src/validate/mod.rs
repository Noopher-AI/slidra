// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `slidra validate` — the deterministic design checker (#303,
//! ADR-0018). Every rule is computed from the slide SVGs, `project.json`,
//! the template list and the `plan/` files; nothing here is a judgement
//! call the agent makes from memory. Rules that need a plan file are
//! skipped (and the caller says so) when that file is absent.
//!
//! Rule ids are the contract's fixed strings (`text.bullet-length`,
//! `geometry.right-overflow`, ...) — the skills and the editor key on them.

use crate::errors::{SlidraError, SlidraResult};
use crate::geometry::transform::{Matrix, multiply_matrices, parse_transform};
use crate::plan::{self, DesignSpec, OutlinePlan, RELATIONSHIPS, template_name_for};
use crate::slide::scan::{ScannedNode, attribute_value, scan_document};
use crate::text::unescape_xml_text;
use crate::workspace::project::{read_project_json, read_template_entries};
use crate::workspace::{self, virtual_fs};

/// Font-derived line height of the bundled Noto Sans TC (hhea), as a
/// multiple of font-size — the same 1.448 `text::wrap` produces.
const LINE_HEIGHT: f64 = 1.45;
/// Fallbacks for a deck with no `plan/design-spec.md` at all. With a spec
/// the anchors come from its `layout` block (#303 §C) — these numbers only
/// serve the plan-free run, which validates geometry and nothing else.
const SIDE_MARGIN: f64 = 80.0;
const BOTTOM_MARGIN: f64 = 72.0;
/// How close to the canvas bottom a caption-sized (footer) text box may go.
const FOOTER_MARGIN: f64 = 16.0;
const THANK_YOU: &[&str] = &[
    "thank you",
    "thank you all",
    "thank you for listening",
    "thank you",
    "thanks",
    "q&a",
];

#[derive(Debug, Clone, PartialEq)]
pub struct ValidationError {
    pub slide: String,
    pub element: Option<String>,
    pub rule: &'static str,
    pub actual: String,
    pub limit: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidationReport {
    pub checked: usize,
    pub errors: Vec<ValidationError>,
    /// True when no `plan/` file existed, so plan-dependent rules were
    /// skipped.
    pub without_plan: bool,
}

/// Density thresholds (contract §3). Deliberately loose: `geometry.*`
/// already fails anything that physically does not fit the slide, so these
/// only have to catch the genuinely absurd — a paragraph pasted onto a
/// page, a title that is a whole sentence. Tightening them turns `validate`
/// into a taste argument the author never asked for.
#[derive(Debug, Clone, Copy)]
pub struct Density {
    pub title_chars: usize,
    pub bullet_chars: usize,
    pub bullet_lines: usize,
    pub bullets: (usize, usize),
    pub column_bullets: (usize, usize),
    pub page_chars: usize,
}

pub fn density_for(name: &str) -> Density {
    match name {
        "balanced" => Density {
            title_chars: 32,
            bullet_chars: 48,
            bullet_lines: 3,
            bullets: (2, 8),
            column_bullets: (2, 7),
            page_chars: 1400,
        },
        "text" => Density {
            title_chars: 40,
            bullet_chars: 64,
            bullet_lines: 4,
            bullets: (2, 9),
            column_bullets: (2, 8),
            page_chars: 2000,
        },
        _ => Density {
            title_chars: 24,
            bullet_chars: 32,
            bullet_lines: 2,
            bullets: (2, 7),
            column_bullets: (2, 6),
            page_chars: 1000,
        },
    }
}

/// One paragraph of a text box: its visible text and how many rendered
/// lines it wrapped to.
#[derive(Debug, Clone, PartialEq)]
pub struct Paragraph {
    pub text: String,
    pub lines: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextBox {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub font_size: f64,
    pub fill: Option<String>,
    /// `font-weight` is 700/bold — labels (section numbers, closing-slide
    /// short headings) are the one place small text may take the accent colour.
    pub bold: bool,
    pub paragraphs: Vec<Paragraph>,
    /// Declared composition role (#303 §B), when the author set one.
    pub role: Option<String>,
    /// Position among the page's top-level containers (document order).
    pub order: usize,
}

impl TextBox {
    pub fn lines(&self) -> usize {
        self.paragraphs.iter().map(|p| p.lines).sum()
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.lines() as f64 * LINE_HEIGHT * self.font_size
    }
    pub fn chars(&self) -> usize {
        self.paragraphs.iter().map(|p| count_chars(&p.text)).sum()
    }
    pub fn full_text(&self) -> String {
        self.paragraphs
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Shape {
    pub id: String,
    pub tag: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    /// Effective opacity (element × primitive); 1 when neither sets it.
    pub opacity: f64,
    /// Declared composition role (#303 §B), when the author set one.
    pub role: Option<String>,
    /// Position among the page's top-level containers (document order).
    pub order: usize,
}

/// One reference a page makes to a file of the presentation's own — the
/// `href` of an `<image>`, the `data-slidra-media` of a video or audio
/// element. `element` is the id of the top-level container it sits in, so a
/// report can name what the author sees.
#[derive(Debug, Clone, PartialEq)]
pub struct AssetRef {
    pub element: String,
    pub value: String,
}

/// The attributes an element points at an asset with (mirrors
/// `slide::ingest::ASSET_REFERENCE_ATTRIBUTES`).
const ASSET_REFERENCE_ATTRIBUTES: &[&str] = &["href", "xlink:href", "data-slidra-media"];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SlideFacts {
    pub background: Option<String>,
    pub notes: String,
    pub text_boxes: Vec<TextBox>,
    pub shapes: Vec<Shape>,
    /// `<slidra:transition>` present in `<metadata>`.
    pub has_transition: bool,
    /// Number of `<slidra:effect family="enter">` entries.
    pub enter_effects: usize,
    /// A `data-slidra-role="background"` element is present (#303 §13).
    pub has_background: bool,
    /// `on-click` enter effects — the page's click steps (#303 §D).
    pub click_steps: usize,
    /// Every effect's `target` id, in document order.
    pub effect_targets: Vec<String>,
    /// Every asset reference the page makes, background included.
    pub asset_refs: Vec<AssetRef>,
}

/// Characters that count toward a text budget: everything but whitespace.
/// Visible characters, whitespace excluded. Dynamic-text placeholders
/// (`{{ slide_number }}`, `{{ presentation_name }}`, …) count as 0: they are
/// substituted at display time (docs/dynamic-text.md), so the literal
/// template text is not what the audience reads — the footer must not push
/// a page over its text budget.
pub fn count_chars(text: &str) -> usize {
    strip_placeholders(text)
        .chars()
        .filter(|c| !c.is_whitespace())
        .count()
}

fn strip_placeholders(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        match rest[start + 2..].find("}}") {
            Some(len) => {
                out.push_str(&rest[..start]);
                rest = &rest[start + 2 + len + 2..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn node_text(svg: &str, node: &ScannedNode) -> String {
    let raw = crate::text::runs::utf16_slice(svg, node.content_start, node.content_end);
    // Nested `<tspan>` runs (bold/italic ranges) live inside the line's
    // content — strip every tag, keep the text between them.
    let mut out = String::new();
    let mut in_tag = false;
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    unescape_xml_text(&out)
}

fn number_attr(node: &ScannedNode, name: &str) -> Option<f64> {
    attribute_value(node, name).and_then(|v| v.trim().parse::<f64>().ok())
}

fn find_child<'a>(node: &'a ScannedNode, tag: &str) -> Option<&'a ScannedNode> {
    node.children.iter().find(|c| c.tag == tag)
}

/// Reads everything the rules need out of one slide's SVG.
pub fn read_slide_facts(svg: &str) -> SlidraResult<SlideFacts> {
    let roots = scan_document(svg)?;
    let root = roots
        .iter()
        .find(|n| n.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("root node of the slide is not <svg>"))?;
    let mut facts = SlideFacts::default();

    if let Some(style) = attribute_value(root, "style") {
        for declaration in style.split(';') {
            if let Some((key, value)) = declaration.split_once(':') {
                if key.trim() == "background-color" {
                    facts.background = Some(value.trim().to_string());
                }
            }
        }
    }
    if let Some(metadata) = find_child(root, "metadata") {
        if let Some(notes) = find_child(metadata, "slidra:notes") {
            facts.notes = node_text(svg, notes).trim().to_string();
        }
        facts.has_transition = find_child(metadata, "slidra:transition").is_some();
        if let Some(effects) = find_child(metadata, "slidra:effects") {
            facts.effect_targets = effects
                .children
                .iter()
                .filter(|c| c.tag == "slidra:effect")
                .filter_map(|c| attribute_value(c, "target"))
                .collect();
            facts.click_steps = effects
                .children
                .iter()
                .filter(|c| c.tag == "slidra:effect")
                .filter(|c| attribute_value(c, "family").as_deref() == Some("enter"))
                .filter(|c| attribute_value(c, "start").as_deref() == Some("on-click"))
                .count();
            facts.enter_effects = effects
                .children
                .iter()
                .filter(|c| c.tag == "slidra:effect")
                .filter(|c| attribute_value(c, "family").as_deref() == Some("enter"))
                .count();
        }
    }

    let mut order = 0usize;
    collect_elements(svg, root, parse_transform(None)?, &mut order, &mut facts)?;
    collect_asset_refs(root, None, &mut facts.asset_refs);

    Ok(facts)
}

/// Walks the whole page for asset references. Unlike `collect_elements` this
/// does not stop at the background: a background image is exactly as broken
/// as any other when it points at nothing. `owner` is the outermost
/// container id seen on the way down — the id the author addresses.
fn collect_asset_refs(node: &ScannedNode, owner: Option<&str>, into: &mut Vec<AssetRef>) {
    let id = attribute_value(node, "id");
    let owner_here = owner.or(id.as_deref());
    for name in ASSET_REFERENCE_ATTRIBUTES {
        if let Some(value) = attribute_value(node, name) {
            into.push(AssetRef {
                element: owner_here.unwrap_or_default().to_string(),
                value,
            });
        }
    }
    for child in &node.children {
        collect_asset_refs(child, owner_here, into);
    }
}

/// The virtual path a reference written inside `slides/00N.svg` resolves to,
/// or `None` when it addresses something outside the presentation (a
/// `data:` URI, a remote URL, a fragment) and so is no business of this
/// rule. A bare `assets/x` resolves to `slides/assets/x` — exactly the
/// broken path the stage asks for, which is why it is reported rather than
/// quietly read as if the `../` were there.
fn resolved_asset_path(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.starts_with('#')
        || value.contains("://")
        || value.starts_with("data:")
    {
        return None;
    }
    match value.strip_prefix("../") {
        Some(rest) => Some(rest.to_string()),
        None => Some(format!("slides/{value}")),
    }
}

/// Walks one level of `<g>` children, descending into any group that is not
/// itself an element.
///
/// A group made with `element group` is a `<g id=…>` wrapping other
/// elements — the members keep their own ids and carry no
/// `data-slidra-text-width` on the wrapper. Reading only the root's children
/// therefore made every grouped text box invisible to `validate`: an
/// overflowing bullet stopped being reported the moment the author (or the
/// build) grouped it with its card. Recursing fixes that; the group's own
/// `transform` composes onto its members' so their coordinates stay in
/// canvas space.
fn collect_elements(
    svg: &str,
    parent: &ScannedNode,
    inherited: Matrix,
    order: &mut usize,
    facts: &mut SlideFacts,
) -> SlidraResult<()> {
    for element in parent.children.iter().filter(|c| c.tag == "g") {
        let Some(id) = attribute_value(element, "id") else {
            continue;
        };
        let element_order = {
            let current = *order;
            *order += 1;
            current
        };
        if attribute_value(element, "data-slidra-role").as_deref() == Some("background") {
            // The page's background image (#303 §13): furniture, exempt from
            // every geometry/style/taboo rule; only its presence matters.
            facts.has_background = true;
            continue;
        }
        let role = attribute_value(element, "data-slidra-role");
        let matrix = multiply_matrices(
            &inherited,
            &parse_transform(attribute_value(element, "transform").as_deref())?,
        );
        if let Some(width) = number_attr(element, "data-slidra-text-width") {
            let Some(text) = find_child(element, "text") else {
                continue;
            };
            let font_size = number_attr(text, "font-size")
                .or_else(|| number_attr(element, "font-size"))
                .unwrap_or(24.0);
            let fill = attribute_value(text, "fill").or_else(|| attribute_value(element, "fill"));
            let bold = attribute_value(text, "font-weight")
                .or_else(|| attribute_value(element, "font-weight"))
                .is_some_and(|w| w == "700" || w == "bold");
            let mut paragraphs = Vec::new();
            let mut current: Vec<String> = Vec::new();
            let spans: Vec<&ScannedNode> =
                text.children.iter().filter(|c| c.tag == "tspan").collect();
            for (index, span) in spans.iter().enumerate() {
                current.push(node_text(svg, span));
                let ends_paragraph = attribute_value(span, "data-slidra-break").is_some()
                    || index + 1 == spans.len();
                if ends_paragraph {
                    paragraphs.push(Paragraph {
                        text: current.join(""),
                        lines: current.len(),
                    });
                    current.clear();
                }
            }
            facts.text_boxes.push(TextBox {
                id,
                x: matrix.e,
                y: matrix.f,
                width,
                font_size,
                fill,
                bold,
                paragraphs,
                role,
                order: element_order,
            });
            continue;
        }
        // A bare `<text>` (no `data-slidra-text-width`) is decoration — the
        // chapter page's 320px watermark, for instance — and is subject to
        // no rule; only real text boxes carry copy.
        let Some(primitive) = element
            .children
            .iter()
            .find(|c| c.tag == "rect" || c.tag == "ellipse")
        else {
            // Not a text box and not a shape: this is a group wrapper, so
            // its members are the elements — walk into it.
            collect_elements(svg, element, matrix, order, facts)?;
            continue;
        };
        let (width, height) = if primitive.tag == "rect" {
            (
                number_attr(primitive, "width").unwrap_or(0.0),
                number_attr(primitive, "height").unwrap_or(0.0),
            )
        } else {
            (
                2.0 * number_attr(primitive, "rx").unwrap_or(0.0),
                2.0 * number_attr(primitive, "ry").unwrap_or(0.0),
            )
        };
        let (local_x, local_y) = if primitive.tag == "rect" {
            (
                number_attr(primitive, "x").unwrap_or(0.0),
                number_attr(primitive, "y").unwrap_or(0.0),
            )
        } else {
            (
                number_attr(primitive, "cx").unwrap_or(0.0) - width / 2.0,
                number_attr(primitive, "cy").unwrap_or(0.0) - height / 2.0,
            )
        };
        let opacity = number_attr(element, "opacity").unwrap_or(1.0)
            * number_attr(primitive, "opacity").unwrap_or(1.0);
        facts.shapes.push(Shape {
            id,
            tag: primitive.tag.clone(),
            x: matrix.e + local_x,
            y: matrix.f + local_y,
            width,
            height,
            fill: attribute_value(primitive, "fill").or_else(|| attribute_value(element, "fill")),
            stroke: attribute_value(primitive, "stroke")
                .or_else(|| attribute_value(element, "stroke")),
            opacity,
            role,
            order: element_order,
        });
    }
    Ok(())
}

/// Everything `validate` needs about the presentation, gathered once.
pub struct Context<'a> {
    pub canvas_width: f64,
    pub canvas_height: f64,
    pub outline: Option<&'a OutlinePlan>,
    pub spec: Option<&'a DesignSpec>,
    pub template_names: &'a [String],
    /// Every file the presentation actually holds, as virtual paths — what
    /// `asset.missing` checks a page's references against.
    pub files: &'a [String],
}

impl Context<'_> {
    fn k(&self) -> f64 {
        self.canvas_width / 1280.0
    }
}

fn same_size(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() < 0.5
}

fn same_color(actual: &str, expected: &str) -> bool {
    actual.trim().eq_ignore_ascii_case(expected)
}

fn push(
    errors: &mut Vec<ValidationError>,
    slide: &str,
    element: Option<&str>,
    rule: &'static str,
    actual: impl Into<String>,
    limit: impl Into<String>,
    message: impl Into<String>,
) {
    errors.push(ValidationError {
        slide: slide.to_string(),
        element: element.map(str::to_string),
        rule,
        actual: actual.into(),
        limit: limit.into(),
        message: message.into(),
    });
}

/// Runs every applicable rule on one slide. `index` is 0-based; `page` is
/// the outline's entry for it when the outline has one.
pub fn check_slide(
    ctx: &Context<'_>,
    index: usize,
    slide: &str,
    facts: &SlideFacts,
    errors: &mut Vec<ValidationError>,
) {
    let n = index + 1;
    let k = ctx.k();
    let page = ctx.outline.and_then(|o| o.pages.get(index));
    let page_type = page.and_then(|p| p.page_type.as_deref());

    // --- geometry (no plan needed) ---
    // The safe area is the deck's own declared anchor, not a constant:
    // page composition is free, but every page agrees on where the page
    // ends (#303 §C).
    let (side_margin, bottom_margin, footer_margin) = match ctx.spec {
        Some(spec) => (
            spec.layout.side_margin,
            spec.layout.bottom_margin,
            spec.layout.footer_margin,
        ),
        None => (SIDE_MARGIN, BOTTOM_MARGIN, FOOTER_MARGIN),
    };
    let right_limit = ctx.canvas_width - side_margin * k;
    // Caption-sized boxes are the footer (deck title, page number): they live in the
    // bottom margin by design and may run down to the canvas edge minus
    // a hairline; everything else stops at the content zone.
    let caption_size = ctx.spec.map(|spec| spec.size("caption")).unwrap_or(18.0) * k;
    for tb in &facts.text_boxes {
        let bottom_limit = if tb.font_size <= caption_size + 0.5 {
            ctx.canvas_height - footer_margin * k
        } else {
            ctx.canvas_height - bottom_margin * k
        };
        let right = tb.x + tb.width;
        if right > right_limit + 0.5 {
            push(
                errors,
                slide,
                Some(&tb.id),
                "geometry.right-overflow",
                format!("right edge {right:.0}"),
                format!("≤ {right_limit:.0}"),
                format!(
                    "page {n} text box {} right edge {right:.0} exceeds {right_limit:.0}",
                    tb.id
                ),
            );
        }
        let bottom = tb.bottom();
        if bottom > bottom_limit + 0.5 {
            push(
                errors,
                slide,
                Some(&tb.id),
                "geometry.bottom-overflow",
                format!("bottom {bottom:.0}"),
                format!("≤ {bottom_limit:.0}"),
                format!(
                    "page {n} text box {} bottom {bottom:.0} ({} lines x 1.45 x {}) exceeds {bottom_limit:.0}",
                    tb.id,
                    tb.lines(),
                    tb.font_size
                ),
            );
        }
    }
    // --- assets (no plan needed) ---
    // A page that points at a file the presentation does not hold renders a
    // blank rectangle and says nothing about why (#303). The commonest
    // shape of this is a href copied straight from `asset import`'s
    // `assets/…` reply: written inside a slide it means
    // `slides/assets/…`. Ingest now rewrites that one on the way in, so
    // what reaches here is a reference that is genuinely broken — a typo, a
    // deleted asset, or a page written before that rewrite existed.
    for reference in &facts.asset_refs {
        let Some(resolved) = resolved_asset_path(&reference.value) else {
            continue;
        };
        if ctx.files.iter().any(|file| file == &resolved) {
            continue;
        }
        let element = reference.element.as_str();
        // Two different mistakes wear the same rule: a path that points
        // outside `assets/` altogether (the author wrote a slide-relative
        // href), and a path that is shaped right but names a file the
        // presentation does not hold. Saying which one it is saves a guess.
        let message = match resolved.strip_prefix("assets/") {
            Some(name) => format!(
                "page {n} {element} points to an asset that does not exist: {name} (use ls <presentation-id> assets to check the filename; if not imported yet, run asset import first)"
            ),
            None => format!(
                "the {} of page {n} {element} is not an asset path (slides live under slides/, assets must be written as ../assets/<filename>)",
                reference.value
            ),
        };
        push(
            errors,
            slide,
            (!element.is_empty()).then_some(element),
            "asset.missing",
            reference.value.clone(),
            "../assets/<an asset this presentation has>",
            message,
        );
    }

    // Decorative geometry (bleeding circles, rings, diagonals) may run off
    // the canvas and may carry a stroke; only a stroked rect is the "boxed
    // card" look the design language forbids.
    for shape in &facts.shapes {
        if let Some(stroke) = &shape.stroke {
            if shape.tag == "rect" && stroke.trim() != "none" {
                push(
                    errors,
                    slide,
                    Some(&shape.id),
                    "taboo.stroke",
                    format!("stroke {stroke}"),
                    "no border",
                    format!("page {n} color block {} has border {stroke}", shape.id),
                );
            }
        }
    }
    let mut columns: Vec<Vec<&TextBox>> = Vec::new();
    for tb in &facts.text_boxes {
        match columns.iter_mut().find(|col| (col[0].x - tb.x).abs() < 0.5) {
            Some(col) => col.push(tb),
            None => columns.push(vec![tb]),
        }
    }
    for col in columns.iter_mut() {
        col.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
        for pair in col.windows(2) {
            let (upper, lower) = (pair[0], pair[1]);
            if upper.bottom() > lower.y + 0.5 {
                push(
                    errors,
                    slide,
                    Some(&lower.id),
                    "geometry.text-overlap",
                    format!(
                        "previous box bottom {:.0}, this box top {:.0}",
                        upper.bottom(),
                        lower.y
                    ),
                    "previous box bottom < this box top",
                    format!("page {n} text box {} overlaps {}", upper.id, lower.id),
                );
            }
        }
    }

    // --- structure (partly plan-free) ---
    match &facts.background {
        None if !facts.has_background => push(
            errors,
            slide,
            None,
            "structure.background",
            "not set",
            "set background-color",
            format!("page {n} has no background color set"),
        ),
        None => {}
        Some(color) => {
            if let Some(spec) = ctx.spec {
                // A closing page may sit on a full primary field.
                let mut allowed = vec![spec.color("background"), spec.color("secondary_bg")];
                if page_type == Some("closing") {
                    allowed.push(spec.color("primary"));
                }
                if !allowed.iter().any(|a| same_color(color, a)) {
                    push(
                        errors,
                        slide,
                        None,
                        "structure.background",
                        color.clone(),
                        allowed.join(" or "),
                        format!(
                            "page {n} background color {color} is not background/secondary_bg of the palette"
                        ),
                    );
                }
            }
        }
    }
    if facts.notes.is_empty() {
        push(
            errors,
            slide,
            None,
            "structure.notes",
            "empty",
            "non-empty",
            format!("page {n} has no speaker notes"),
        );
    }

    // --- role (#303 §B, plan-free): the composition-role grammar. Roles
    // are optional — a page that declares none is checked exactly as
    // before — but a page that declares them must be internally coherent.
    // These check what an element is FOR, which is what stays checkable
    // once coordinates are the page's own business.
    let role_of = |role: &str| -> usize {
        facts
            .text_boxes
            .iter()
            .filter(|t| t.role.as_deref() == Some(role))
            .count()
            + facts
                .shapes
                .iter()
                .filter(|sh| sh.role.as_deref() == Some(role))
                .count()
    };

    for tb in &facts.text_boxes {
        if tb.role.as_deref() == Some("garnish") {
            push(
                errors,
                slide,
                Some(&tb.id),
                "role.garnish-meaning",
                "garnish is a text box",
                "garnish does not carry text",
                format!(
                    "page {n} {} is marked garnish but is a text box -- decoration should not carry meaning, relabel as label/node or remove the text",
                    tb.id
                ),
            );
        }
    }

    // Decoration is added AFTER the relationship works, so it has no step of
    // its own to be told in — the role decides this, not the element's name
    // (ppt-master does the same: `decoration` is excluded by the compiler).
    for target in &facts.effect_targets {
        let is_garnish = facts
            .text_boxes
            .iter()
            .any(|t| &t.id == target && t.role.as_deref() == Some("garnish"))
            || facts
                .shapes
                .iter()
                .any(|sh| &sh.id == target && sh.role.as_deref() == Some("garnish"));
        if is_garnish {
            push(
                errors,
                slide,
                Some(target),
                "role.garnish-animated",
                "garnish has animation",
                "garnish does not take effects",
                format!(
                    "page {n} {target} is garnish but has an entrance effect -- decoration has no step worth narrating"
                ),
            );
        }
    }

    let spines = role_of("spine");
    if spines > 1 {
        push(
            errors,
            slide,
            None,
            "role.spine-count",
            format!("{spines}"),
            "≤ 1",
            format!("page {n} has {spines} spines -- a page has only one reading spine"),
        );
    }

    let nodes = role_of("node");
    let edges = role_of("edge");
    if edges > 0 && nodes < 2 {
        push(
            errors,
            slide,
            None,
            "role.edge-endpoints",
            format!("{nodes} nodes"),
            "≥ 2 nodes",
            format!("page {n} has an edge but only {nodes} node(s) -- a connector needs two ends"),
        );
    }

    let node_shapes = facts
        .shapes
        .iter()
        .filter(|sh| sh.role.as_deref() == Some("node"))
        .count();
    let labels = role_of("label");
    if node_shapes > 0 && labels < node_shapes {
        push(
            errors,
            slide,
            None,
            "role.node-label",
            format!("{labels} labels / {node_shapes} node color blocks"),
            "label count is not fewer than node color blocks",
            format!(
                "page {n} has {node_shapes} node shapes but only {labels} label(s) -- an unlabeled node is not a semantic unit"
            ),
        );
    }

    // --- motion (outline only) ---
    if let Some(outline) = ctx.outline {
        let animation = outline.animation.as_str();
        if animation != "none" && !facts.has_transition {
            push(
                errors,
                slide,
                None,
                "motion.transition",
                "no transition",
                "each page has <slidra:transition>",
                format!("page {n} has no transition set (plan animation={animation})"),
            );
        }
        // #303: the plan says every page carries a background image, so a
        // page without one is a build that silently skipped `slide
        // background set` — the one step with no other way to notice it
        // (the page still renders, just not as planned).
        if outline.background == "on" && !facts.has_background {
            push(
                errors,
                slide,
                None,
                "structure.background-image",
                "no background image",
                "an image element with data-slidra-role=background",
                format!("page {n} has no background image (plan background=on)"),
            );
        }
        let needs_enter = match animation {
            "full" => true,
            "minimal" => matches!(page_type, Some("cover" | "bullets" | "compare")),
            _ => false,
        };
        if needs_enter && facts.enter_effects == 0 {
            push(
                errors,
                slide,
                None,
                "motion.enter",
                "0 entrance effects",
                "≥ 1 enter effect",
                format!("page {n} has no entrance effect (plan animation={animation})"),
            );
        }
    }

    // --- #303: the metadata that makes every rule below possible is not
    // optional. Both of these were opt-in first, and the first real run
    // showed what opt-in means in practice: the build wrote neither, so
    // every blueprint and role rule sat silent while the deck came out as
    // four variations of the same page.
    if let Some(page) = page {
        let confirmed = ctx.outline.is_some_and(|o| o.status == "confirmed");
        if confirmed && page.blueprint.is_none() {
            push(
                errors,
                slide,
                None,
                "blueprint.required",
                "missing blueprint",
                "every page must have a blueprint",
                format!(
                    "page {n} has no recorded composition decision -- add a blueprint (shape/nodes/steps) for this page in plan/outline.md"
                ),
            );
        }
        // A page that carries a relationship has semantic units; say which
        // elements they are. `none` pages (cover, a single number, a closing
        // claim) have no relationship to carry and so need no nodes.
        if page.relationship != "none" {
            let nodes = facts
                .text_boxes
                .iter()
                .filter(|t| t.role.as_deref() == Some("node"))
                .count()
                + facts
                    .shapes
                    .iter()
                    .filter(|sh| sh.role.as_deref() == Some("node"))
                    .count();
            if nodes == 0 {
                push(
                    errors,
                    slide,
                    None,
                    "role.required",
                    "missing node",
                    "≥ 1 data-slidra-role=node",
                    format!(
                        "page {n} is a {} relationship but has no node marked -- every semantic unit needs a marked role (see guide section 3b)",
                        page.relationship
                    ),
                );
            }
        }
    }

    // --- blueprint (#303 §D): the build's composition-reasoning step, reconciled against
    // the page it then drew. Only pages whose plan carries a blueprint are
    // checked — the step is written down precisely so it stops being a
    // private thought nothing can verify.
    if let Some(blueprint) = page.and_then(|p| p.blueprint.as_ref()) {
        let nodes = facts
            .text_boxes
            .iter()
            .filter(|t| t.role.as_deref() == Some("node"))
            .count()
            + facts
                .shapes
                .iter()
                .filter(|sh| sh.role.as_deref() == Some("node"))
                .count();
        if nodes != blueprint.nodes {
            push(
                errors,
                slide,
                None,
                "blueprint.nodes",
                format!("{nodes}"),
                format!("{}", blueprint.nodes),
                format!(
                    "page {n} drew {nodes} nodes, but the composition specifies {} -- change the page or the composition, do not let them disagree",
                    blueprint.nodes
                ),
            );
        }
        if facts.click_steps != blueprint.steps {
            push(
                errors,
                slide,
                None,
                "blueprint.steps",
                format!("{} steps", facts.click_steps),
                format!("{} steps", blueprint.steps),
                format!(
                    "page {n} has {} on-click steps, but the composition specifies {} steps",
                    facts.click_steps, blueprint.steps
                ),
            );
        }
    }

    // --- plan-dependent rules ---
    let Some(spec) = ctx.spec else {
        if let Some(page) = page {
            check_rhythm(n, slide, page.rhythm.as_str(), None, k, facts, errors);
        }
        return;
    };
    let density = density_for(&spec.density);
    let title_size = spec.size("title") * k;
    let body_sizes = [spec.size("body") * k, spec.size("column") * k];

    // --- structure.scrim (#303 §13): copy over a background image must sit
    // on a panel that keeps it legible; big display text is exempt.
    if facts.has_background {
        let caption_size = spec.size("caption") * k;
        let claim_size = spec.size("claim") * k;
        let scrim_fills = [spec.color("background"), spec.color("secondary_bg")];
        for tb in &facts.text_boxes {
            if tb.font_size <= caption_size + 0.5 || tb.font_size >= claim_size - 0.5 {
                continue;
            }
            let bottom = tb.bottom();
            let right = tb.x + tb.width;
            let covered = facts.shapes.iter().any(|shape| {
                shape.tag == "rect"
                    && shape.order < tb.order
                    && shape.opacity >= 0.6
                    && shape
                        .fill
                        .as_deref()
                        .is_some_and(|f| scrim_fills.iter().any(|s| same_color(f, s)))
                    && shape.x <= tb.x + 0.5
                    && shape.y <= tb.y + 0.5
                    && shape.x + shape.width + 0.5 >= right
                    && shape.y + shape.height + 0.5 >= bottom
            });
            if !covered {
                push(
                    errors,
                    slide,
                    Some(&tb.id),
                    "structure.scrim",
                    "missing scrim panel",
                    "text box lies entirely within a background/secondary_bg rect",
                    format!(
                        "page {n} has a background image, but text box {} has no panel covering the background beneath it (scrim)",
                        tb.id
                    ),
                );
            }
        }
    }

    let titles: Vec<&TextBox> = facts
        .text_boxes
        .iter()
        .filter(|tb| tb.font_size >= title_size - 0.5)
        .collect();
    if titles.len() != 1 {
        push(
            errors,
            slide,
            None,
            "focus.single-title",
            format!("{}", titles.len()),
            "exactly 1",
            format!(
                "page {n} has {} text box(es) with title role (font size >= {title_size:.0})",
                titles.len()
            ),
        );
    }
    if let Some(title) = facts.text_boxes.iter().max_by(|a, b| {
        a.font_size
            .partial_cmp(&b.font_size)
            .unwrap_or(std::cmp::Ordering::Equal)
    }) {
        let chars = title.chars();
        if chars > density.title_chars {
            push(
                errors,
                slide,
                Some(&title.id),
                "text.title-length",
                format!("{chars} characters"),
                format!("≤ {} characters", density.title_chars),
                format!(
                    "page {n} title has {chars} characters, limit is {} characters",
                    density.title_chars
                ),
            );
        }
    }

    let body_boxes: Vec<&TextBox> = facts
        .text_boxes
        .iter()
        .filter(|tb| body_sizes.iter().any(|s| same_size(tb.font_size, *s)))
        .collect();
    for tb in &body_boxes {
        for (i, paragraph) in tb.paragraphs.iter().enumerate() {
            let chars = count_chars(&paragraph.text);
            if chars > density.bullet_chars {
                push(
                    errors,
                    slide,
                    Some(&tb.id),
                    "text.bullet-length",
                    format!("{chars} characters"),
                    format!("≤ {} characters", density.bullet_chars),
                    format!(
                        "page {n} bullet point {} has {chars} characters, limit is {} characters",
                        i + 1,
                        density.bullet_chars
                    ),
                );
            }
            if paragraph.lines > density.bullet_lines {
                push(
                    errors,
                    slide,
                    Some(&tb.id),
                    "text.bullet-lines",
                    format!("{} lines", paragraph.lines),
                    format!("≤ {} lines", density.bullet_lines),
                    format!(
                        "page {n} bullet point {} wraps to {} lines, limit is {} lines",
                        i + 1,
                        paragraph.lines,
                        density.bullet_lines
                    ),
                );
            }
        }
    }
    let is_compare = page_type == Some("compare") || (page_type.is_none() && body_boxes.len() >= 2);
    let skip_count = matches!(page_type, Some("cover" | "section" | "number" | "closing"))
        || body_boxes.is_empty();
    if !skip_count {
        if is_compare {
            // Each keyword may sit in its own box: count per column (left =
            // x < half the canvas), summed across that column's boxes.
            let (lo, hi) = density.column_bullets;
            let half = ctx.canvas_width / 2.0;
            let left: Vec<&TextBox> = body_boxes
                .iter()
                .copied()
                .filter(|tb| tb.x < half)
                .collect();
            let right: Vec<&TextBox> = body_boxes
                .iter()
                .copied()
                .filter(|tb| tb.x >= half)
                .collect();
            for (label, column) in [("left", left), ("right", right)] {
                let count: usize = column.iter().map(|tb| tb.paragraphs.len()).sum();
                if count < lo || count > hi {
                    push(
                        errors,
                        slide,
                        column.first().map(|tb| tb.id.as_str()),
                        "text.bullet-count",
                        format!("{count} items"),
                        format!("{lo}-{hi} items"),
                        format!(
                            "page {n} comparison column {label} has {count} bullet points, should be {lo}-{hi}"
                        ),
                    );
                }
            }
        } else {
            let (lo, hi) = density.bullets;
            let count: usize = body_boxes.iter().map(|tb| tb.paragraphs.len()).sum();
            if count < lo || count > hi {
                push(
                    errors,
                    slide,
                    body_boxes.first().map(|tb| tb.id.as_str()),
                    "text.bullet-count",
                    format!("{count} items"),
                    format!("{lo}-{hi} items"),
                    format!("page {n} has {count} bullet points, should be {lo}-{hi}"),
                );
            }
        }
    }
    let total: usize = facts.text_boxes.iter().map(TextBox::chars).sum();
    if total > density.page_chars {
        push(
            errors,
            slide,
            None,
            "text.page-total",
            format!("{total} characters"),
            format!("≤ {} characters", density.page_chars),
            format!(
                "page {n} has {total} characters total, limit is {} characters",
                density.page_chars
            ),
        );
    }

    let allowed_sizes: Vec<f64> = plan::TYPE_ROLES.iter().map(|r| spec.size(r) * k).collect();
    // Text reversed out on a primary field (the closing page) uses the
    // background colour.
    let on_primary = facts
        .background
        .as_deref()
        .is_some_and(|bg| same_color(bg, spec.color("primary")));
    let mut text_fills = vec![spec.color("text"), spec.color("muted")];
    if on_primary {
        text_fills.push(spec.color("background"));
    }
    for tb in &facts.text_boxes {
        if !allowed_sizes.iter().any(|s| same_size(tb.font_size, *s)) {
            push(
                errors,
                slide,
                Some(&tb.id),
                "style.font-size",
                format!("{}", tb.font_size),
                "type_scale's value",
                format!(
                    "page {n} text box {} font size {} not in the font size table",
                    tb.id, tb.font_size
                ),
            );
        }
        // The accent colour is allowed on the big number and on bold labels
        // (section numbers, closing-slide short headings — ≥ column size); body-sized regular text stays
        // text／muted so small copy never drops below the contrast floor.
        let accent_ok = same_size(tb.font_size, spec.size("number") * k)
            || (tb.bold && tb.font_size >= spec.size("column") * k - 0.5);
        let accent = spec.color("accent");
        match &tb.fill {
            Some(fill) if text_fills.iter().any(|a| same_color(fill, a)) => {}
            Some(fill) if accent_ok && same_color(fill, &accent) => {}
            Some(fill) => push(
                errors,
                slide,
                Some(&tb.id),
                "style.text-fill",
                fill.clone(),
                format!(
                    "{} or {} (accent can be used for large numbers and bold labels)",
                    text_fills[0], text_fills[1]
                ),
                format!("page {n} text box {} color {fill} is not text/muted", tb.id),
            ),
            None => push(
                errors,
                slide,
                Some(&tb.id),
                "style.text-fill",
                "not set",
                format!("{} or {}", text_fills[0], text_fills[1]),
                format!("page {n} text box {} has no text color set", tb.id),
            ),
        }
    }
    let shape_fills = [
        "primary",
        "accent",
        "secondary_accent",
        "secondary_bg",
        "background",
    ]
    .map(|r| spec.color(r));
    for shape in &facts.shapes {
        match &shape.fill {
            Some(fill) if shape_fills.iter().any(|a| same_color(fill, a)) => {}
            // `none` (a ring drawn by its stroke) and `url(#…)` (a gradient
            // or pattern from `<defs>`) are decoration, not a competing colour.
            Some(fill) if fill.trim() == "none" || fill.trim().starts_with("url(") => {}
            Some(fill) => push(
                errors,
                slide,
                Some(&shape.id),
                "style.shape-fill",
                fill.clone(),
                "primary/accent/secondary_accent/secondary_bg/background of the palette, none, or url(#...)",
                format!(
                    "page {n} color block {} color {fill} is not in the palette",
                    shape.id
                ),
            ),
            None => push(
                errors,
                slide,
                Some(&shape.id),
                "style.shape-fill",
                "not set",
                "a color in the palette",
                format!("page {n} color block {} has no fill", shape.id),
            ),
        }
    }

    if let Some(page) = page {
        // #303 §A': the roster only checks a page that CLAIMS to be a known
        // solution. A page with no `type` composed its own answer to the
        // relationship, and has no signature to match.
        if let Some(declared_type) = page.page_type.as_deref() {
            let signature = match declared_type {
                "cover" => "cover",
                "section" => "section",
                "number" => "number",
                "closing" => "claim",
                _ => "title",
            };
            let expected = spec.size(signature) * k;
            if !facts
                .text_boxes
                .iter()
                .any(|tb| same_size(tb.font_size, expected))
            {
                push(
                    errors,
                    slide,
                    None,
                    "roster.page-type",
                    format!("no text box with font size {expected:.0}"),
                    format!("{declared_type} page must have font size {expected:.0}"),
                    format!(
                        "page {n} plan declares a {declared_type} page, but has no text box with font size {expected:.0}"
                    ),
                );
            }
        }
        check_rhythm(n, slide, page.rhythm.as_str(), Some(spec), k, facts, errors);
    }
}

/// A "panel" is a card-sized rect in the secondary background colour —
/// the card-grid look a breathing page must not have. Decorative geometry
/// (bars, rings, bleeding circles) does not count. Without a design spec
/// the panel colour is unknown, so any rect ≥ 200 × 80 counts.
fn is_panel(shape: &Shape, spec: Option<&DesignSpec>, k: f64) -> bool {
    if shape.tag != "rect" || shape.width < 200.0 * k - 0.5 || shape.height < 80.0 * k - 0.5 {
        return false;
    }
    match spec {
        Some(spec) => shape
            .fill
            .as_deref()
            .is_some_and(|fill| same_color(fill, spec.color("secondary_bg"))),
        None => true,
    }
}

fn check_rhythm(
    n: usize,
    slide: &str,
    rhythm: &str,
    spec: Option<&DesignSpec>,
    k: f64,
    facts: &SlideFacts,
    errors: &mut Vec<ValidationError>,
) {
    if rhythm != "breathing" {
        return;
    }
    let panels = facts.shapes.iter().filter(|s| is_panel(s, spec, k)).count();
    if panels > 2 {
        push(
            errors,
            slide,
            None,
            "rhythm.breathing-cards",
            format!("{panels} panels"),
            "≤ 2",
            format!("page {n} is a breather page but has {panels} panels (secondary_bg cards)"),
        );
    }
}

/// Deck-wide rules that need every slide's facts.
pub fn check_deck(
    ctx: &Context<'_>,
    slides: &[(String, SlideFacts)],
    errors: &mut Vec<ValidationError>,
) {
    // #303 — a deck whose pages are mostly one relationship is a deck that
    // was not thought about: every page then carries the same information
    // shape, and no amount of layout variety makes them read differently.
    // Observed for real — a four-page deck with three `membership` pages
    // came out as three versions of the same page.
    if let Some(outline) = ctx.outline {
        let total = outline.pages.len();
        if total >= 4 {
            for candidate in RELATIONSHIPS {
                let count = outline
                    .pages
                    .iter()
                    .filter(|p| p.relationship == *candidate)
                    .count();
                if count * 2 > total {
                    let slide = slides
                        .first()
                        .map(|(path, _)| path.as_str())
                        .unwrap_or("slides/001.svg");
                    push(
                        errors,
                        slide,
                        None,
                        "roster.relationship-variety",
                        format!("{count}/{total} pages are {candidate}"),
                        "the same relationship must not exceed half",
                        format!(
                            "{count} of {total} pages are {candidate} relationships — every page has the same information structure, so they read as the same page. go back to the content and check whether some sections are actually sequence, contrast, or a single number"
                        ),
                    );
                    break;
                }
            }
        }
    }

    // #303 §A' — the anti-pattern ppt-master names outright: reusing one
    // carrier for a second page without a page job. Two ADJACENT pages that
    // carry the same relationship, chose the same composition, and hold the
    // same number of units are the same page twice. The page's own content
    // is not the justification — the relationship already said they are
    // alike — so this asks for one of the two to be composed differently.
    if let Some(outline) = ctx.outline {
        for window in outline.pages.windows(2) {
            let (first, second) = (&window[0], &window[1]);
            let (Some(a), Some(b)) = (first.blueprint.as_ref(), second.blueprint.as_ref()) else {
                continue;
            };
            if first.relationship != second.relationship || a.shape != b.shape || a.nodes != b.nodes
            {
                continue;
            }
            let Some((slide, _)) = slides.get(second.n - 1) else {
                continue;
            };
            push(
                errors,
                slide,
                None,
                "rhythm.repeated-shape",
                format!("{} × {} units", a.shape, a.nodes),
                "adjacent pages should not use the same composition to resolve the same relationship",
                format!(
                    "page {} and page {} are both {} relationships, both use {}, both have {} units -- use a different composition, or merge the two pages",
                    first.n, second.n, first.relationship, a.shape, a.nodes
                ),
            );
        }
    }

    if let Some((last_path, last)) = slides.last() {
        for tb in &last.text_boxes {
            let text = tb.full_text().trim().to_lowercase();
            if THANK_YOU.contains(&text.as_str()) {
                push(
                    errors,
                    last_path,
                    Some(&tb.id),
                    "taboo.thank-you",
                    tb.full_text().trim().to_string(),
                    "no thank-you page",
                    format!(
                        "the last page is \"{}\", the closing should be a takeaway conclusion",
                        tb.full_text().trim()
                    ),
                );
            }
        }
    }
    if let Some((_, cover)) = slides.first() {
        let cover_text: String = cover
            .text_boxes
            .iter()
            .map(TextBox::full_text)
            .collect::<Vec<_>>()
            .join("\n");
        if !cover_text.trim().is_empty() {
            for (i, (path, facts)) in slides.iter().enumerate().skip(1) {
                let text: String = facts
                    .text_boxes
                    .iter()
                    .map(TextBox::full_text)
                    .collect::<Vec<_>>()
                    .join("\n");
                if text == cover_text {
                    push(
                        errors,
                        path,
                        None,
                        "taboo.duplicate-cover",
                        "text is identical to page 1",
                        "no duplicate cover",
                        format!("the text of page {} is identical to page 1", i + 1),
                    );
                }
            }
        }
    }
    let Some(outline) = ctx.outline else {
        return;
    };
    if slides.len() != outline.pages.len() {
        let slide = slides.first().map(|(p, _)| p.as_str()).unwrap_or("");
        push(
            errors,
            slide,
            None,
            "roster.page-count",
            format!("{} pages", slides.len()),
            format!("{} pages", outline.pages.len()),
            format!(
                "presentation has {} pages, plan has {} pages",
                slides.len(),
                outline.pages.len()
            ),
        );
    }
    let mut seen: Vec<&str> = Vec::new();
    for page in &outline.pages {
        // A page that composed its own answer registers no template.
        let Some(page_type) = page.page_type.as_deref() else {
            continue;
        };
        if seen.contains(&page_type) {
            continue;
        }
        seen.push(page_type);
        let name = template_name_for(page_type);
        if !ctx.template_names.iter().any(|t| t == name) {
            let slide = slides
                .get(page.n - 1)
                .map(|(p, _)| p.as_str())
                .unwrap_or("");
            push(
                errors,
                slide,
                None,
                "structure.template",
                format!("no template \"{name}\""),
                format!("has template \"{name}\""),
                format!(
                    "plan uses page type {page_type}, but no template named \"{name}\" is registered"
                ),
            );
        }
    }
}

/// `slidra validate <id> [slide-path]`.
/// The rules a page must already satisfy to be written at all (`slide add
/// --svg` / `slide set --svg`).
///
/// The split is not "important rules here, unimportant ones there" — every
/// rule matters equally. It is about what fixing one costs *after* the
/// write. Everything listed here is decided by the page's own markup, so
/// the only way to fix it afterwards is to author the whole page again and
/// `slide set` it — the write that just happened was wasted work either
/// way, and refusing it turns a silent debt into an error message that says
/// what to change.
///
/// Everything NOT listed is left to `validate`, because a later command
/// puts it right without rewriting anything: the transition and enter
/// effects (`effect add`, `slide transition set`), the page's background
/// and its colour (`slide background set`, `slide style set`), the notes
/// (`slide notes set`), the template registration (`template add`), the
/// blueprint (`plan set outline`), a stroked rect (`element style set`),
/// and every deck-level rule (`roster.*`, `rhythm.*`), which cannot be
/// judged from one page at all. Gating those would make the documented
/// build order impossible: a page has to exist before it can be animated.
pub const WRITE_GATE_RULES: &[&str] = &[
    "geometry.right-overflow",
    "geometry.bottom-overflow",
    "geometry.text-overlap",
    "text.title-length",
    "text.bullet-length",
    "text.bullet-lines",
    "text.bullet-count",
    "text.page-total",
    "focus.single-title",
    "structure.scrim",
    "style.font-size",
    "style.text-fill",
    "style.shape-fill",
    "role.required",
    "role.node-label",
    "role.edge-endpoints",
    "role.spine-count",
    "role.garnish-meaning",
    "asset.missing",
];

/// Runs the write gate on one authored page, before it is written.
/// `index` is the 0-based position the page will occupy, which is what
/// decides the page number in each message and which outline entry the
/// page is judged against.
pub fn check_authored_page(
    id: &str,
    index: usize,
    slide_path: &str,
    svg: &str,
) -> SlidraResult<Vec<ValidationError>> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let project = read_project_json(&work_dir)?;
    let outline = plan::read_outline(&work_dir)?;
    let spec = plan::read_design_spec(&work_dir)?;
    let template_names: Vec<String> = read_template_entries(&project)
        .into_iter()
        .map(|t| t.name)
        .collect();
    let files = virtual_fs::list_virtual_files(&work_dir, "assets")?;
    let ctx = Context {
        canvas_width: project.canvas.width,
        canvas_height: project.canvas.height,
        outline: outline.as_ref(),
        spec: spec.as_ref(),
        template_names: &template_names,
        files: &files,
    };
    let facts = read_slide_facts(svg)?;
    let mut errors = Vec::new();
    check_slide(&ctx, index, slide_path, &facts, &mut errors);
    errors.retain(|error| WRITE_GATE_RULES.contains(&error.rule));
    Ok(errors)
}

pub fn validate_presentation(id: &str, slide_path: Option<&str>) -> SlidraResult<ValidationReport> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let project = read_project_json(&work_dir)?;
    let outline = plan::read_outline(&work_dir)?;
    let spec = plan::read_design_spec(&work_dir)?;
    let template_names: Vec<String> = read_template_entries(&project)
        .into_iter()
        .map(|t| t.name)
        .collect();
    let files = virtual_fs::list_virtual_files(&work_dir, "assets")?;
    let ctx = Context {
        canvas_width: project.canvas.width,
        canvas_height: project.canvas.height,
        outline: outline.as_ref(),
        spec: spec.as_ref(),
        template_names: &template_names,
        files: &files,
    };

    let mut slides: Vec<(String, SlideFacts)> = Vec::new();
    for path in &project.slides {
        let svg = virtual_fs::read_virtual_file(&work_dir, path)?;
        slides.push((path.clone(), read_slide_facts(&svg)?));
    }

    let mut errors = Vec::new();
    let checked = match slide_path {
        Some(target) => {
            let Some(index) = project.slides.iter().position(|p| p == target) else {
                return Err(SlidraError::not_found(format!("not a slide: {target}")));
            };
            check_slide(&ctx, index, target, &slides[index].1, &mut errors);
            1
        }
        None => {
            for (index, (path, facts)) in slides.iter().enumerate() {
                check_slide(&ctx, index, path, facts, &mut errors);
            }
            check_deck(&ctx, &slides, &mut errors);
            slides.len()
        }
    };
    Ok(ValidationReport {
        checked,
        errors,
        without_plan: outline.is_none() && spec.is_none(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> DesignSpec {
        plan::parse_design_spec(
            "```json\n{ \"density\": \"presentation\", \"palette\": { \"background\": \"#101418\", \"secondary_bg\": \"#1B2129\", \"primary\": \"#4F8DFF\", \"accent\": \"#F5B942\", \"secondary_accent\": \"#6DD3A5\", \"text\": \"#F4F6F8\", \"muted\": \"#9AA7B4\" }, \"type_scale\": { \"cover\": 64, \"section\": 56, \"number\": 140, \"claim\": 48, \"title\": 40, \"subtitle\": 28, \"body\": 24, \"column\": 22, \"caption\": 18 } }\n```\n",
        )
        .unwrap()
    }

    fn outline(pages: &str) -> OutlinePlan {
        plan::parse_outline(&format!(
            // `background` defaults to "on"; the fixtures below carry no
            // background image because they are testing other rules, so
            // they opt out explicitly. The rule itself has its own test.
            // `draft` + `none` keeps these fixtures minimal: they are about
            // other rules, so they opt out of the two that demand a
            // blueprint and node roles (each has its own test).
            "```json\n{{ \"status\": \"draft\", \"mode\": \"pyramid\", \"background\": \"off\", \"pages\": [ {pages} ] }}\n```\n"
        ))
        .unwrap()
    }

    fn textbox(
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        size: f64,
        fill: &str,
        lines: &[(&str, bool)],
    ) -> String {
        let spans: String = lines
            .iter()
            .map(|(text, brk)| {
                let attr = if *brk { " data-slidra-break=\"1\"" } else { "" };
                format!("<tspan x=\"0\" y=\"0\"{attr}>{text}</tspan>")
            })
            .collect();
        format!(
            "<g id=\"{id}\" transform=\"translate({x} {y})\" data-slidra-text-width=\"{width}\"><text font-family=\"Noto Sans TC\" font-size=\"{size}\" fill=\"{fill}\">{spans}</text></g>"
        )
    }

    fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, fill: &str, stroke: Option<&str>) -> String {
        let stroke = stroke
            .map(|s| format!(" stroke=\"{s}\""))
            .unwrap_or_default();
        format!(
            "<g id=\"{id}\" transform=\"translate({x} {y})\"><rect x=\"0\" y=\"0\" width=\"{w}\" height=\"{h}\" fill=\"{fill}\"{stroke}/></g>"
        )
    }

    /// A page with notes, a transition and one enter effect — the shape
    /// `slidra-build` leaves behind, so the motion rules stay quiet.
    fn slide(background: Option<&str>, notes: &str, body: &str) -> String {
        slide_with_motion(background, notes, body, true)
    }

    fn slide_with_motion(
        background: Option<&str>,
        notes: &str,
        body: &str,
        motion: bool,
    ) -> String {
        let style = background
            .map(|b| format!(" style=\"background-color:{b}\""))
            .unwrap_or_default();
        let motion_markup = if motion {
            "<slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"fade\" enter-duration=\"0.3\"/><slidra:effects xmlns:slidra=\"https://slidra.app/ns/2026\"><slidra:effect target=\"el-title\" family=\"enter\" effect=\"fade\" start=\"on-click\" duration=\"0.4\" delay=\"0\"/></slidra:effects>"
        } else {
            ""
        };
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"{style}><metadata><slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\">{notes}</slidra:notes>{motion_markup}</metadata>{body}</svg>"
        )
    }

    fn good_bullets_page() -> String {
        slide(
            Some("#101418"),
            "speaker notes.",
            &format!(
                "{}{}{}",
                textbox(
                    "el-title",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[("why a new tool is needed", false)]
                ),
                rect("el-rule", 80.0, 136.0, 56.0, 4.0, "#F5B942", None),
                textbox(
                    "el-body",
                    80.0,
                    176.0,
                    1120.0,
                    24.0,
                    "#F4F6F8",
                    &[
                        ("first bullet point", true),
                        ("second bullet point", true),
                        ("third bullet point", false)
                    ]
                ),
            ),
        )
    }

    fn rules(errors: &[ValidationError]) -> Vec<&'static str> {
        errors.iter().map(|e| e.rule).collect()
    }

    fn run_one(svg: &str, page_type: &str, rhythm: &str) -> Vec<ValidationError> {
        let spec = spec();
        let outline = outline(&format!(
            "{{ \"n\": 1, \"relationship\": \"none\", \"type\": \"{page_type}\", \"rhythm\": \"{rhythm}\", \"title\": \"t\" }}"
        ));
        let names = vec![template_name_for(page_type).to_string()];
        let ctx = Context {
            canvas_width: 1280.0,
            canvas_height: 720.0,
            outline: Some(&outline),
            spec: Some(&spec),
            template_names: &names,
            files: &[],
        };
        let facts = read_slide_facts(svg).unwrap();
        let mut errors = Vec::new();
        check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
        errors
    }

    #[test]
    fn reads_text_boxes_paragraphs_and_shapes() {
        let facts = read_slide_facts(&good_bullets_page()).unwrap();
        assert_eq!(facts.background.as_deref(), Some("#101418"));
        assert_eq!(facts.notes, "speaker notes.");
        assert_eq!(facts.text_boxes.len(), 2);
        let body = &facts.text_boxes[1];
        assert_eq!(body.paragraphs.len(), 3);
        assert_eq!(body.paragraphs[0].lines, 1);
        assert_eq!(body.chars(), 49);
        assert_eq!(facts.shapes.len(), 1);
        assert_eq!((facts.shapes[0].width, facts.shapes[0].height), (56.0, 4.0));
    }

    #[test]
    fn a_well_formed_bullets_page_passes_every_rule() {
        let errors = run_one(&good_bullets_page(), "bullets", "dense");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn wrapped_and_long_bullets_are_reported() {
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}",
                textbox(
                    "el-title",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[("title", false)]
                ),
                textbox(
                    "el-body",
                    80.0,
                    176.0,
                    1120.0,
                    24.0,
                    "#F4F6F8",
                    &[
                        (
                            "this bullet point is written way too long, exceeding the 32-character limit, essentially pasting the speaker script onto the page",
                            false
                        ),
                        ("wrap first paragraph", true),
                        ("second", true),
                        ("third", false),
                        ("fourth", false),
                        ("fifth", false)
                    ]
                ),
            ),
        );
        let errors = run_one(&svg, "bullets", "dense");
        let r = rules(&errors);
        assert!(r.contains(&"text.bullet-length"), "{r:?}");
        assert!(r.contains(&"text.bullet-lines"), "{r:?}");
        assert_eq!(
            errors
                .iter()
                .find(|e| e.rule == "text.bullet-length")
                .unwrap()
                .limit,
            "≤ 32 characters"
        );
    }

    #[test]
    fn title_length_bullet_count_and_page_total_are_reported() {
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}",
                textbox(
                    "el-title",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[(
                        "this title is really too long, exceeding the 24-character limit, it is basically a whole sentence",
                        false
                    )]
                ),
                textbox(
                    "el-body",
                    80.0,
                    176.0,
                    1120.0,
                    24.0,
                    "#F4F6F8",
                    &[
                        ("abcdefghijklmnopq", true),
                        ("abcdefghijklmnopq", true),
                        ("abcdefghijklmnopq", true),
                        ("abcdefghijklmnopq", true),
                        ("abcdefghijklmnopq", true),
                        ("abcdefghijklmnopq", true),
                        ("abcdefghijklmnopq", true),
                        ("eighth", false)
                    ]
                ),
            ),
        );
        let r = rules(&run_one(&svg, "bullets", "dense"));
        assert!(r.contains(&"text.title-length"), "{r:?}");
        assert!(r.contains(&"text.bullet-count"), "{r:?}");
        // 17 × 7 + 3 + 28 = 150 visible characters: well under the 1000 budget.
        assert!(!r.contains(&"text.page-total"), "{r:?}");

        let wall = "chars".repeat(1020);
        let svg = slide(
            Some("#101418"),
            "n",
            &textbox(
                "el-body",
                80.0,
                176.0,
                1120.0,
                24.0,
                "#F4F6F8",
                &[(&wall, false)],
            ),
        );
        let r = rules(&run_one(&svg, "bullets", "dense"));
        assert!(r.contains(&"text.page-total"), "{r:?}");
    }

    #[test]
    fn a_deck_may_not_be_mostly_one_relationship() {
        // #303: observed for real — a four-page deck with three `membership`
        // pages came out as three versions of the same page. Layout variety
        // cannot rescue an information shape that never changes.
        let page = |n: usize, rel: &str| {
            format!(
                "{{ \"n\": {n}, \"relationship\": \"{rel}\", \"rhythm\": \"dense\", \"title\": \"t\" }}"
            )
        };
        let run = |rels: [&str; 4]| {
            let pages: Vec<String> = rels
                .iter()
                .enumerate()
                .map(|(i, rel)| page(i + 1, rel))
                .collect();
            let outline = plan::parse_outline(&format!(
                "```json\n{{ \"status\": \"draft\", \"mode\": \"pyramid\", \"pages\": [ {} ] }}\n```\n",
                pages.join(", ")
            ))
            .unwrap();
            let ctx = Context {
                canvas_width: 1280.0,
                canvas_height: 720.0,
                outline: Some(&outline),
                spec: None,
                template_names: &[],
                files: &[],
            };
            let body = textbox("el-t", 80.0, 72.0, 600.0, 40.0, "#F4F6F8", &[("t", false)]);
            let slides: Vec<(String, SlideFacts)> = (1..=4)
                .map(|i| {
                    (
                        format!("slides/00{i}.svg"),
                        read_slide_facts(&slide(Some("#101418"), "n", &body)).unwrap(),
                    )
                })
                .collect();
            let mut errors = Vec::new();
            check_deck(&ctx, &slides, &mut errors);
            rules(&errors)
        };

        // Three of four the same — the deck we actually produced.
        assert!(
            run(["none", "membership", "membership", "membership"])
                .contains(&"roster.relationship-variety")
        );
        // Exactly half is fine.
        assert!(
            !run(["none", "none", "membership", "membership"])
                .contains(&"roster.relationship-variety")
        );
        assert!(
            !run(["none", "order", "contrast", "membership"])
                .contains(&"roster.relationship-variety")
        );
    }

    #[test]
    fn a_confirmed_page_must_write_down_its_blueprint_and_mark_its_nodes() {
        // #303: both were opt-in first, and the first real run showed what
        // opt-in means — the build wrote neither, so every rule that reads
        // them sat silent.
        let spec = spec();
        let body = textbox("el-t", 80.0, 72.0, 600.0, 40.0, "#F4F6F8", &[("t", false)]);
        let run = |status: &str, rel: &str, blueprint: &str| {
            let outline = plan::parse_outline(&format!(
                "```json\n{{ \"status\": \"{status}\", \"mode\": \"pyramid\", \"background\": \"off\", \"pages\": [ {{ \"n\": 1, \"relationship\": \"{rel}\", \"rhythm\": \"dense\", \"title\": \"t\"{blueprint} }} ] }}\n```\n"
            ))
            .unwrap();
            let ctx = Context {
                canvas_width: 1280.0,
                canvas_height: 720.0,
                outline: Some(&outline),
                spec: Some(&spec),
                template_names: &[],
                files: &[],
            };
            let facts = read_slide_facts(&slide(Some("#101418"), "n", &body)).unwrap();
            let mut errors = Vec::new();
            check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
            rules(&errors)
        };

        let missing = run("confirmed", "membership", "");
        assert!(missing.contains(&"blueprint.required"), "{missing:?}");
        assert!(missing.contains(&"role.required"), "{missing:?}");

        // A draft is still being planned; a `none` page has no units to mark.
        let draft = run("draft", "none", "");
        assert!(!draft.contains(&"blueprint.required"), "{draft:?}");
        assert!(!draft.contains(&"role.required"), "{draft:?}");
    }

    #[test]
    fn two_adjacent_pages_may_not_solve_the_same_relationship_the_same_way() {
        // #303 §A': the anti-pattern ppt-master names outright — reusing one
        // carrier for a second page with no page job. Same relationship,
        // same composition, same unit count is the same page twice.
        let outline_json = |second_shape: &str, second_nodes: usize| {
            format!(
                "```json\n{{ \"status\": \"confirmed\", \"mode\": \"pyramid\", \"pages\": [                  {{ \"n\": 1, \"relationship\": \"membership\", \"rhythm\": \"dense\", \"title\": \"a\", \"blueprint\": {{ \"shape\": \"card-wall\", \"nodes\": 3, \"steps\": 4 }} }},                  {{ \"n\": 2, \"relationship\": \"membership\", \"rhythm\": \"dense\", \"title\": \"b\", \"blueprint\": {{ \"shape\": \"{second_shape}\", \"nodes\": {second_nodes}, \"steps\": 4 }} }} ] }}\n```\n"
            )
        };
        let run = |second_shape: &str, second_nodes: usize| {
            let outline = plan::parse_outline(&outline_json(second_shape, second_nodes)).unwrap();
            let ctx = Context {
                canvas_width: 1280.0,
                canvas_height: 720.0,
                outline: Some(&outline),
                spec: None,
                template_names: &[],
                files: &[],
            };
            let body = textbox("el-t", 80.0, 72.0, 600.0, 40.0, "#F4F6F8", &[("t", false)]);
            let slides: Vec<(String, SlideFacts)> = (1..=2)
                .map(|i| {
                    (
                        format!("slides/00{i}.svg"),
                        read_slide_facts(&slide(Some("#101418"), "n", &body)).unwrap(),
                    )
                })
                .collect();
            let mut errors = Vec::new();
            check_deck(&ctx, &slides, &mut errors);
            rules(&errors)
        };

        assert!(run("card-wall", 3).contains(&"rhythm.repeated-shape"));
        // A different composition for the same relationship is fine…
        assert!(!run("shared-field", 3).contains(&"rhythm.repeated-shape"));
        // …and so is the same composition carrying a different unit count.
        assert!(!run("card-wall", 5).contains(&"rhythm.repeated-shape"));
    }

    #[test]
    fn a_blueprint_is_reconciled_against_the_page_that_was_drawn() {
        // #303 §D: the composition-reasoning step writes down node count and click steps; the page
        // has to match what was decided, or one of the two is wrong.
        let spec = spec();
        let names = vec![template_name_for("bullets").to_string()];
        let node = |id: &str| {
            format!(
                "<g id=\"{id}\" data-slidra-role=\"node\"><rect x=\"80\" y=\"200\" width=\"200\" height=\"80\" fill=\"#1B2129\"/></g>"
            )
        };
        let label = textbox(
            "el-l1",
            100.0,
            240.0,
            160.0,
            24.0,
            "#F4F6F8",
            &[("chars", false)],
        );
        let body = format!("{}{}{label}", node("el-n1"), node("el-n2"));

        // `slide()` writes exactly one on-click enter effect.
        let run = |blueprint: &str| {
            let outline = plan::parse_outline(&format!(
                "```json\n{{ \"status\": \"confirmed\", \"mode\": \"pyramid\", \"background\": \"off\", \"pages\": [ {{ \"n\": 1, \"relationship\": \"membership\", \"type\": \"bullets\", \"rhythm\": \"dense\", \"title\": \"t\"{blueprint} }} ] }}\n```\n"
            ))
            .unwrap();
            let ctx = Context {
                canvas_width: 1280.0,
                canvas_height: 720.0,
                outline: Some(&outline),
                spec: Some(&spec),
                template_names: &names,
                files: &[],
            };
            let facts = read_slide_facts(&slide(Some("#101418"), "n", &body)).unwrap();
            let mut errors = Vec::new();
            check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
            rules(&errors)
        };

        // No blueprint on a confirmed page is itself the error now: the
        // build has to write down what it decided (#303).
        assert!(run("").contains(&"blueprint.required"));

        // Matching blueprint passes.
        let matching = ", \"blueprint\": { \"shape\": \"card-wall\", \"nodes\": 2, \"steps\": 1 }";
        assert!(!run(matching).iter().any(|r| r.starts_with("blueprint.")));

        // Drew three nodes but planned two; told in two steps but drew one.
        let mismatched =
            ", \"blueprint\": { \"shape\": \"card-wall\", \"nodes\": 3, \"steps\": 2 }";
        let r = run(mismatched);
        assert!(r.contains(&"blueprint.nodes"), "{r:?}");
        assert!(r.contains(&"blueprint.steps"), "{r:?}");
    }

    #[test]
    fn composition_roles_are_optional_but_must_be_coherent() {
        // #303 §B: a page that declares no role is checked exactly as
        // before; one that declares them must hold together.
        let plain = textbox(
            "el-title",
            80.0,
            72.0,
            1120.0,
            40.0,
            "#F4F6F8",
            &[("title", false)],
        );
        let none = rules(&run_one(
            &slide(Some("#101418"), "n", &plain),
            "bullets",
            "dense",
        ));
        assert!(!none.iter().any(|r| r.starts_with("role.")), "{none:?}");

        // Decoration cannot carry copy.
        let garnish = plain.replace(
            "id=\"el-title\"",
            "id=\"el-title\" data-slidra-role=\"garnish\"",
        );
        let r = rules(&run_one(
            &slide(Some("#101418"), "n", &garnish),
            "bullets",
            "dense",
        ));
        assert!(r.contains(&"role.garnish-meaning"), "{r:?}");

        // One reading spine per page.
        let spine = |id: &str| {
            format!(
                "<g id=\"{id}\" data-slidra-role=\"spine\"><rect x=\"80\" y=\"200\" width=\"8\" height=\"300\" fill=\"#4F8DFF\"/></g>"
            )
        };
        let two = format!("{plain}{}{}", spine("el-s1"), spine("el-s2"));
        let r = rules(&run_one(
            &slide(Some("#101418"), "n", &two),
            "bullets",
            "dense",
        ));
        assert!(r.contains(&"role.spine-count"), "{r:?}");

        // An edge needs two ends, and a node carrier needs a label.
        let node = "<g id=\"el-n1\" data-slidra-role=\"node\"><rect x=\"80\" y=\"200\" width=\"200\" height=\"80\" fill=\"#1B2129\"/></g>";
        let edge = "<g id=\"el-e1\" data-slidra-role=\"edge\"><rect x=\"300\" y=\"236\" width=\"120\" height=\"2\" fill=\"#9AA7B4\"/></g>";
        let r = rules(&run_one(
            &slide(Some("#101418"), "n", &format!("{plain}{node}{edge}")),
            "bullets",
            "dense",
        ));
        assert!(r.contains(&"role.edge-endpoints"), "{r:?}");
        assert!(r.contains(&"role.node-label"), "{r:?}");

        // Decoration has no step of its own to be told in: an effect aimed
        // at a `garnish` is the role not being believed.
        let garnish_shape = "<g id=\"el-rule\" data-slidra-role=\"garnish\"><rect x=\"80\" y=\"136\" width=\"56\" height=\"4\" fill=\"#F5B942\"/></g>";
        let animated = slide_with_motion_targets(&format!("{plain}{garnish_shape}"), &["el-rule"]);
        let facts = read_slide_facts(&animated).unwrap();
        let spec = spec();
        let names = vec![template_name_for("bullets").to_string()];
        let outline = outline(
            "{ \"n\": 1, \"relationship\": \"none\", \"type\": \"bullets\", \"rhythm\": \"dense\", \"title\": \"t\" }",
        );
        let ctx = Context {
            canvas_width: 1280.0,
            canvas_height: 720.0,
            outline: Some(&outline),
            spec: Some(&spec),
            template_names: &names,
            files: &[],
        };
        let mut errors = Vec::new();
        check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
        assert!(
            rules(&errors).contains(&"role.garnish-animated"),
            "{:?}",
            rules(&errors)
        );
    }

    /// A slide whose effect list targets exactly `targets`.
    fn slide_with_motion_targets(body: &str, targets: &[&str]) -> String {
        let effects: String = targets
            .iter()
            .map(|t| format!("<slidra:effect target=\"{t}\" family=\"enter\" effect=\"fade\" start=\"on-click\" duration=\"0.4\" delay=\"0\"/>"))
            .collect();
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\" style=\"background-color:#101418\"><metadata><slidra:notes xmlns:slidra=\"https://slidra.app/ns/2026\">n</slidra:notes><slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"fade\" enter-duration=\"0.3\"/><slidra:effects xmlns:slidra=\"https://slidra.app/ns/2026\">{effects}</slidra:effects></metadata>{body}</svg>"
        )
    }

    #[test]
    fn grouped_elements_are_still_seen_by_every_rule() {
        // Grouping a card with its copy (the build's own flow: composition → background →
        // foreground → group → animation) used to hide the members from `validate`
        // entirely — an overflowing bullet stopped being reported the moment
        // it was grouped. The group's transform composes onto its members'.
        let body = textbox(
            "el-wide",
            600.0,
            240.0,
            1400.0,
            24.0,
            "#F4F6F8",
            &[("too wide", false)],
        );
        let loose = rules(&run_one(
            &slide(Some("#101418"), "n", &body),
            "bullets",
            "dense",
        ));
        assert!(loose.contains(&"geometry.right-overflow"), "{loose:?}");

        let grouped = rules(&run_one(
            &slide(
                Some("#101418"),
                "n",
                &format!("<g id=\"el-group\" data-slidra-name=\"card deck\">{body}</g>"),
            ),
            "bullets",
            "dense",
        ));
        assert!(grouped.contains(&"geometry.right-overflow"), "{grouped:?}");
    }

    #[test]
    fn a_group_transform_composes_onto_its_members() {
        // A group moved in the editor carries a transform; its members'
        // canvas coordinates are the composition, not their local ones.
        let body = textbox(
            "el-body",
            80.0,
            200.0,
            600.0,
            24.0,
            "#F4F6F8",
            &[("bullet point", false)],
        );
        let svg = slide(
            Some("#101418"),
            "n",
            &format!("<g id=\"el-group\" transform=\"translate(600 0)\">{body}</g>"),
        );
        let facts = read_slide_facts(&svg).unwrap();
        let tb = facts.text_boxes.iter().find(|t| t.id == "el-body").unwrap();
        assert_eq!(tb.x, 680.0);
        assert_eq!(tb.y, 200.0);
    }

    #[test]
    fn a_plan_with_background_on_requires_every_page_to_carry_one() {
        // `slide background set` is the one build step nothing else
        // notices when it is skipped — the page still renders, just not as
        // planned. Without this rule the build reports 0 errors.
        let bg = "<g id=\"el-background\" data-slidra-role=\"background\" data-slidra-lock=\"true\"><image x=\"0\" y=\"0\" width=\"1280\" height=\"720\" href=\"assets/bg.svg\"/></g>";
        let claim = textbox(
            "el-claim",
            80.0,
            248.0,
            1000.0,
            48.0,
            "#F4F6F8",
            &[("claim", false)],
        );
        let spec = spec();
        let names = vec![template_name_for("number").to_string()];
        let run = |svg: &str, background: &str| {
            let outline = plan::parse_outline(&format!(
                "```json\n{{ \"status\": \"confirmed\", \"mode\": \"pyramid\", \"background\": \"{background}\", \"pages\": [ {{ \"n\": 1, \"relationship\": \"membership\", \"type\": \"number\", \"rhythm\": \"breathing\", \"title\": \"t\" }} ] }}\n```\n"
            ))
            .unwrap();
            let ctx = Context {
                canvas_width: 1280.0,
                canvas_height: 720.0,
                outline: Some(&outline),
                spec: Some(&spec),
                template_names: &names,
                files: &[],
            };
            let facts = read_slide_facts(&slide(Some("#0B1220"), "n", svg)).unwrap();
            let mut errors = Vec::new();
            check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
            errors
        };

        let missing = run(&claim, "on");
        assert!(
            rules(&missing).contains(&"structure.background-image"),
            "{missing:?}"
        );
        assert!(
            !rules(&run(&format!("{bg}{claim}"), "on")).contains(&"structure.background-image")
        );
        // `background: off` means the page is meant to have none.
        assert!(!rules(&run(&claim, "off")).contains(&"structure.background-image"));
    }

    #[test]
    fn a_page_with_a_background_image_but_no_background_color_does_not_trip_structure_background() {
        // A page that only uses an image as its background has no
        // `background-color` to check, and that's fine — `structure.background`
        // exists to catch pages with neither, not to force a color on top of
        // an image.
        let bg = "<g id=\"el-background\" data-slidra-role=\"background\" data-slidra-lock=\"true\"><image x=\"0\" y=\"0\" width=\"1280\" height=\"720\" href=\"assets/bg.svg\"/></g>";
        let claim = textbox(
            "el-claim",
            80.0,
            248.0,
            1000.0,
            48.0,
            "#F4F6F8",
            &[("claim", false)],
        );
        let svg = slide(None, "n", &format!("{bg}{claim}"));
        let facts = read_slide_facts(&svg).unwrap();
        assert!(facts.has_background);
        assert!(facts.background.is_none());
        let r = rules(&run_one(&svg, "section", "anchor"));
        assert!(!r.contains(&"structure.background"), "{r:?}");
    }

    #[test]
    fn scrim_is_required_under_body_copy_only_when_the_page_has_a_background_image() {
        let bg = "<g id=\"el-background\" data-slidra-name=\"background image\" data-slidra-role=\"background\" data-slidra-lock=\"true\"><image x=\"0\" y=\"0\" width=\"1280\" height=\"720\" href=\"assets/bg.svg\"/></g>";
        let title = textbox(
            "el-title",
            80.0,
            72.0,
            1120.0,
            40.0,
            "#F4F6F8",
            &[("title", false)],
        );
        let body = textbox(
            "el-body",
            200.0,
            200.0,
            800.0,
            24.0,
            "#F4F6F8",
            &[("bullet point", false)],
        );
        let footer = textbox(
            "el-footer",
            80.0,
            668.0,
            600.0,
            18.0,
            "#9AA7B4",
            &[("footer", false)],
        );
        let claim = textbox(
            "el-claim",
            80.0,
            300.0,
            1000.0,
            48.0,
            "#F4F6F8",
            &[("large text", false)],
        );
        let panel = "<g id=\"el-panel\" transform=\"translate(80 176)\"><rect x=\"0\" y=\"0\" width=\"1120\" height=\"72\" fill=\"#1B2129\"/></g>";
        let faint = "<g id=\"el-faint\" transform=\"translate(80 176)\"><rect x=\"0\" y=\"0\" width=\"1120\" height=\"72\" fill=\"#1B2129\" opacity=\"0.3\"/></g>";

        // No background image: nothing to scrim.
        let plain = slide(Some("#101418"), "n", &format!("{title}{body}"));
        assert!(!rules(&run_one(&plain, "bullets", "dense")).contains(&"structure.scrim"));

        // Background + unscrimmed body: title and body both flagged; footer
        // and claim-sized text are exempt.
        let bare = slide(
            Some("#101418"),
            "n",
            &format!("{bg}{title}{body}{footer}{claim}"),
        );
        let errors = run_one(&bare, "bullets", "dense");
        let flagged: Vec<&str> = errors
            .iter()
            .filter(|e| e.rule == "structure.scrim")
            .filter_map(|e| e.element.as_deref())
            .collect();
        assert_eq!(flagged, vec!["el-title", "el-body"], "{errors:?}");

        // A covering panel before the body clears it; a faint one does not.
        let covered = slide(Some("#101418"), "n", &format!("{bg}{panel}{body}"));
        let errors = run_one(&covered, "bullets", "dense");
        assert!(
            !errors
                .iter()
                .any(|e| e.rule == "structure.scrim" && e.element.as_deref() == Some("el-body")),
            "{errors:?}"
        );
        let faint_page = slide(Some("#101418"), "n", &format!("{bg}{faint}{body}"));
        let errors = run_one(&faint_page, "bullets", "dense");
        assert!(
            errors
                .iter()
                .any(|e| e.rule == "structure.scrim" && e.element.as_deref() == Some("el-body")),
            "{errors:?}"
        );

        // The background element itself is furniture: no geometry/style/taboo finding names it.
        let facts = read_slide_facts(&bare).unwrap();
        assert!(facts.has_background);
        assert!(facts.shapes.iter().all(|s| s.id != "el-background"));
    }

    #[test]
    fn dynamic_text_placeholders_count_as_zero_characters() {
        assert_eq!(count_chars("{{ slide_number }} / {{ slide_total }}"), 1);
        assert_eq!(count_chars("a {{ slide_number }} b"), 2);
        assert_eq!(count_chars("left {{ over"), 10);
        assert_eq!(strip_placeholders("a{{x}}b{{y}}c"), "abc");
    }

    #[test]
    fn caption_sized_footer_may_sit_in_the_bottom_margin_but_body_text_may_not() {
        // Footer at y=668, 18px: bottom 694 ≤ 704 (720 − 16) — allowed.
        let footer = textbox(
            "el-footer",
            80.0,
            668.0,
            600.0,
            18.0,
            "#9AA7B4",
            &[("{{ presentation_name }}", false)],
        );
        // Body-sized box at the same y: bottom 703 > 648 — flagged.
        let body = textbox(
            "el-late",
            80.0,
            668.0,
            600.0,
            24.0,
            "#F4F6F8",
            &[("too low", false)],
        );
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}{}",
                textbox(
                    "el-title",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[("title", false)]
                ),
                footer,
                body
            ),
        );
        let errors = run_one(&svg, "bullets", "dense");
        let flagged: Vec<&str> = errors
            .iter()
            .filter(|e| e.rule == "geometry.bottom-overflow")
            .filter_map(|e| e.element.as_deref())
            .collect();
        assert_eq!(flagged, vec!["el-late"], "{errors:?}");
    }

    #[test]
    fn two_titles_off_scale_sizes_and_off_palette_colors_are_reported() {
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}{}{}",
                textbox(
                    "el-a",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[("Title 1", false)]
                ),
                textbox(
                    "el-b",
                    80.0,
                    300.0,
                    1120.0,
                    44.0,
                    "#FF0000",
                    &[("Title 2", false)]
                ),
                textbox(
                    "el-c",
                    80.0,
                    500.0,
                    1120.0,
                    24.0,
                    "#F4F6F8",
                    &[("one", true), ("two", true), ("three", false)]
                ),
                rect("el-r", 80.0, 136.0, 56.0, 4.0, "#123456", None),
            ),
        );
        let r = rules(&run_one(&svg, "bullets", "dense"));
        assert!(r.contains(&"focus.single-title"), "{r:?}");
        assert!(r.contains(&"style.font-size"), "{r:?}");
        assert!(r.contains(&"style.text-fill"), "{r:?}");
        assert!(r.contains(&"style.shape-fill"), "{r:?}");
    }

    #[test]
    fn overflow_overlap_stroke_background_and_notes_are_reported_without_a_plan() {
        let svg = slide(
            None,
            "",
            &format!(
                "{}{}{}",
                textbox(
                    "el-a",
                    80.0,
                    600.0,
                    1200.0,
                    40.0,
                    "#F4F6F8",
                    &[("exceeds", false)]
                ),
                textbox(
                    "el-b",
                    80.0,
                    620.0,
                    400.0,
                    24.0,
                    "#F4F6F8",
                    &[("overlaps", false)]
                ),
                rect("el-r", 1200.0, 0.0, 200.0, 4.0, "#F5B942", Some("#000000")),
            ),
        );
        let names: Vec<String> = Vec::new();
        let ctx = Context {
            canvas_width: 1280.0,
            canvas_height: 720.0,
            outline: None,
            spec: None,
            template_names: &names,
            files: &[],
        };
        let facts = read_slide_facts(&svg).unwrap();
        let mut errors = Vec::new();
        check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
        let r = rules(&errors);
        for rule in [
            "geometry.right-overflow",
            "geometry.bottom-overflow",
            "geometry.text-overlap",
            "taboo.stroke",
            "structure.background",
            "structure.notes",
        ] {
            assert!(r.contains(&rule), "missing {rule} in {r:?}");
        }
        assert!(
            !r.iter()
                .any(|rule| rule.starts_with("text.") || rule.starts_with("style.")),
            "{r:?}"
        );
    }

    #[test]
    fn asset_missing_reports_only_references_the_presentation_cannot_serve() {
        let svg = slide(
            Some("#101418"),
            "n",
            concat!(
                r#"<g id="el-ok"><image x="0" y="0" width="10" height="10" href="../assets/there.png"/></g>"#,
                r#"<g id="el-gone"><image x="0" y="0" width="10" height="10" href="../assets/gone.png"/></g>"#,
                r#"<g id="el-remote"><image x="0" y="0" width="10" height="10" href="https://example.com/x.png"/></g>"#,
            ),
        );
        let names: Vec<String> = Vec::new();
        let files = vec!["assets/there.png".to_string()];
        let ctx = Context {
            canvas_width: 1280.0,
            canvas_height: 720.0,
            outline: None,
            spec: None,
            template_names: &names,
            files: &files,
        };
        let facts = read_slide_facts(&svg).unwrap();
        let mut errors = Vec::new();
        check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
        let missing: Vec<&ValidationError> = errors
            .iter()
            .filter(|e| e.rule == "asset.missing")
            .collect();
        assert_eq!(missing.len(), 1, "{errors:?}");
        assert_eq!(missing[0].element.as_deref(), Some("el-gone"));
    }

    #[test]
    fn roster_type_breathing_cards_and_thresholds_scale_with_the_canvas() {
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}{}{}",
                textbox(
                    "el-t",
                    120.0,
                    108.0,
                    1680.0,
                    60.0,
                    "#F4F6F8",
                    &[("not a big-number page", false)]
                ),
                rect("el-1", 120.0, 300.0, 300.0, 120.0, "#1B2129", None),
                rect("el-2", 480.0, 300.0, 300.0, 120.0, "#1B2129", None),
                rect("el-3", 840.0, 300.0, 300.0, 120.0, "#1B2129", None),
            ),
        );
        let spec = spec();
        let outline = outline(
            "{ \"n\": 1, \"relationship\": \"membership\", \"type\": \"number\", \"rhythm\": \"breathing\", \"title\": \"t\" }",
        );
        let names = vec!["big-number page".to_string()];
        let ctx = Context {
            canvas_width: 1920.0,
            canvas_height: 1080.0,
            outline: Some(&outline),
            spec: Some(&spec),
            template_names: &names,
            files: &[],
        };
        let facts = read_slide_facts(&svg).unwrap();
        let mut errors = Vec::new();
        check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
        let r = rules(&errors);
        assert!(r.contains(&"roster.page-type"), "{r:?}");
        assert!(r.contains(&"rhythm.breathing-cards"), "{r:?}");
        assert!(
            !r.contains(&"style.font-size"),
            "60 = 40 × 1.5 is on the scaled type scale: {r:?}"
        );
        assert!(!r.contains(&"geometry.right-overflow"), "{r:?}");
    }

    #[test]
    fn deck_rules_catch_thank_you_pages_duplicate_covers_page_count_and_missing_templates() {
        let cover = slide(
            Some("#101418"),
            "n",
            &textbox(
                "el-c",
                80.0,
                240.0,
                1000.0,
                64.0,
                "#F4F6F8",
                &[("cover", false)],
            ),
        );
        let dup = slide(
            Some("#101418"),
            "n",
            &textbox(
                "el-d",
                80.0,
                240.0,
                1000.0,
                64.0,
                "#F4F6F8",
                &[("cover", false)],
            ),
        );
        let thanks = slide(
            Some("#1B2129"),
            "n",
            &textbox(
                "el-e",
                80.0,
                248.0,
                1000.0,
                48.0,
                "#F4F6F8",
                &[("thank you all", false)],
            ),
        );
        let spec = spec();
        let outline = outline(
            "{ \"n\": 1, \"relationship\": \"membership\", \"type\": \"cover\", \"rhythm\": \"anchor\", \"title\": \"t\" }, { \"n\": 2, \"relationship\": \"membership\", \"type\": \"closing\", \"rhythm\": \"anchor\", \"title\": \"t\" }",
        );
        let names = vec!["cover".to_string()];
        let ctx = Context {
            canvas_width: 1280.0,
            canvas_height: 720.0,
            outline: Some(&outline),
            spec: Some(&spec),
            template_names: &names,
            files: &[],
        };
        let slides: Vec<(String, SlideFacts)> = [cover, dup, thanks]
            .iter()
            .enumerate()
            .map(|(i, svg)| {
                (
                    format!("slides/00{}.svg", i + 1),
                    read_slide_facts(svg).unwrap(),
                )
            })
            .collect();
        let mut errors = Vec::new();
        check_deck(&ctx, &slides, &mut errors);
        let r = rules(&errors);
        for rule in [
            "taboo.thank-you",
            "taboo.duplicate-cover",
            "roster.page-count",
            "structure.template",
        ] {
            assert!(r.contains(&rule), "missing {rule} in {r:?}");
        }
        assert_eq!(
            errors
                .iter()
                .find(|e| e.rule == "structure.template")
                .unwrap()
                .limit,
            "has template \"closing page\""
        );
    }

    #[test]
    fn decorative_geometry_may_bleed_stroke_and_use_gradients_and_bars_are_not_panels() {
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}{}{}{}",
                textbox(
                    "el-title",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[("title", false)]
                ),
                textbox(
                    "el-body",
                    80.0,
                    176.0,
                    1120.0,
                    24.0,
                    "#F4F6F8",
                    &[("one", true), ("two", true), ("three", false)]
                ),
                "<g id=\"el-circle\" transform=\"translate(1180 60)\"><ellipse cx=\"0\" cy=\"0\" rx=\"420\" ry=\"420\" fill=\"url(#glow)\" opacity=\"0.12\"/></g>",
                "<g id=\"el-ring\" transform=\"translate(640 360)\"><ellipse cx=\"0\" cy=\"0\" rx=\"200\" ry=\"200\" fill=\"none\" stroke=\"#F5B942\" stroke-width=\"2\"/></g>",
                rect("el-bar", 0.0, 0.0, 16.0, 720.0, "#4F8DFF", None),
            ),
        );
        let errors = run_one(&svg, "bullets", "breathing");
        let r = rules(&errors);
        assert!(!r.contains(&"geometry.right-overflow"), "{r:?}");
        assert!(!r.contains(&"taboo.stroke"), "{r:?}");
        assert!(!r.contains(&"style.shape-fill"), "{r:?}");
        assert!(!r.contains(&"rhythm.breathing-cards"), "{r:?}");
    }

    #[test]
    fn a_stroked_rect_is_still_reported() {
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}",
                textbox(
                    "el-title",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[("title", false)]
                ),
                rect(
                    "el-card",
                    80.0,
                    176.0,
                    400.0,
                    200.0,
                    "#1B2129",
                    Some("#F5B942")
                ),
            ),
        );
        let r = rules(&run_one(&svg, "section", "anchor"));
        assert!(r.contains(&"taboo.stroke"), "{r:?}");
    }

    #[test]
    fn bare_text_is_decoration_and_subject_to_no_rule() {
        let svg = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}",
                textbox(
                    "el-title",
                    80.0,
                    288.0,
                    1000.0,
                    56.0,
                    "#F4F6F8",
                    &[("section name", false)]
                ),
                "<g id=\"el-watermark\" transform=\"translate(760 640)\"><text x=\"0\" y=\"0\" font-size=\"320\" font-weight=\"700\" fill=\"#9AA7B4\" opacity=\"0.18\">02</text></g>",
            ),
        );
        let facts = read_slide_facts(&svg).unwrap();
        assert_eq!(facts.text_boxes.len(), 1, "the watermark is not a text box");
        let errors = run_one(&svg, "section", "anchor");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn compare_pages_count_bullets_per_column_across_boxes_and_closing_may_sit_on_primary() {
        let compare = slide(
            Some("#101418"),
            "n",
            &format!(
                "{}{}{}{}",
                textbox(
                    "el-title",
                    80.0,
                    72.0,
                    1120.0,
                    40.0,
                    "#F4F6F8",
                    &[("comparison", false)]
                ),
                textbox(
                    "el-l1",
                    80.0,
                    252.0,
                    520.0,
                    22.0,
                    "#F4F6F8",
                    &[("left 1", false)]
                ),
                textbox(
                    "el-l2",
                    80.0,
                    300.0,
                    520.0,
                    22.0,
                    "#F4F6F8",
                    &[("left 2", false)]
                ),
                textbox(
                    "el-r1",
                    680.0,
                    252.0,
                    520.0,
                    22.0,
                    "#F4F6F8",
                    &[("right 1", false)]
                ),
            ),
        );
        let errors = run_one(&compare, "compare", "dense");
        let counts: Vec<&ValidationError> = errors
            .iter()
            .filter(|e| e.rule == "text.bullet-count")
            .collect();
        assert_eq!(counts.len(), 1, "{errors:?}");
        assert!(
            counts[0].message.contains("column right"),
            "{}",
            counts[0].message
        );

        let closing = slide(
            Some("#4F8DFF"),
            "n",
            &textbox(
                "el-claim",
                80.0,
                248.0,
                1000.0,
                48.0,
                "#101418",
                &[("conclusion", false)],
            ),
        );
        let r = rules(&run_one(&closing, "closing", "anchor"));
        assert!(!r.contains(&"structure.background"), "{r:?}");
        assert!(!r.contains(&"style.text-fill"), "{r:?}");
        let r = rules(&run_one(&closing, "section", "anchor"));
        assert!(r.contains(&"structure.background"), "{r:?}");
    }

    #[test]
    fn motion_rules_follow_the_outline_animation_setting() {
        let quiet = slide_with_motion(
            Some("#101418"),
            "n",
            &textbox(
                "el-title",
                80.0,
                240.0,
                1000.0,
                64.0,
                "#F4F6F8",
                &[("cover", false)],
            ),
            false,
        );
        let facts = read_slide_facts(&quiet).unwrap();
        assert!(!facts.has_transition);
        assert_eq!(facts.enter_effects, 0);
        let spec = spec();
        let names = vec!["cover".to_string()];
        for (animation, page_type, expect_transition, expect_enter) in [
            ("full", "cover", true, true),
            ("minimal", "cover", true, true),
            ("minimal", "section", true, false),
            ("none", "cover", false, false),
        ] {
            let outline = plan::parse_outline(&format!(
                "```json\n{{ \"status\": \"confirmed\", \"mode\": \"pyramid\", \"animation\": \"{animation}\", \"pages\": [ {{ \"n\": 1, \"relationship\": \"membership\", \"type\": \"{page_type}\", \"rhythm\": \"anchor\", \"title\": \"t\" }} ] }}\n```\n"
            ))
            .unwrap();
            let ctx = Context {
                canvas_width: 1280.0,
                canvas_height: 720.0,
                outline: Some(&outline),
                spec: Some(&spec),
                template_names: &names,
                files: &[],
            };
            let mut errors = Vec::new();
            check_slide(&ctx, 0, "slides/001.svg", &facts, &mut errors);
            let r = rules(&errors);
            assert_eq!(
                r.contains(&"motion.transition"),
                expect_transition,
                "{animation}/{page_type}: {r:?}"
            );
            assert_eq!(
                r.contains(&"motion.enter"),
                expect_enter,
                "{animation}/{page_type}: {r:?}"
            );
        }
    }
}
