// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The normal-form slide model.
//!
//! The single answer to "what is a compliant slide" (ADR-0008). The normal
//! form: every element is one `<g>` container wrapping one or more
//! primitives; a group is a container of containers; the identifier and the
//! display name live on the container, never on the primitive; position and
//! rotation live in the container's `transform`, while size stays on the
//! primitive's own native attributes.
//!
//! Compliance is about STRUCTURE only. It does not judge whether an element
//! draws anything, and it does not sanitise: `on*` event handler attributes
//! are not checked here (ADR-0007 puts that defence in the iframe
//! sandbox, not in a scrubber).
//!
//! ## Scope note: `element-text.ts` is NOT ported here
//!
//! This ticket ports exactly one small function out of that 1070-line file
//! — `readTextAlign` — because `SlideElement.text_align` needs it. Every
//! other export of `element-text.ts` (`resolveFont`, `LIST_MARKER_ATTRIBUTE`,
//! `applySplices`, list-marker synthesis, run-style rewrap helpers, ...) is
//! out of scope and does not exist anywhere in this crate yet. Where
//! `geometry/bbox.rs` needs one of those (`LIST_MARKER_ATTRIBUTE`, a
//! `resolveFont`-shaped lookup), it defines its own narrow, self-contained
//! stand-in rather than importing from a module that does not exist — see
//! that file's comments at each such point.
//!
//! ## Scope note: `table/model.ts` is NOT fully ported here
//!
//! `slide::table_grid` ports only `TableGrid` (declared column/row grid
//! lines) and `describeTableShapeProblem` (the structural half of table
//! validity this module's compliance check needs). The rich `TableModel`
//! (cells, header, theme, source, span coverage, `readTableModel`) is a
//! later ticket's responsibility — see `table_grid.rs`'s header comment.

use std::collections::{HashMap, HashSet};

use crate::errors::{SlidraError, SlidraResult};
pub use crate::geometry::bbox::MAX_CONTAINER_DEPTH;
use crate::geometry::transform::{Matrix, parse_transform};
use crate::slide::scan::{
    ScannedAttribute, ScannedNode, attribute_value, position_at, scan_document,
};
use crate::slide::style::{PageStyle, read_slide_page_style};
pub use crate::slide::table_grid::TABLE_CONTAINER_TYPE;
use crate::slide::table_grid::{TableGrid, describe_table_shape_problem, read_table_grid};
use crate::text::escape::unescape_xml_text;
use crate::text::runs::{TextRun, read_text_box_runs, utf16_slice};

/// Legal primitive tags (AC 4). `circle` is in because the demo deck uses it
/// and it is a degenerate `ellipse`.
pub const SLIDE_PRIMITIVE_TAGS: &[&str] =
    &["text", "rect", "ellipse", "circle", "line", "image", "path"];

/// Explicitly illegal, and `convert` will NOT remove them for you (spec #70,
/// ADR-0006).
pub const FORBIDDEN_TAGS: &[&str] = &["foreignObject", "script"];

/// Direct children of `<svg>` that are document furniture rather than
/// elements.
const DOCUMENT_FURNITURE_TAGS: &[&str] = &["defs", "style", "metadata", "title", "desc"];

/// Accessibility children that may appear inside a container or a primitive
/// and are ignored.
const IGNORED_CHILD_TAGS: &[&str] = &["title", "desc"];

/// The only markup allowed inside a primitive, beyond the ignored
/// accessibility children.
const PRIMITIVE_CHILD_TAGS: &[&str] = &["tspan"];

/// Attributes the normal form keeps on the container, never on the
/// primitive.
pub const CONTAINER_ATTRIBUTES: &[&str] = &[
    "id",
    "data-slidra-name",
    "data-slidra-media",
    "transform",
    "data-slidra-lock",
    "data-slidra-type",
];

/// The value `data-slidra-type` takes on a chart container (E2.T12).
pub const CHART_CONTAINER_TYPE: &str = "chart";

/// Appended to the issues `slidra convert` can actually repair — never to
/// the ones it refuses to touch.
const CONVERT_HINT: &str = "run slidra convert <presentation-id> to convert to a compliant format.";

/// `data-slidra-text-width`; see `SlideElement::text_width`'s doc comment.
pub const TEXT_WIDTH_ATTRIBUTE: &str = "data-slidra-text-width";
/// `data-slidra-text-height`; see `SlideElement::text_height`.
pub const TEXT_HEIGHT_ATTRIBUTE: &str = "data-slidra-text-height";
const TEXT_ALIGN_ATTRIBUTE: &str = "data-slidra-text-align";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlideElementKind {
    Group,
    Text,
    Rect,
    Ellipse,
    Circle,
    Line,
    Image,
    Path,
    /// One container holding several primitives (ADR-0008 allows "one or
    /// more primitives").
    Compound,
    /// A table container.
    Table,
    /// A chart container (E2.T12).
    Chart,
}

/// A primitive tag string is only ever produced by `to_primitive` for a tag
/// already validated (by `assert_slide_compliant`) to be one of
/// `SLIDE_PRIMITIVE_TAGS` — so this mapping is total in practice, matching
/// the TS source's own untyped `primitives[0].tag as SlideElementKind`
/// assertion (which trusts the same invariant without checking it at all;
/// this port at least asserts it rather than silently mis-mapping).
fn primitive_kind(tag: &str) -> SlideElementKind {
    match tag {
        "text" => SlideElementKind::Text,
        "rect" => SlideElementKind::Rect,
        "ellipse" => SlideElementKind::Ellipse,
        "circle" => SlideElementKind::Circle,
        "line" => SlideElementKind::Line,
        "image" => SlideElementKind::Image,
        "path" => SlideElementKind::Path,
        other => unreachable!(
            "primitive tag {other:?} is not one of SLIDE_PRIMITIVE_TAGS; assert_slide_compliant should have rejected it first"
        ),
    }
}

/// One primitive's own tag, attributes, and (for `<text>`) content. Ports
/// `SlidePrimitive`.
///
/// `attrs` mirrors `new Map(child.attributes.map((a) => [a.name, a.value]))`
/// EXACTLY, including that constructor's own quirk: when the scanned tag
/// carries the same attribute name twice, `new Map` keeps the key at its
/// FIRST position but overwrites its value with the LAST occurrence — the
/// opposite tie-break from `scan::attribute_of`'s documented first-wins rule.
/// This is a genuine (if obscure) divergence already present in the TS
/// source itself, not something this port introduces; `to_primitive_attrs`
/// below reproduces it precisely rather than "fixing" it.
#[derive(Debug, Clone, PartialEq)]
pub struct SlidePrimitive {
    pub tag: String,
    pub attrs: Vec<(String, String)>,
    /// For a `<text>` primitive: its rendered text, decoded. `""` for every
    /// other primitive.
    pub text: String,
    /// For a `<text>` primitive carrying `<tspan>` children: how many there
    /// are. 0 otherwise.
    pub tspan_count: usize,
    /// For a `<text>` primitive carrying nested run tspans: the runs read
    /// back from those tspans. `[]` otherwise.
    pub runs: Vec<TextRun>,
}

impl SlidePrimitive {
    /// Since `attrs` is already deduplicated to one entry per name (see this
    /// struct's doc comment), a linear scan finds the one and only match.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SlideElement {
    pub id: String,
    /// `data-slidra-name`; `None` when absent — conversion never invents a
    /// display name.
    pub name: Option<String>,
    /// `data-slidra-media`, verbatim (ADR-0006).
    pub media: Option<String>,
    pub kind: SlideElementKind,
    /// The container's `transform` attribute, verbatim; `None` when absent.
    pub transform: Option<String>,
    /// `parse_transform(transform)`.
    pub matrix: Matrix,
    /// Child containers when `kind == Group`, otherwise empty.
    pub children: Vec<SlideElement>,
    /// Primitives when `kind != Group`, otherwise empty.
    pub primitives: Vec<SlidePrimitive>,
    /// Parsed `data-slidra-text-width`; `None` when the element is not a text
    /// box.
    pub text_width: Option<f64>,
    /// Parsed `data-slidra-text-height`; `None` when absent.
    pub text_height: Option<f64>,
    /// `read_text_align`'s result (`Left` when the container has no
    /// `data-slidra-text-align`).
    pub text_align: TextAlign,
    /// `Some` only when `kind == Table`.
    pub table: Option<TableGrid>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SlideModel {
    pub view_box: ViewBox,
    pub elements: Vec<SlideElement>,
    /// The slide's Page style, read off the root `<svg>`'s own
    /// `style` attribute.
    pub page_style: PageStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComplianceCode {
    BarePrimitive,
    ForbiddenTag,
    UnknownTag,
    MissingId,
    DuplicateId,
    EmptyContainer,
    MixedChildren,
    PrimitiveTransform,
    BadTransform,
    MissingViewbox,
    TooDeep,
    MalformedMarkup,
    InvalidTableShape,
    InvalidChartShape,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComplianceIssue {
    pub code: ComplianceCode,
    /// 1-based, pointing at the offending tag's `<`.
    pub line: usize,
    pub column: usize,
    /// The offending tag name, or `None` when no tag corresponds.
    pub tag: Option<String>,
    /// The related element identifier, when one is available.
    pub element_id: Option<String>,
    /// Traditional Chinese, printable to a human as-is.
    pub message: String,
}

/// `Some(" el-a ")`-shaped padding for `container{} ...`-style messages, matching
/// the TS source's `${id ? \` ${id} \` : ""}` inline ternary exactly
/// (including the surrounding spaces when present).
fn id_suffix(id: Option<&str>) -> String {
    id.map(|value| format!(" {value} ")).unwrap_or_default()
}

/// Accumulates `ComplianceIssue`s while walking a scanned document. Ports
/// `checkSlideCompliance`'s local closures (`report`/`noteId`/`walkContainer`/
/// `walkPrimitive`/`reportUnknown`) as methods, since Rust closures capturing
/// `&mut self`-shaped state recursively are awkward next to free functions
/// that need the same mutable accumulator.
struct Checker<'a> {
    svg: &'a str,
    issues: Vec<ComplianceIssue>,
    seen_ids: HashSet<String>,
}

impl Checker<'_> {
    fn report(
        &mut self,
        element: &ScannedNode,
        code: ComplianceCode,
        message: String,
        element_id: Option<String>,
    ) {
        let (line, column) = position_at(self.svg, element.start);
        self.issues.push(ComplianceIssue {
            code,
            line,
            column,
            tag: Some(element.tag.clone()),
            element_id,
            message,
        });
    }

    fn note_id(&mut self, element: &ScannedNode, id: &str) {
        if self.seen_ids.contains(id) {
            self.report(
                element,
                ComplianceCode::DuplicateId,
                format!("id {id} appears more than once, every element must have a unique id."),
                Some(id.to_string()),
            );
            return;
        }
        self.seen_ids.insert(id.to_string());
    }

    fn report_unknown(&mut self, element: &ScannedNode) {
        self.report(
            element,
            ComplianceCode::UnknownTag,
            format!(
                "<{}> is not a valid slide element, valid primitives are {}; use <path> instead for polygons and polylines.",
                element.tag,
                SLIDE_PRIMITIVE_TAGS.join(", ")
            ),
            None,
        );
    }

    fn walk_primitive_children_only(&mut self, element: &ScannedNode) {
        for child in &element.children {
            if IGNORED_CHILD_TAGS.contains(&child.tag.as_str())
                || PRIMITIVE_CHILD_TAGS.contains(&child.tag.as_str())
            {
                continue;
            }
            if FORBIDDEN_TAGS.contains(&child.tag.as_str()) {
                continue;
            }
            self.report_unknown(child);
        }
    }

    fn walk_primitive(&mut self, element: &ScannedNode, container_id: Option<&str>) {
        if attribute_value(element, "transform").is_some() {
            self.report(
                element,
                ComplianceCode::PrimitiveTransform,
                format!("<{}>'s transform is written on the primitive; position and rotation must be written on the container's transform. {CONVERT_HINT}", element.tag),
                container_id.map(String::from),
            );
        }
        self.walk_primitive_children_only(element);
    }

    fn walk_container(&mut self, element: &ScannedNode, depth: usize) {
        if depth > MAX_CONTAINER_DEPTH {
            self.report(
                element,
                ComplianceCode::TooDeep,
                format!("container nesting exceeds {MAX_CONTAINER_DEPTH} levels."),
                None,
            );
            return;
        }

        let id = attribute_value(element, "id");
        match id.as_deref() {
            None => self.report(
                element,
                ComplianceCode::MissingId,
                format!("container <g> has no id, the identifier must be attached to the container. {CONVERT_HINT}"),
                None,
            ),
            Some(id_str) => self.note_id(element, id_str),
        }

        if let Some(transform) = attribute_value(element, "transform") {
            if let Err(err) = parse_transform(Some(transform.as_str())) {
                self.report(
                    element,
                    ComplianceCode::BadTransform,
                    format!(
                        "container {}'s transform cannot be parsed: {}",
                        id_suffix(id.as_deref()),
                        err.message()
                    ),
                    id.clone(),
                );
            }
        }

        let children: Vec<&ScannedNode> = element
            .children
            .iter()
            .filter(|child| !IGNORED_CHILD_TAGS.contains(&child.tag.as_str()))
            .collect();
        if children.is_empty() {
            self.report(
                element,
                ComplianceCode::EmptyContainer,
                format!(
                    "container {} has no primitives or child containers.",
                    id_suffix(id.as_deref())
                ),
                id.clone(),
            );
            return;
        }

        // A table container relaxes ADR-0008's normal partition.
        if attribute_value(element, "data-slidra-type").as_deref() == Some(TABLE_CONTAINER_TYPE) {
            if let Some(problem) = describe_table_shape_problem(element) {
                self.report(
                    element,
                    ComplianceCode::InvalidTableShape,
                    format!(
                        "table container {} format is incorrect: {}",
                        id_suffix(id.as_deref()),
                        problem
                    ),
                    id.clone(),
                );
            }
            return;
        }

        // A chart container relaxes ADR-0008's normal partition.
        if attribute_value(element, "data-slidra-type").as_deref() == Some(CHART_CONTAINER_TYPE) {
            let others: Vec<&ScannedNode> = children
                .iter()
                .filter(|child| child.tag != "slidra:chart" && child.tag != "svg")
                .copied()
                .collect();
            for other in others {
                if !FORBIDDEN_TAGS.contains(&other.tag.as_str()) {
                    self.report_unknown(other);
                }
            }
            let chart_count = children
                .iter()
                .filter(|child| child.tag == "slidra:chart")
                .count();
            let svg_count = children.iter().filter(|child| child.tag == "svg").count();
            if chart_count != 1 || svg_count != 1 {
                self.report(
                    element,
                    ComplianceCode::InvalidChartShape,
                    format!(
                        "chart container {} must contain exactly one <slidra:chart> and one embedded <svg>.",
                        id_suffix(id.as_deref())
                    ),
                    id.clone(),
                );
            }
            return;
        }

        let containers: Vec<&ScannedNode> = children
            .iter()
            .filter(|child| child.tag == "g")
            .copied()
            .collect();
        let primitives: Vec<&ScannedNode> = children
            .iter()
            .filter(|child| SLIDE_PRIMITIVE_TAGS.contains(&child.tag.as_str()))
            .copied()
            .collect();
        let others: Vec<&ScannedNode> = children
            .iter()
            .filter(|child| child.tag != "g" && !SLIDE_PRIMITIVE_TAGS.contains(&child.tag.as_str()))
            .copied()
            .collect();

        for other in others {
            if !FORBIDDEN_TAGS.contains(&other.tag.as_str()) {
                self.report_unknown(other);
            }
        }

        if !containers.is_empty() && !primitives.is_empty() {
            self.report(
                element,
                ComplianceCode::MixedChildren,
                format!(
                    "container {} has both primitives and child containers, a container can only be one or the other.",
                    id_suffix(id.as_deref())
                ),
                id.clone(),
            );
        }

        for primitive in primitives {
            self.walk_primitive(primitive, id.as_deref());
        }
        for container in containers {
            self.walk_container(container, depth + 1);
        }
    }
}

/// Iterative pre-order visit over `nodes` and every descendant — ports
/// `forEachNode`, used for the whole-document forbidden-tag sweep (`<script>`
/// and `<foreignObject>` are illegal ANYWHERE, including inside `<defs>`).
/// Already non-recursive in the TS source (an explicit `stack`), so this is
/// a direct port, not a stack-safety fix.
fn for_each_node<'a>(nodes: &'a [ScannedNode], mut visit: impl FnMut(&'a ScannedNode)) {
    let mut stack: Vec<&ScannedNode> = nodes.iter().collect();
    while let Some(element) = stack.pop() {
        visit(element);
        stack.extend(element.children.iter());
    }
}

/// Reports every compliance problem in the slide, ordered by position in the
/// document. Pure inspection: it never fails for a non-compliant slide —
/// `assert_slide_compliant` is the layer that turns issues into an error.
/// Markup `scan_document` cannot parse at all is reported as a single
/// `MalformedMarkup` issue.
pub fn check_slide_compliance(svg: &str) -> Vec<ComplianceIssue> {
    let roots = match scan_document(svg) {
        Ok(roots) => roots,
        Err(err) => {
            return vec![ComplianceIssue {
                code: ComplianceCode::MalformedMarkup,
                line: 1,
                column: 1,
                tag: None,
                element_id: None,
                message: err.message().to_string(),
            }];
        }
    };

    let svg_root = match roots.iter().find(|element| element.tag == "svg") {
        Some(root) => root,
        None => {
            return vec![ComplianceIssue {
                code: ComplianceCode::MalformedMarkup,
                line: 1,
                column: 1,
                tag: None,
                element_id: None,
                message: "root node of the slide is not <svg>".to_string(),
            }];
        }
    };

    let mut checker = Checker {
        svg,
        issues: Vec::new(),
        seen_ids: HashSet::new(),
    };

    if attribute_value(svg_root, "viewBox").is_none() {
        checker.report(
            svg_root,
            ComplianceCode::MissingViewbox,
            "root node <svg> has no viewBox, the slide has no coordinate system.".to_string(),
            None,
        );
    }

    for_each_node(&roots, |element| {
        if FORBIDDEN_TAGS.contains(&element.tag.as_str()) {
            checker.report(
                element,
                ComplianceCode::ForbiddenTag,
                format!(
                    "<{}> is not a valid element, the convert command will not remove it for you, please delete it yourself before converting.",
                    element.tag
                ),
                None,
            );
        }
    });

    for child in &svg_root.children {
        if DOCUMENT_FURNITURE_TAGS.contains(&child.tag.as_str()) {
            continue;
        }
        if FORBIDDEN_TAGS.contains(&child.tag.as_str()) {
            continue;
        }
        if child.tag == "g" {
            checker.walk_container(child, 1);
            continue;
        }
        if SLIDE_PRIMITIVE_TAGS.contains(&child.tag.as_str()) {
            checker.report(
                child,
                ComplianceCode::BarePrimitive,
                format!(
                    "<{}> is a bare primitive, must be wrapped in a <g> container. {CONVERT_HINT}",
                    child.tag
                ),
                None,
            );
            if let Some(bare_id) = attribute_value(child, "id") {
                checker.note_id(child, &bare_id);
            }
            checker.walk_primitive_children_only(child);
            continue;
        }
        checker.report_unknown(child);
    }

    let mut issues = checker.issues;
    issues.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then(left.column.cmp(&right.column))
    });
    issues
}

/// Fails unless the slide is compliant. This is the line every editing
/// command opens with — the whole point is that a command tells the author
/// exactly where the slide is wrong instead of quietly coping with it.
pub fn assert_slide_compliant(svg: &str, slide_path: &str) -> SlidraResult<()> {
    let issues = check_slide_compliance(svg);
    let Some(first) = issues.first() else {
        return Ok(());
    };
    let more = if issues.len() > 1 {
        format!("(and {} more issue(s))", issues.len() - 1)
    } else {
        String::new()
    };
    Err(SlidraError::invalid(format!(
        "slide {slide_path} non-compliant (line {}, column {}): {}{}",
        first.line, first.column, first.message, more
    )))
}

/// A text box's horizontal alignment. Ports the TS source's inline
/// `"left" | "center" | "right"` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

/// Reads a text box container's `data-slidra-text-align`, defaulting to
/// `Left` when absent — every rewrap path calls the TS equivalent to carry
/// the box's alignment forward unchanged. This is the one function ported
/// out of `element-text.ts` for this ticket (see module header comment).
pub fn read_text_align(container: &ScannedNode, element_id: &str) -> SlidraResult<TextAlign> {
    match attribute_value(container, TEXT_ALIGN_ATTRIBUTE).as_deref() {
        None => Ok(TextAlign::Left),
        Some("left") => Ok(TextAlign::Left),
        Some("center") => Ok(TextAlign::Center),
        Some("right") => Ok(TextAlign::Right),
        Some(other) => Err(SlidraError::invalid(format!(
            "element {element_id}\'s {TEXT_ALIGN_ATTRIBUTE} is not a valid value (left, center or right): {other}"
        ))),
    }
}

/// Builds `SlidePrimitive::attrs` with the exact dedup semantics of
/// `new Map(attributes.map((a) => [a.name, a.value]))` — see
/// `SlidePrimitive`'s doc comment for why this differs from
/// `scan::attribute_of`'s first-wins rule. Each key keeps the POSITION of
/// its first occurrence but the VALUE of its last.
fn to_primitive_attrs(attributes: &[ScannedAttribute]) -> Vec<(String, String)> {
    let mut order: Vec<String> = Vec::new();
    let mut values: HashMap<String, String> = HashMap::new();
    for attribute in attributes {
        if !values.contains_key(&attribute.name) {
            order.push(attribute.name.clone());
        }
        values.insert(attribute.name.clone(), attribute.value.clone());
    }
    order
        .into_iter()
        .map(|key| {
            let value = values.remove(&key).expect("key was just inserted above");
            (key, value)
        })
        .collect()
}

/// Builds one `SlidePrimitive` from a scanned child node. `svg` is the whole
/// document, needed to read a `<text>`'s content by its offsets.
fn to_primitive(child: &ScannedNode, svg: &str) -> SlidePrimitive {
    let tag = child.tag.to_lowercase();
    let attrs = to_primitive_attrs(&child.attributes);
    if tag != "text" {
        return SlidePrimitive {
            tag,
            attrs,
            text: String::new(),
            tspan_count: 0,
            runs: Vec::new(),
        };
    }
    let tspan_count = child
        .children
        .iter()
        .filter(|grandchild| grandchild.tag == "tspan")
        .count();
    if tspan_count > 0 {
        let (content, runs) = read_text_box_runs(child, svg);
        return SlidePrimitive {
            tag,
            attrs,
            text: content,
            tspan_count,
            runs,
        };
    }
    let text = unescape_xml_text(&utf16_slice(svg, child.content_start, child.content_end));
    SlidePrimitive {
        tag,
        attrs,
        text,
        tspan_count: 0,
        runs: Vec::new(),
    }
}

/// Mirrors `Number(text)` narrowly enough for `data-slidra-text-width`/
/// `-height` parsing: KNOWN GAP, JS's `Number()` string coercion additionally
/// accepts hexadecimal integer literals ("0x10" -> 16), which Rust's
/// `f64::parse` rejects; every real value this codebase ever writes here is
/// a plain decimal from `format_svg_number`, so this is believed unreachable
/// on real documents (same flagged-not-assumed stance as `svgnum.rs`'s own
/// KNOWN GAP, and `table_grid.rs`'s identical caveat for `data-slidra-cols`/
/// `-rows`).
fn js_parse_finite(text: &str) -> Option<f64> {
    text.parse::<f64>().ok()
}

/// Parses `data-slidra-text-width`/`-height`'s shared validation: a positive
/// finite number, or an explicit error naming the offending raw value.
fn parse_positive_dimension(raw: &str, element_id: &str, attribute: &str) -> SlidraResult<f64> {
    let trimmed = raw.trim();
    let value = js_parse_finite(trimmed);
    match value {
        Some(v) if !trimmed.is_empty() && v.is_finite() && v > 0.0 => Ok(v),
        _ => Err(SlidraError::invalid(format!(
            "element {element_id}\'s {attribute} is not a valid positive number: {raw}"
        ))),
    }
}

fn to_element(element: &ScannedNode, svg: &str) -> SlidraResult<SlideElement> {
    let transform = attribute_value(element, "transform");
    let children: Vec<&ScannedNode> = element
        .children
        .iter()
        .filter(|child| !IGNORED_CHILD_TAGS.contains(&child.tag.as_str()))
        .collect();
    let is_group = !children.is_empty() && children.iter().all(|child| child.tag == "g");

    let element_id = attribute_value(element, "id")
        .expect("assert_slide_compliant already required every container to have an id");
    let is_table =
        attribute_value(element, "data-slidra-type").as_deref() == Some(TABLE_CONTAINER_TYPE);

    let primitives: Vec<SlidePrimitive> = if is_group || is_table {
        Vec::new()
    } else {
        children
            .iter()
            .map(|child| to_primitive(child, svg))
            .collect()
    };

    let kind = if is_table {
        SlideElementKind::Table
    } else if is_group {
        SlideElementKind::Group
    } else if attribute_value(element, "data-slidra-type").as_deref() == Some(CHART_CONTAINER_TYPE)
    {
        SlideElementKind::Chart
    } else if primitives.len() == 1 {
        primitive_kind(&primitives[0].tag)
    } else {
        SlideElementKind::Compound
    };

    let text_width = match attribute_value(element, TEXT_WIDTH_ATTRIBUTE) {
        None => None,
        Some(raw) => Some(parse_positive_dimension(
            &raw,
            &element_id,
            TEXT_WIDTH_ATTRIBUTE,
        )?),
    };
    let text_height = match attribute_value(element, TEXT_HEIGHT_ATTRIBUTE) {
        None => None,
        Some(raw) => Some(parse_positive_dimension(
            &raw,
            &element_id,
            TEXT_HEIGHT_ATTRIBUTE,
        )?),
    };

    let text_align = read_text_align(element, &element_id)?;

    let table = if is_table {
        Some(read_table_grid(element, &element_id)?)
    } else {
        None
    };

    let child_elements: Vec<SlideElement> = if is_group && !is_table {
        children
            .iter()
            .map(|child| to_element(child, svg))
            .collect::<SlidraResult<Vec<_>>>()?
    } else {
        Vec::new()
    };

    Ok(SlideElement {
        id: element_id,
        name: attribute_value(element, "data-slidra-name"),
        media: attribute_value(element, "data-slidra-media"),
        kind,
        matrix: parse_transform(transform.as_deref())?,
        transform,
        children: child_elements,
        primitives,
        text_width,
        text_height,
        text_align,
        table,
    })
}

/// Parses a compliant slide into its model. A non-compliant slide fails
/// exactly as `assert_slide_compliant` does. `slide_path` defaults to
/// `"slide"` when `None`, matching the TS source's default parameter.
pub fn parse_slide(svg: &str, slide_path: Option<&str>) -> SlidraResult<SlideModel> {
    let slide_path = slide_path.unwrap_or("slide");
    assert_slide_compliant(svg, slide_path)?;
    let roots = scan_document(svg)?;
    let svg_root = roots
        .iter()
        .find(|element| element.tag == "svg")
        .expect("assert_slide_compliant already required a well-formed <svg> root");
    let view_box_text = attribute_value(svg_root, "viewBox")
        .expect("assert_slide_compliant already required a viewBox on the <svg> root");

    let parts: Vec<f64> = view_box_text
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|token| !token.is_empty())
        .map(|token| token.parse::<f64>().unwrap_or(f64::NAN))
        .collect();
    if parts.len() != 4 || parts.iter().any(|value| !value.is_finite()) {
        return Err(SlidraError::invalid(format!(
            "viewBox of slide {slide_path} is not four numbers: {view_box_text}"
        )));
    }
    let view_box = ViewBox {
        x: parts[0],
        y: parts[1],
        width: parts[2],
        height: parts[3],
    };

    let elements: Vec<SlideElement> = svg_root
        .children
        .iter()
        .filter(|child| child.tag == "g")
        .map(|child| to_element(child, svg))
        .collect::<SlidraResult<Vec<_>>>()?;

    Ok(SlideModel {
        view_box,
        elements,
        page_style: read_slide_page_style(svg)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(svg: &str) -> Vec<ComplianceCode> {
        check_slide_compliance(svg)
            .into_iter()
            .map(|issue| issue.code)
            .collect()
    }

    fn has(svg: &str, code: ComplianceCode) -> bool {
        codes(svg).contains(&code)
    }

    // --- one fixture per ComplianceCode ---

    #[test]
    fn bare_primitive_with_no_wrapping_container() {
        let svg = r#"<svg viewBox="0 0 100 100"><rect id="r1" width="10" height="10"/></svg>"#;
        assert!(has(svg, ComplianceCode::BarePrimitive));
    }

    #[test]
    fn forbidden_tag_anywhere_in_the_document() {
        let svg = r#"<svg viewBox="0 0 100 100"><foreignObject/></svg>"#;
        assert!(has(svg, ComplianceCode::ForbiddenTag));
    }

    #[test]
    fn unknown_tag_inside_a_container() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="g1"><polygon id="p1"/></g></svg>"#;
        assert!(has(svg, ComplianceCode::UnknownTag));
    }

    #[test]
    fn missing_id_on_a_container() {
        let svg = r#"<svg viewBox="0 0 100 100"><g><rect width="10" height="10"/></g></svg>"#;
        assert!(has(svg, ComplianceCode::MissingId));
    }

    #[test]
    fn duplicate_id_across_containers() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="dup"><rect width="1" height="1"/></g><g id="dup"><rect width="1" height="1"/></g></svg>"#;
        assert!(has(svg, ComplianceCode::DuplicateId));
    }

    #[test]
    fn empty_container_has_no_children() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="g1"></g></svg>"#;
        assert!(has(svg, ComplianceCode::EmptyContainer));
    }

    #[test]
    fn mixed_children_of_primitives_and_containers() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="g1"><rect id="r1" width="1" height="1"/><g id="g2"><rect id="r2" width="1" height="1"/></g></g></svg>"#;
        assert!(has(svg, ComplianceCode::MixedChildren));
    }

    #[test]
    fn primitive_transform_on_a_containerized_primitive() {
        // Note: a BARE (ungrouped) primitive with a transform only ever
        // produces `BarePrimitive` -- `walkPrimitive`'s transform check
        // (the only source of `PrimitiveTransform`) is never invoked for a
        // bare primitive's own children walk (`walkPrimitiveChildrenOnly`
        // skips it), confirmed by reading `checkSlideCompliance` itself. So
        // this fixture must wrap the primitive in a container to reach the
        // code path that actually raises `PrimitiveTransform`.
        let svg = r#"<svg viewBox="0 0 100 100"><g id="g1"><rect id="r1" width="1" height="1" transform="translate(1 1)"/></g></svg>"#;
        assert!(has(svg, ComplianceCode::PrimitiveTransform));
    }

    #[test]
    fn bad_transform_on_a_container() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="g1" transform="notafunction(1)"><rect id="r1" width="1" height="1"/></g></svg>"#;
        assert!(has(svg, ComplianceCode::BadTransform));
    }

    #[test]
    fn missing_viewbox_on_the_svg_root() {
        let svg = r#"<svg><g id="g1"><rect id="r1" width="1" height="1"/></g></svg>"#;
        assert!(has(svg, ComplianceCode::MissingViewbox));
    }

    #[test]
    fn too_deep_nesting_via_65_levels_of_g() {
        fn nested_g_svg(count: usize) -> String {
            let mut svg = String::from(r#"<svg viewBox="0 0 100 100">"#);
            for i in 0..count - 1 {
                svg.push_str(&format!(r#"<g id="g{i}">"#));
            }
            svg.push_str(&format!(r#"<g id="g{}"/>"#, count - 1));
            for _ in 0..count - 1 {
                svg.push_str("</g>");
            }
            svg.push_str("</svg>");
            svg
        }
        let svg = nested_g_svg(65);
        assert!(has(&svg, ComplianceCode::TooDeep));
    }

    #[test]
    fn malformed_markup_when_scan_errors() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="g1">"#; // unclosed <g>
        assert!(has(svg, ComplianceCode::MalformedMarkup));
    }

    #[test]
    fn invalid_table_shape_missing_grid_attributes() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="t1" data-slidra-type="table"><g data-slidra-cell="0,0"><rect/></g></g></svg>"#;
        assert!(has(svg, ComplianceCode::InvalidTableShape));
    }

    #[test]
    fn invalid_chart_shape_missing_the_rendered_svg() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="c1" data-slidra-type="chart"><slidra:chart/></g></svg>"#;
        assert!(has(svg, ComplianceCode::InvalidChartShape));
    }

    #[test]
    fn a_well_formed_slide_has_no_issues() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="g1"><rect id="r1" width="10" height="10"/></g></svg>"#;
        assert_eq!(check_slide_compliance(svg), Vec::new());
    }

    // --- read_text_align ---

    fn container_with_align(align: Option<&str>) -> ScannedNode {
        let svg = match align {
            Some(value) => format!(r#"<g id="e1" data-slidra-text-align="{value}"/>"#),
            None => r#"<g id="e1"/>"#.to_string(),
        };
        let mut roots = scan_document(&svg).unwrap();
        roots.remove(0)
    }

    #[test]
    fn read_text_align_defaults_to_left_when_absent() {
        let node = container_with_align(None);
        assert_eq!(read_text_align(&node, "e1").unwrap(), TextAlign::Left);
    }

    #[test]
    fn read_text_align_reads_left() {
        let node = container_with_align(Some("left"));
        assert_eq!(read_text_align(&node, "e1").unwrap(), TextAlign::Left);
    }

    #[test]
    fn read_text_align_reads_center() {
        let node = container_with_align(Some("center"));
        assert_eq!(read_text_align(&node, "e1").unwrap(), TextAlign::Center);
    }

    #[test]
    fn read_text_align_reads_right() {
        let node = container_with_align(Some("right"));
        assert_eq!(read_text_align(&node, "e1").unwrap(), TextAlign::Right);
    }

    #[test]
    fn read_text_align_rejects_invalid_value() {
        let node = container_with_align(Some("justify"));
        let err = read_text_align(&node, "e1").unwrap_err();
        assert_eq!(
            err.message(),
            "element e1\'s data-slidra-text-align is not a valid value (left, center or right): justify"
        );
    }

    // --- parse_slide happy path ---

    #[test]
    fn parse_slide_reads_view_box_and_elements() {
        let svg = r#"<svg viewBox="0 0 800 600"><g id="g1"><rect id="r1" x="1" y="2" width="3" height="4"/></g></svg>"#;
        let model = parse_slide(svg, None).unwrap();
        assert_eq!(
            model.view_box,
            ViewBox {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0
            }
        );
        assert_eq!(model.elements.len(), 1);
        assert_eq!(model.elements[0].id, "g1");
        assert_eq!(model.elements[0].kind, SlideElementKind::Rect);
        assert_eq!(model.elements[0].primitives.len(), 1);
    }

    #[test]
    fn parse_slide_rejects_a_noncompliant_slide_by_default_path_name() {
        let svg = r#"<svg viewBox="0 0 100 100"><rect id="r1" width="1" height="1"/></svg>"#;
        let err = parse_slide(svg, None).unwrap_err();
        assert!(err.message().contains("slide slide non-compliant"));
    }
}
