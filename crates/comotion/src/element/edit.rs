//! `element insert` / `delete` / `move` / `rotate` / `order` / `lock` /
//! `unlock` — ported from `packages/core/src/element-edit.ts` (plan section
//! 1.1, phase P3; `scale`/`resize`/`style set` are the same TS file's
//! remaining three primitives, ported separately in phase P4). Pure
//! `svg_content: &str -> CoMotionResult<String>` functions: every target is
//! located by scanning a FRESH `scan_document` result before each mutation,
//! rather than collecting offsets up front and hoping they still line up
//! after an earlier splice — a multi-target command costs an extra re-scan
//! per target, but "never stale offsets" is worth more here than that
//! micro-optimisation (plan section 2, boundary 9; D13).
//!
//! This file's small structural helpers (`require_svg_root`,
//! `find_container`, `require_container`, `validate_id_list`) are its OWN
//! copies, not shared with `element::group` even though that module needs
//! near-identical ones — mirroring the TS originals' actual duplication
//! (`element-edit.ts` and `element-group.ts` each declare their own). Only
//! the four splice primitives named in plan section 7 decision D6 were
//! consolidated into `element::splice`; these smaller helpers were not
//! named there, so this port does not extend that consolidation beyond
//! what was decided.

use crate::element::assert_not_locked;
use crate::element::splice::{
    Splice, apply_splices, attribute_removal_splice, build_transform_splice, set_attr_splice,
};
use crate::element::text::{read_text_font_info, rewrap_text_box_content};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::geometry::bbox::{Bbox, ElementBoundsOptions, element_bounds};
use crate::geometry::transform::{Point, TransformParts, invert_matrix};
use crate::slide::format::{
    CHART_CONTAINER_TYPE, SlideElement, TABLE_CONTAINER_TYPE, TEXT_WIDTH_ATTRIBUTE,
    assert_slide_compliant, parse_slide,
};
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::{FontMetrics, escape_xml_attr, utf16_offset_to_byte_offset};
use std::collections::{HashMap, HashSet, VecDeque};

fn require_svg_root(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
}

/// Depth-first search for the `<g id="...">` container named `id`, tracking
/// its immediate parent container (the `<svg>` root or an ancestor group).
fn find_container<'a>(
    svg_root: &'a ScannedNode,
    id: &str,
) -> Option<(&'a ScannedNode, &'a ScannedNode)> {
    fn search<'a>(parent: &'a ScannedNode, id: &str) -> Option<(&'a ScannedNode, &'a ScannedNode)> {
        for child in &parent.children {
            if child.tag != "g" {
                continue;
            }
            if attribute_value(child, "id").as_deref() == Some(id) {
                return Some((child, parent));
            }
            if let Some(found) = search(child, id) {
                return Some(found);
            }
        }
        None
    }
    search(svg_root, id)
}

fn require_container<'a>(
    svg_root: &'a ScannedNode,
    id: &str,
) -> CoMotionResult<(&'a ScannedNode, &'a ScannedNode)> {
    find_container(svg_root, id).ok_or_else(|| CoMotionError::invalid(format!("找不到元素：{id}")))
}

/// `elementIds` must be a non-empty list with no repeated id.
fn validate_id_list(element_ids: &[String]) -> CoMotionResult<()> {
    if element_ids.is_empty() {
        return Err(CoMotionError::invalid("元素清單不可為空"));
    }
    let mut seen = HashSet::with_capacity(element_ids.len());
    for id in element_ids {
        if !seen.insert(id) {
            return Err(CoMotionError::invalid(format!("元素清單重複：{id}")));
        }
    }
    Ok(())
}

/// Appends `markup` as the last child of `<svg>`, preserving every other
/// byte — via `element::splice::apply_splices`, so the UTF-16-to-byte
/// conversion `svg_root.content_end` needs is handled the same way every
/// other mutation in this crate handles it.
fn append_markup(svg_content: &str, markup: &str) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    Ok(apply_splices(
        svg_content,
        &[Splice {
            start: svg_root.content_end,
            end: svg_root.content_end,
            text: markup.to_string(),
        }],
    ))
}

// ---------------------------------------------------------------------------
// element insert
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertElementKind {
    Rect,
    Ellipse,
    Line,
    Image,
    Path,
    Video,
    Audio,
}

impl InsertElementKind {
    fn as_str(self) -> &'static str {
        match self {
            InsertElementKind::Rect => "rect",
            InsertElementKind::Ellipse => "ellipse",
            InsertElementKind::Line => "line",
            InsertElementKind::Image => "image",
            InsertElementKind::Path => "path",
            InsertElementKind::Video => "video",
            InsertElementKind::Audio => "audio",
        }
    }
}

/// [E2.T17]: default placeholder fill for a `video`/`audio` insert with
/// neither `--href` (a poster image) nor `--fill` — carried over verbatim
/// from `element-edit.ts`'s own constants (themselves carried over from the
/// front end's pre-existing colours). A literal hex value is fine here:
/// the constraint that forbids one (`design-contract.test.ts`) only
/// applies under `apps/web`.
const DEFAULT_VIDEO_FILL: &str = "#889";
const DEFAULT_AUDIO_FILL: &str = "#c66";

#[derive(Debug, Default)]
pub struct InsertElementInput {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub x1: Option<f64>,
    pub y1: Option<f64>,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    /// `path` only.
    pub d: Option<String>,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width: Option<f64>,
    /// `image` only (required there); `video`/`audio` optional poster.
    pub href: Option<String>,
    /// Any kind — ADR-0005 media placeholder marker.
    pub media: Option<String>,
    /// `video` only: marks `media` as a third-party player URL.
    pub embed: Option<String>,
}

fn require_finite_number(value: Option<f64>, flag: &str) -> CoMotionResult<f64> {
    match value {
        Some(v) if v.is_finite() => Ok(v),
        _ => Err(CoMotionError::invalid(format!(
            "element insert 缺少或不合法的參數：--{flag}"
        ))),
    }
}

fn require_positive_number(value: Option<f64>, flag: &str) -> CoMotionResult<f64> {
    let n = require_finite_number(value, flag)?;
    // `n <= 0.0` rather than TS's `!(rounded > 0)`: equivalent here because
    // `require_finite_number` already excludes NaN (for which the two
    // would disagree), so there is no incomparable case left to worry about.
    if n <= 0.0 {
        return Err(CoMotionError::invalid(format!(
            "--{flag} 必須是大於 0 的數字"
        )));
    }
    Ok(n)
}

/// Narrows an arbitrary string to the one embed provider this project
/// supports — ported out of `packages/core/src/embed.ts`'s
/// `requireEmbedProvider` only (plan section 2, boundary 17: "照移，不擴充
/// 支援的平台" — nothing else from `embed.ts` is in scope, since
/// `element insert` never resolves a YouTube URL itself, only validates and
/// stores the provider name the caller already resolved it to).
fn require_embed_provider(value: &str) -> CoMotionResult<&'static str> {
    match value {
        "youtube" => Ok("youtube"),
        _ => Err(CoMotionError::invalid(format!(
            "不支援的嵌入來源：{value}（支援的來源：youtube）"
        ))),
    }
}

/// Builds and appends one new element (`comotion element insert`).
/// `element_id` is generated by the caller (`workspace::write`) — this
/// module never generates ids itself.
pub fn insert_element(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    input: &InsertElementInput,
    kind: InsertElementKind,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;

    let fill_attr = input
        .fill
        .as_deref()
        .map(|v| format!(" fill=\"{}\"", escape_xml_attr(v)))
        .unwrap_or_default();
    // Applies to every kind, not just `line` — an outlined rect is the same
    // two attributes, so there is nothing kind-specific to special-case.
    let mut stroke_attr = String::new();
    if let Some(stroke) = input.stroke.as_deref() {
        stroke_attr.push_str(&format!(" stroke=\"{}\"", escape_xml_attr(stroke)));
    }
    if let Some(stroke_width) = input.stroke_width {
        let positive = require_positive_number(Some(stroke_width), "stroke-width")?;
        stroke_attr.push_str(&format!(
            " stroke-width=\"{}\"",
            format_svg_number(positive)
        ));
    }

    let mut container_attrs = format!("id=\"{element_id}\"");
    // Common to every kind: a media placeholder can be a `rect`
    // (video/audio, no `href`) as well as an `image`.
    if let Some(media) = input.media.as_deref() {
        container_attrs.push_str(&format!(" data-comot-media=\"{}\"", escape_xml_attr(media)));
    }
    if let Some(embed) = input.embed.as_deref() {
        // Validated, not passed through: an unknown provider must fail
        // here rather than be written into the file and only surface later
        // as an overlay that renders nothing.
        if kind != InsertElementKind::Video {
            return Err(CoMotionError::invalid(format!(
                "--embed 只能用在 --kind video（收到 --kind {}）",
                kind.as_str()
            )));
        }
        if input.media.is_none() {
            return Err(CoMotionError::invalid(
                "--embed 必須搭配 --media（嵌入播放器的網址）",
            ));
        }
        let provider = require_embed_provider(embed)?;
        container_attrs.push_str(&format!(" data-comot-embed=\"{provider}\""));
    }

    let native = match kind {
        InsertElementKind::Rect => {
            let x = require_finite_number(input.x, "x")?;
            let y = require_finite_number(input.y, "y")?;
            let width = require_positive_number(input.width, "width")?;
            let height = require_positive_number(input.height, "height")?;
            container_attrs.push_str(&format!(
                " transform=\"translate({} {})\"",
                format_svg_number(x),
                format_svg_number(y)
            ));
            format!(
                "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\"{fill_attr}{stroke_attr}/>",
                format_svg_number(width),
                format_svg_number(height)
            )
        }
        InsertElementKind::Ellipse => {
            let x = require_finite_number(input.x, "x")?;
            let y = require_finite_number(input.y, "y")?;
            let width = require_positive_number(input.width, "width")?;
            let height = require_positive_number(input.height, "height")?;
            let rx = width / 2.0;
            let ry = height / 2.0;
            container_attrs.push_str(&format!(
                " transform=\"translate({} {})\"",
                format_svg_number(x),
                format_svg_number(y)
            ));
            format!(
                "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\"{fill_attr}{stroke_attr}/>",
                format_svg_number(rx),
                format_svg_number(ry),
                format_svg_number(rx),
                format_svg_number(ry)
            )
        }
        InsertElementKind::Image => {
            let x = require_finite_number(input.x, "x")?;
            let y = require_finite_number(input.y, "y")?;
            let width = require_positive_number(input.width, "width")?;
            let height = require_positive_number(input.height, "height")?;
            let href = input
                .href
                .as_deref()
                .ok_or_else(|| CoMotionError::invalid("element insert image 缺少參數：--href"))?;
            container_attrs.push_str(&format!(
                " transform=\"translate({} {})\"",
                format_svg_number(x),
                format_svg_number(y)
            ));
            format!(
                "<image x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" href=\"{}\"{fill_attr}{stroke_attr}/>",
                format_svg_number(width),
                format_svg_number(height),
                escape_xml_attr(href)
            )
        }
        InsertElementKind::Line => {
            let x1 = require_finite_number(input.x1, "x1")?;
            let y1 = require_finite_number(input.y1, "y1")?;
            let x2 = require_finite_number(input.x2, "x2")?;
            let y2 = require_finite_number(input.y2, "y2")?;
            format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"{fill_attr}{stroke_attr}/>",
                format_svg_number(x1),
                format_svg_number(y1),
                format_svg_number(x2),
                format_svg_number(y2)
            )
        }
        InsertElementKind::Path => {
            let d = input
                .d
                .as_deref()
                .ok_or_else(|| CoMotionError::invalid("element insert path 缺少參數：--d"))?;
            let x = input.x.unwrap_or(0.0);
            let y = input.y.unwrap_or(0.0);
            if !x.is_finite() || !y.is_finite() {
                return Err(CoMotionError::invalid("--x/--y 必須是有限數字"));
            }
            if x != 0.0 || y != 0.0 {
                container_attrs.push_str(&format!(
                    " transform=\"translate({} {})\"",
                    format_svg_number(x),
                    format_svg_number(y)
                ));
            }
            format!(
                "<path d=\"{}\"{fill_attr}{stroke_attr}/>",
                escape_xml_attr(d)
            )
        }
        InsertElementKind::Video | InsertElementKind::Audio => {
            let x = require_finite_number(input.x, "x")?;
            let y = require_finite_number(input.y, "y")?;
            let width = require_positive_number(input.width, "width")?;
            let height = require_positive_number(input.height, "height")?;
            container_attrs.push_str(&format!(" data-comot-type=\"{}\"", kind.as_str()));
            container_attrs.push_str(&format!(
                " transform=\"translate({} {})\"",
                format_svg_number(x),
                format_svg_number(y)
            ));
            if let Some(href) = input.href.as_deref() {
                format!(
                    "<image x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" href=\"{}\"{fill_attr}{stroke_attr}/>",
                    format_svg_number(width),
                    format_svg_number(height),
                    escape_xml_attr(href)
                )
            } else {
                // Audio keeps its block either way — an <audio> overlay
                // paints nothing, so the rect IS the element on screen.
                // Video with media already attached uses `transparent`
                // (the player paints over this exact box) rather than
                // `none`, keeping the rect hit-testable.
                let rect_fill_attr = if input.fill.is_some() {
                    fill_attr.clone()
                } else if kind == InsertElementKind::Video && input.media.is_some() {
                    " fill=\"transparent\"".to_string()
                } else if kind == InsertElementKind::Video {
                    format!(" fill=\"{DEFAULT_VIDEO_FILL}\"")
                } else {
                    format!(" fill=\"{DEFAULT_AUDIO_FILL}\"")
                };
                format!(
                    "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\"{rect_fill_attr}{stroke_attr}/>",
                    format_svg_number(width),
                    format_svg_number(height)
                )
            }
        }
    };

    let markup = format!("<g {container_attrs}>{native}</g>");
    append_markup(svg_content, &markup)
}

// ---------------------------------------------------------------------------
// element delete
// ---------------------------------------------------------------------------

/// Every container id in `node`'s subtree (itself included) — used both to
/// skip a nested target already covered by an ancestor, and to find
/// dangling effect/comment references.
fn collect_container_ids(node: &ScannedNode, into: &mut HashSet<String>) {
    if let Some(id) = attribute_value(node, "id") {
        // `if (id)` in the TS original: an empty-string id is falsy there
        // and is never added — preserved here even though a real element
        // id is never empty in practice.
        if !id.is_empty() {
            into.insert(id);
        }
    }
    for child in &node.children {
        if child.tag == "g" {
            collect_container_ids(child, into);
        }
    }
}

/// ADR-0009's effects list: finds every `<comot:effect>` whose `target`
/// names an id being removed. Takes the FIRST `<metadata>`/`<comot:effects>`
/// found rather than erroring on a duplicate (unlike
/// `effects::edit::remove_effects_targeting`'s `locate_effects_list`) — this is
/// the TS original's own, more lenient, local scan (`findDanglingEffectRanges`
/// never validated list uniqueness), not something to "fix" while porting.
fn find_dangling_effect_ranges(
    svg_root: &ScannedNode,
    removed_ids: &HashSet<String>,
) -> Vec<Splice> {
    let Some(metadata) = svg_root
        .children
        .iter()
        .find(|child| child.tag == "metadata")
    else {
        return Vec::new();
    };
    let Some(effects_list) = metadata
        .children
        .iter()
        .find(|child| child.tag == "comot:effects")
    else {
        return Vec::new();
    };
    effects_list
        .children
        .iter()
        .filter(|child| child.tag == "comot:effect")
        .filter_map(|effect| {
            let target = attribute_value(effect, "target")?;
            removed_ids.contains(&target).then_some(Splice {
                start: effect.start,
                end: effect.end,
                text: String::new(),
            })
        })
        .collect()
}

/// [E2.T8]'s `<comot:comments>` list, same shape as
/// `find_dangling_effect_ranges` above. `target="page"` is never in
/// `removed_ids`, so page-level comments are never touched by this.
fn find_dangling_comment_ranges(
    svg_root: &ScannedNode,
    removed_ids: &HashSet<String>,
) -> Vec<Splice> {
    let Some(metadata) = svg_root
        .children
        .iter()
        .find(|child| child.tag == "metadata")
    else {
        return Vec::new();
    };
    let Some(comments_list) = metadata
        .children
        .iter()
        .find(|child| child.tag == "comot:comments")
    else {
        return Vec::new();
    };
    comments_list
        .children
        .iter()
        .filter(|child| child.tag == "comot:comment")
        .filter_map(|comment| {
            let target = attribute_value(comment, "target")?;
            removed_ids.contains(&target).then_some(Splice {
                start: comment.start,
                end: comment.end,
                text: String::new(),
            })
        })
        .collect()
}

/// Deletes every element named in `element_ids` (`comotion element
/// delete`). All-or-nothing: every id is confirmed present before any byte
/// is removed. A target that turns out to be a descendant of another
/// target is silently covered by the ancestor's removal, never
/// double-removed or reported as an error.
pub fn delete_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;

    let initial_roots = scan_document(svg_content)?;
    let initial_svg_root = require_svg_root(&initial_roots)?;
    let mut removed_ids = HashSet::new();
    for id in element_ids {
        let (node, _parent) = require_container(initial_svg_root, id)?;
        collect_container_ids(node, &mut removed_ids);
    }

    let mut current = svg_content.to_string();
    for id in element_ids {
        let roots = scan_document(&current)?;
        let svg_root = require_svg_root(&roots)?;
        let Some((node, _parent)) = find_container(svg_root, id) else {
            continue; // Already removed as another target's descendant.
        };
        current = apply_splices(
            &current,
            &[Splice {
                start: node.start,
                end: node.end,
                text: String::new(),
            }],
        );
    }

    let roots = scan_document(&current)?;
    let svg_root = require_svg_root(&roots)?;
    let mut splices = find_dangling_effect_ranges(svg_root, &removed_ids);
    splices.extend(find_dangling_comment_ranges(svg_root, &removed_ids));
    Ok(apply_splices(&current, &splices))
}

// ---------------------------------------------------------------------------
// element move / rotate — shared transform-delta application
// ---------------------------------------------------------------------------

fn apply_transform_delta(
    svg: &str,
    id: &str,
    force: bool,
    mutate: impl FnOnce(TransformParts) -> CoMotionResult<TransformParts>,
) -> CoMotionResult<String> {
    let roots = scan_document(svg)?;
    let svg_root = require_svg_root(&roots)?;
    let (node, _parent) = require_container(svg_root, id)?;
    assert_not_locked(node, id, force)?;
    let splice = build_transform_splice(svg, node, mutate)?;
    Ok(apply_splices(svg, &[splice]))
}

/// Moves every target by the same `(dx, dy)`, each applied independently to
/// its own container's `transform` (`comotion element move`).
pub fn move_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    dx: f64,
    dy: f64,
    force: bool,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    if !dx.is_finite() || !dy.is_finite() {
        return Err(CoMotionError::invalid("dx/dy 必須是有限數字"));
    }
    let mut current = svg_content.to_string();
    for id in element_ids {
        current = apply_transform_delta(&current, id, force, |mut parts| {
            parts.translate_x += dx;
            parts.translate_y += dy;
            Ok(parts)
        })?;
    }
    Ok(current)
}

/// Rotates every target by the same `degrees` delta, each applied
/// independently (`comotion element rotate`). A target whose existing
/// transform carries skew fails through `decompose_matrix`'s own error —
/// this command adds no separate check for it.
pub fn rotate_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    degrees: f64,
    force: bool,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    if !degrees.is_finite() {
        return Err(CoMotionError::invalid("degrees 必須是有限數字"));
    }
    let mut current = svg_content.to_string();
    for id in element_ids {
        current = apply_transform_delta(&current, id, force, |mut parts| {
            parts.rotation += degrees;
            Ok(parts)
        })?;
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// element order
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderDirection {
    Front,
    Back,
    Up,
    Down,
}

/// Swaps two adjacent sibling containers, keeping whatever sits between
/// them (whitespace, comments, other siblings) exactly where it was
/// relative to the pair. All four offsets are converted against the SAME
/// (unmodified) `svg` — no removal happens first, so no offset-shift
/// "adjust" step is needed (contrast `move_to_edge` below).
fn swap_adjacent_containers(svg: &str, x: &ScannedNode, y: &ScannedNode) -> String {
    let (first, second) = if x.start < y.start { (x, y) } else { (y, x) };
    let first_start = utf16_offset_to_byte_offset(svg, first.start);
    let first_end = utf16_offset_to_byte_offset(svg, first.end);
    let second_start = utf16_offset_to_byte_offset(svg, second.start);
    let second_end = utf16_offset_to_byte_offset(svg, second.end);
    format!(
        "{}{}{}{}{}",
        &svg[..first_start],
        &svg[second_start..second_end],
        &svg[first_end..second_start],
        &svg[first_start..first_end],
        &svg[second_end..]
    )
}

/// Moves one target to the front (topmost/last-in-document-order) or back
/// (bottommost/first) of its parent container. A no-op if it is the only
/// child, or already at the requested edge.
///
/// Not expressed via `apply_splices`: the insertion point (`parent`'s
/// content-end, or the first remaining sibling's start) must be computed
/// relative to the string AFTER the node is removed — `apply_splices`'s
/// contract (every splice's offsets valid against the ORIGINAL string) does
/// not fit a single "remove from here, insert there" move. The `adjust`
/// closure below is this function's own byte-offset version of the TS
/// original's UTF-16-offset `adjust`, both computed once against `svg` and
/// applied to `withoutNode`'s prefix, which is byte-identical to `svg`'s
/// prefix up to `node`'s own start.
fn move_to_edge(svg: &str, id: &str, to_front: bool, force: bool) -> CoMotionResult<String> {
    let roots = scan_document(svg)?;
    let svg_root = require_svg_root(&roots)?;
    let (node, parent) = require_container(svg_root, id)?;
    assert_not_locked(node, id, force)?;
    let siblings: Vec<&ScannedNode> = parent.children.iter().filter(|c| c.tag == "g").collect();
    if siblings.len() <= 1 {
        return Ok(svg.to_string()); // Only child — no-op.
    }
    let is_last = siblings.last().is_some_and(|s| s.start == node.start);
    let is_first = siblings.first().is_some_and(|s| s.start == node.start);
    if to_front && is_last {
        return Ok(svg.to_string());
    }
    if !to_front && is_first {
        return Ok(svg.to_string());
    }

    let node_start = utf16_offset_to_byte_offset(svg, node.start);
    let node_end = utf16_offset_to_byte_offset(svg, node.end);
    let node_text = &svg[node_start..node_end];
    let without_node = format!("{}{}", &svg[..node_start], &svg[node_end..]);
    let shift = node_end - node_start;
    let adjust = |offset: usize| -> usize {
        if offset > node_start {
            offset - shift
        } else {
            offset
        }
    };

    let insert_at = if to_front {
        adjust(utf16_offset_to_byte_offset(svg, parent.content_end))
    } else {
        let first_remaining = siblings
            .iter()
            .find(|s| s.start != node.start)
            .expect("more than one sibling, so a non-node sibling exists");
        adjust(utf16_offset_to_byte_offset(svg, first_remaining.start))
    };
    Ok(format!(
        "{}{}{}",
        &without_node[..insert_at],
        node_text,
        &without_node[insert_at..]
    ))
}

fn move_one_step(svg: &str, id: &str, up: bool, force: bool) -> CoMotionResult<String> {
    let roots = scan_document(svg)?;
    let svg_root = require_svg_root(&roots)?;
    let (node, parent) = require_container(svg_root, id)?;
    assert_not_locked(node, id, force)?;
    let siblings: Vec<&ScannedNode> = parent.children.iter().filter(|c| c.tag == "g").collect();
    let Some(index) = siblings.iter().position(|s| s.start == node.start) else {
        // `node` was found via `require_container`, which only ever
        // returns a `<g>`, so it is always among `siblings` — unreachable
        // in practice, kept as a hard error rather than a silent no-op.
        return Err(CoMotionError::invalid(format!(
            "找不到元素：{id}（未列在其父容器的子節點中）"
        )));
    };
    let swap_index = if up {
        index as isize + 1
    } else {
        index as isize - 1
    };
    if swap_index < 0 || swap_index as usize >= siblings.len() {
        return Ok(svg.to_string()); // Already at that edge — no-op.
    }
    Ok(swap_adjacent_containers(
        svg,
        node,
        siblings[swap_index as usize],
    ))
}

/// Reorders every target within its own parent container (`comotion
/// element order`). `front`/`back` process the list in order so the last id
/// ends up topmost/bottommost; `up`/`down` re-query siblings before each
/// step. Targets under different parents never interact.
pub fn reorder_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    direction: OrderDirection,
    force: bool,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    let mut current = svg_content.to_string();
    for id in element_ids {
        current = match direction {
            OrderDirection::Front => move_to_edge(&current, id, true, force)?,
            OrderDirection::Back => move_to_edge(&current, id, false, force)?,
            OrderDirection::Up => move_one_step(&current, id, true, force)?,
            OrderDirection::Down => move_one_step(&current, id, false, force)?,
        };
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// element lock / unlock (ADR-0013)
// ---------------------------------------------------------------------------

/// Sets `data-comot-lock="true"` on every target's container (`comotion
/// element lock`). Idempotent: locking an already-locked element succeeds
/// with no error. Never checks `assert_not_locked` itself — locking a
/// locked element is a no-op, not a rejection.
pub fn lock_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    let mut current = svg_content.to_string();
    for id in element_ids {
        let roots = scan_document(&current)?;
        let svg_root = require_svg_root(&roots)?;
        let (node, _parent) = require_container(svg_root, id)?;
        let splice = set_attr_splice(node, super::LOCK_ATTRIBUTE, "true");
        current = apply_splices(&current, &[splice]);
    }
    Ok(current)
}

/// Removes `data-comot-lock` from every target's container (`comotion
/// element unlock`) — unlocking clears the attribute entirely, it never
/// writes `data-comot-lock="false"`. Idempotent: unlocking an
/// already-unlocked element is a no-op.
pub fn unlock_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    let mut current = svg_content.to_string();
    for id in element_ids {
        let roots = scan_document(&current)?;
        let svg_root = require_svg_root(&roots)?;
        let (node, _parent) = require_container(svg_root, id)?;
        let Some(attr) = attribute_of(node, super::LOCK_ATTRIBUTE) else {
            continue;
        };
        let splice = attribute_removal_splice(node.start, &current, attr);
        current = apply_splices(&current, &[splice]);
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// shared: group/table/chart container detection (element scale / resize /
// style set all need these three checks; ported from element-edit.ts's
// module-level privates of the same names)
// ---------------------------------------------------------------------------

/// Doc furniture children accessibility markup can carry; never a real
/// target. Mirrors `element-edit.ts`'s `IGNORED_CHILD_TAGS`.
const IGNORED_CHILD_TAGS: [&str; 2] = ["title", "desc"];

fn meaningful_children(node: &ScannedNode) -> Vec<&ScannedNode> {
    node.children
        .iter()
        .filter(|child| !IGNORED_CHILD_TAGS.contains(&child.tag.as_str()))
        .collect()
}

/// ADR-0012: a container's children are all `<g>`, or all primitives — never
/// mixed. An unbound table's cells are all `<g data-comot-cell>` too
/// (E2.T14) — explicitly excluded here so scale/resize/style-set's group
/// recursion and lock-checking treat a table as a leaf, not a group whose
/// id-less cells they would otherwise try to recurse into.
fn is_group_container(node: &ScannedNode) -> bool {
    if attribute_value(node, "data-comot-type").as_deref() == Some(TABLE_CONTAINER_TYPE) {
        return false;
    }
    let children = meaningful_children(node);
    !children.is_empty() && children.iter().all(|child| child.tag == "g")
}

/// A table container's cells are not primitives `element scale`/`element
/// resize`/`element style set` know how to touch (E2.T14) — its style and
/// size are owned entirely by the `table` command family (F5, not this
/// ticket).
fn assert_not_table_container(
    node: &ScannedNode,
    element_id: &str,
    action: &str,
) -> CoMotionResult<()> {
    if attribute_value(node, "data-comot-type").as_deref() == Some(TABLE_CONTAINER_TYPE) {
        return Err(CoMotionError::invalid(format!(
            "元素 {element_id} 是表格，{action}"
        )));
    }
    Ok(())
}

/// A chart container's children (`<comot:chart>`, the data; `<svg>`, the
/// rendered picture) are not primitives these three commands know how to
/// touch either — checked before either ever dispatches on a container's
/// children, so the error names the real reason instead of a generic
/// "unsupported primitive `<comot:chart>`".
fn assert_not_chart_container(
    node: &ScannedNode,
    element_id: &str,
    action: &str,
) -> CoMotionResult<()> {
    if attribute_value(node, "data-comot-type").as_deref() == Some(CHART_CONTAINER_TYPE) {
        return Err(CoMotionError::invalid(format!(
            "元素 {element_id} 是圖表，{action}"
        )));
    }
    Ok(())
}

/// Rejects `id` (and, if it is a group, every descendant container inside
/// it) the moment any one of them is locked without `--force` (ADR-0013).
/// Runs entirely against the caller's `svg` snapshot before any splice, so a
/// lock three levels deep still blocks the whole command atomically instead
/// of leaving earlier siblings already rewritten.
fn assert_subtree_not_locked(svg: &str, id: &str, force: bool) -> CoMotionResult<()> {
    let roots = scan_document(svg)?;
    let svg_root = require_svg_root(&roots)?;
    let (node, _parent) = require_container(svg_root, id)?;
    assert_not_locked(node, id, force)?;
    if is_group_container(node) {
        for child in meaningful_children(node) {
            let child_id = attribute_value(child, "id")
                .ok_or_else(|| CoMotionError::invalid("群組子容器缺少 id，無法縮放"))?;
            assert_subtree_not_locked(svg, &child_id, force)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// element scale
// ---------------------------------------------------------------------------

/// Rounds through `format_svg_number` and rejects a value that is positive
/// on input but rounds to zero or below. Mirrors `workspace.ts`'s
/// `assertPositiveAfterRounding` / `element-edit.ts`'s local copy of it.
fn assert_positive_after_rounding(value: f64, message: String) -> CoMotionResult<f64> {
    let rounded: f64 = format_svg_number(value)
        .parse()
        .expect("format_svg_number always produces a string that reparses as f64");
    if rounded <= 0.0 {
        return Err(CoMotionError::invalid(message));
    }
    Ok(rounded)
}

fn scale_numeric_attr(
    node: &ScannedNode,
    name: &str,
    factor: f64,
    element_id: &str,
    must_stay_positive: bool,
) -> CoMotionResult<Splice> {
    let attr = attribute_of(node, name).ok_or_else(|| {
        CoMotionError::invalid(format!("元素 {element_id} 缺少屬性 {name}，無法縮放"))
    })?;
    let value = attr.value.parse::<f64>().unwrap_or(f64::NAN);
    if !value.is_finite() {
        return Err(CoMotionError::invalid(format!(
            "元素 {element_id} 的 {name} 不是合法數字：{}",
            attr.value
        )));
    }
    let scaled = value * factor;
    let rounded = if must_stay_positive {
        assert_positive_after_rounding(
            scaled,
            format!("元素 {element_id} 的 {name} 縮放後不是大於 0 的數字"),
        )?
    } else {
        scaled
    };
    Ok(Splice {
        start: attr.start,
        end: attr.end,
        text: format!("{name}=\"{}\"", format_svg_number(rounded)),
    })
}

/// Path `d` commands that carry an elliptical arc — scaling would require
/// re-deriving the arc's radii/rotation, which this ticket does not
/// implement (`geometry::bbox::path_bounds` has the same limitation).
fn scale_path_data(d: &str, factor: f64) -> CoMotionResult<String> {
    if d.contains('A') || d.contains('a') {
        return Err(CoMotionError::invalid("path 含有橢圓弧，尚不支援縮放"));
    }
    // Hand-written scan for `[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?` tokens —
    // no `regex` crate (plan decision D4). `d` is always ASCII (SVG path
    // grammar), so byte indices and `char` indices coincide throughout.
    let bytes = d.as_bytes();
    let mut out = String::with_capacity(d.len());
    let mut i = 0usize;
    while i < bytes.len() {
        match scan_number_token(bytes, i) {
            Some(end) => {
                let token = &d[i..end];
                let value: f64 = token.parse().unwrap_or(0.0);
                out.push_str(&format_svg_number(value * factor));
                i = end;
            }
            None => {
                out.push(bytes[i] as char);
                i += 1;
            }
        }
    }
    Ok(out)
}

/// Matches a `[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?` token starting exactly
/// at byte offset `start`, returning the end offset (exclusive) on a match.
/// `None` when no such token starts there — the caller then copies one
/// literal byte and retries, exactly reproducing a global-regex scan's
/// left-to-right, non-overlapping match sequence.
fn scan_number_token(bytes: &[u8], start: usize) -> Option<usize> {
    let n = bytes.len();
    let mut i = start;
    if i < n && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let mut has_digits_before_dot = false;
    while i < n && bytes[i].is_ascii_digit() {
        i += 1;
        has_digits_before_dot = true;
    }
    let mut has_digits_after_dot = false;
    if i < n && bytes[i] == b'.' {
        i += 1;
        let after_dot = i;
        while i < n && bytes[i].is_ascii_digit() {
            i += 1;
        }
        has_digits_after_dot = i > after_dot;
    }
    if !has_digits_before_dot && !has_digits_after_dot {
        return None;
    }
    let mantissa_end = i;
    if i < n && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < n && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let exp_digits = j;
        while j < n && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > exp_digits {
            i = j;
        } else {
            i = mantissa_end;
        }
    }
    Some(i)
}

fn build_primitive_scale_splices(
    node: &ScannedNode,
    factor: f64,
    element_id: &str,
) -> CoMotionResult<Vec<Splice>> {
    match node.tag.as_str() {
        "text" => {
            let Some(attr) = attribute_of(node, "font-size") else {
                return Ok(Vec::new());
            };
            let value = attr.value.parse::<f64>().unwrap_or(f64::NAN);
            let scaled = assert_positive_after_rounding(
                value * factor,
                format!("元素 {element_id} 的 font-size 縮放後不是大於 0 的數字"),
            )?;
            Ok(vec![Splice {
                start: attr.start,
                end: attr.end,
                text: format!("font-size=\"{}\"", format_svg_number(scaled)),
            }])
        }
        "rect" | "image" => Ok(vec![
            scale_numeric_attr(node, "width", factor, element_id, true)?,
            scale_numeric_attr(node, "height", factor, element_id, true)?,
        ]),
        "ellipse" => Ok(vec![
            scale_numeric_attr(node, "cx", factor, element_id, false)?,
            scale_numeric_attr(node, "cy", factor, element_id, false)?,
            scale_numeric_attr(node, "rx", factor, element_id, true)?,
            scale_numeric_attr(node, "ry", factor, element_id, true)?,
        ]),
        "circle" => Ok(vec![
            scale_numeric_attr(node, "cx", factor, element_id, false)?,
            scale_numeric_attr(node, "cy", factor, element_id, false)?,
            scale_numeric_attr(node, "r", factor, element_id, true)?,
        ]),
        "line" => ["x1", "y1", "x2", "y2"]
            .iter()
            .map(|name| scale_numeric_attr(node, name, factor, element_id, false))
            .collect(),
        "path" => {
            let attr = attribute_of(node, "d").ok_or_else(|| {
                CoMotionError::invalid(format!("元素 {element_id} 缺少屬性 d，無法縮放"))
            })?;
            let scaled_d = scale_path_data(&attr.value, factor)?;
            Ok(vec![Splice {
                start: attr.start,
                end: attr.end,
                text: format!("d=\"{scaled_d}\""),
            }])
        }
        other => Err(CoMotionError::invalid(format!(
            "不支援縮放的圖元 <{other}>：{element_id}"
        ))),
    }
}

/// `element scale`/`element resize` for the two containers whose children
/// are not scalable primitives. A table keeps its declared grid and scales
/// as a whole through its own container transform's `scale()` (only a
/// uniform factor is accepted — a non-uniform one would distort the text,
/// same rule as a text box). A chart would need to re-render at the new
/// size — the Rust binary has no chart-rendering engine yet (F5/NOOP-281 is
/// still `in_progress`, unmerged as of this ticket's round 3; verified via
/// `grep -rn CHART_CONTAINER_TYPE crates/comotion/src` finding only the
/// structural-validation constant, no renderer) — so this returns an
/// explicit `Failed` naming that ticket rather than attempting to port
/// chart rendering, a decision Dev-Leader signed off on for this ticket
/// (NOOP-309 comment thread). Returns `Ok(None)` for every other container
/// so the caller falls through to the primitive path.
fn scale_special_container(
    svg: &str,
    node: &ScannedNode,
    element_id: &str,
    sx: f64,
    sy: f64,
    force: bool,
) -> CoMotionResult<Option<String>> {
    let container_type = attribute_value(node, "data-comot-type");
    match container_type.as_deref() {
        Some(t) if t == TABLE_CONTAINER_TYPE => {
            if sx != sy {
                return Err(CoMotionError::invalid(format!(
                    "元素 {element_id} 是表格，文字無法非等比縮放，請改用 element scale"
                )));
            }
            let updated = apply_transform_delta(svg, element_id, force, |mut parts| {
                parts.scale_x *= sx;
                parts.scale_y *= sy;
                Ok(parts)
            })?;
            Ok(Some(updated))
        }
        Some(t) if t == CHART_CONTAINER_TYPE => Err(CoMotionError::invalid(format!(
            "元素 {element_id} 是圖表，縮放需要圖表命令族支援，見 NOOP-281"
        ))),
        _ => Ok(None),
    }
}

/// Scales a leaf container's own primitive(s). A text box
/// (`data-comot-text-width` present) re-wraps its content at the scaled
/// width/font-size (`rewrapTextBoxContent`, mirroring
/// `scaleLeafPrimitives`'s text-box branch, `element-edit.ts:688-733`): the
/// new `font-size` is spliced onto the `<text>` FIRST, the document is
/// re-scanned so the rewrap sees the post-splice node, and only then is
/// `rewrap_text_box_content` called — reusing a stale offset here would
/// produce output that runs but is wrong.
fn scale_leaf_primitives(
    svg: &str,
    container: &ScannedNode,
    factor: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    element_id: &str,
) -> CoMotionResult<String> {
    if let Some(text_width_attr) = attribute_of(container, TEXT_WIDTH_ATTRIBUTE) {
        let text_node = meaningful_children(container)
            .into_iter()
            .find(|primitive| primitive.tag == "text")
            .ok_or_else(|| CoMotionError::invalid(format!("元素不是合法的文字框：{element_id}")))?;
        let current_width: f64 = text_width_attr.value.parse().unwrap_or(f64::NAN);
        let (font_family, font_size) = read_text_font_info(text_node, element_id)?;
        let new_width = assert_positive_after_rounding(
            current_width * factor,
            format!("元素 {element_id} 的文字框寬度縮放後不是大於 0 的數字"),
        )?;
        let new_font_size = assert_positive_after_rounding(
            font_size * factor,
            format!("元素 {element_id} 的 font-size 縮放後不是大於 0 的數字"),
        )?;
        let with_font_size = apply_splices(
            svg,
            &[set_attr_splice(
                text_node,
                "font-size",
                &format_svg_number(new_font_size),
            )],
        );
        let refreshed_roots = scan_document(&with_font_size)?;
        let refreshed_svg_root = require_svg_root(&refreshed_roots)?;
        let (refreshed_container, _parent) = require_container(refreshed_svg_root, element_id)?;
        let refreshed_text_node = meaningful_children(refreshed_container)
            .into_iter()
            .find(|primitive| primitive.tag == "text")
            .expect("the <text> node just spliced must still be findable after re-scanning");
        let refreshed_width_attr = attribute_of(refreshed_container, TEXT_WIDTH_ATTRIBUTE)
            .expect("presence already checked above via text_width_attr");
        let result = rewrap_text_box_content(
            &with_font_size,
            refreshed_container,
            refreshed_text_node,
            refreshed_width_attr.start,
            refreshed_width_attr.end,
            new_width,
            &font_family,
            new_font_size,
            fonts,
            element_id,
        )?;
        return Ok(result.updated);
    }
    let mut splices = Vec::new();
    for primitive in meaningful_children(container) {
        splices.extend(build_primitive_scale_splices(
            primitive, factor, element_id,
        )?);
    }
    Ok(apply_splices(svg, &splices))
}

/// Scales one target by `factor`, anchored at the target's own container
/// origin: the target's own `transform` never changes. A group target
/// recurses — every descendant container's own `translateX/Y` is multiplied
/// by `factor` once per level (never compounding with depth), and every
/// leaf's native geometry is scaled by `build_primitive_scale_splices` (or
/// rejected, for a text box — see `scale_leaf_primitives`).
///
/// Re-locates each node by id from a fresh `scan_document` before touching
/// it (a worklist of ids, not a single offset-collecting walk) so a splice
/// earlier in the subtree never invalidates a sibling's or child's offsets.
fn scale_one_container(
    svg: &str,
    id: &str,
    factor: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    assert_subtree_not_locked(svg, id, force)?;

    let mut current = svg.to_string();
    let mut worklist: VecDeque<(String, bool)> = VecDeque::new();
    worklist.push_back((id.to_string(), true));

    while let Some((current_id, is_target)) = worklist.pop_front() {
        if !is_target {
            // Lock was already checked for every node in the subtree by
            // `assert_subtree_not_locked` above, so `force: true` here can
            // never actually be rejected — it just skips a redundant check.
            current = apply_transform_delta(&current, &current_id, true, |mut parts| {
                parts.translate_x *= factor;
                parts.translate_y *= factor;
                Ok(parts)
            })?;
        }

        let refreshed_roots = scan_document(&current)?;
        let refreshed_svg_root = require_svg_root(&refreshed_roots)?;
        let (refreshed_node, _parent) = require_container(refreshed_svg_root, &current_id)?;

        if is_group_container(refreshed_node) {
            for child in meaningful_children(refreshed_node) {
                let child_id = attribute_value(child, "id")
                    .ok_or_else(|| CoMotionError::invalid("群組子容器缺少 id，無法縮放"))?;
                worklist.push_back((child_id, false));
            }
        } else {
            current = match scale_special_container(
                &current,
                refreshed_node,
                &current_id,
                factor,
                factor,
                force,
            )? {
                Some(updated) => updated,
                None => {
                    scale_leaf_primitives(&current, refreshed_node, factor, fonts, &current_id)?
                }
            };
        }
    }

    Ok(current)
}

/// Scales every target by the same `factor` (`comotion element scale`).
pub fn scale_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    factor: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    if !factor.is_finite() || factor <= 0.0 {
        return Err(CoMotionError::invalid("factor 必須是大於 0 的數字"));
    }
    let mut current = svg_content.to_string();
    for id in element_ids {
        current = scale_one_container(&current, id, factor, fonts, force)?;
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// element resize
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResizeAnchor {
    Nw,
    Ne,
    Sw,
    Se,
}

/// The local corner of `box_` that `anchor` names — "nw" is `(box_.x,
/// box_.y)`, "se" is the opposite corner, etc.
fn anchor_corner(anchor: ResizeAnchor, box_: &Bbox) -> Point {
    Point {
        x: if matches!(anchor, ResizeAnchor::Ne | ResizeAnchor::Se) {
            box_.x + box_.width
        } else {
            box_.x
        },
        y: if matches!(anchor, ResizeAnchor::Sw | ResizeAnchor::Se) {
            box_.y + box_.height
        } else {
            box_.y
        },
    }
}

/// Scales `name` (defaulting to 0 per the SVG spec when absent) by `factor`
/// — absent stays absent since `0 * factor` is still the default.
fn scale_optional_numeric_attr(
    node: &ScannedNode,
    name: &str,
    factor: f64,
    element_id: &str,
) -> CoMotionResult<Vec<Splice>> {
    if attribute_of(node, name).is_none() {
        return Ok(Vec::new());
    }
    Ok(vec![scale_numeric_attr(
        node, name, factor, element_id, false,
    )?])
}

/// Non-uniform counterpart to `build_primitive_scale_splices`: `sx`/`sy`
/// scale the x-ish and y-ish native attributes independently. Shapes whose
/// data model has no non-uniform representation (`<text>`'s `font-size` is a
/// single scalar; `<circle>`'s `r` likewise; a non-uniform `<path>` would
/// need per-command axis-aware re-derivation this ticket does not implement)
/// reject a non-uniform request outright.
fn build_primitive_resize_splices(
    node: &ScannedNode,
    sx: f64,
    sy: f64,
    element_id: &str,
) -> CoMotionResult<Vec<Splice>> {
    match node.tag.as_str() {
        "rect" | "image" => {
            let mut splices = scale_optional_numeric_attr(node, "x", sx, element_id)?;
            splices.extend(scale_optional_numeric_attr(node, "y", sy, element_id)?);
            splices.push(scale_numeric_attr(node, "width", sx, element_id, true)?);
            splices.push(scale_numeric_attr(node, "height", sy, element_id, true)?);
            Ok(splices)
        }
        "ellipse" => Ok(vec![
            scale_numeric_attr(node, "cx", sx, element_id, false)?,
            scale_numeric_attr(node, "cy", sy, element_id, false)?,
            scale_numeric_attr(node, "rx", sx, element_id, true)?,
            scale_numeric_attr(node, "ry", sy, element_id, true)?,
        ]),
        "line" => Ok(vec![
            scale_numeric_attr(node, "x1", sx, element_id, false)?,
            scale_numeric_attr(node, "y1", sy, element_id, false)?,
            scale_numeric_attr(node, "x2", sx, element_id, false)?,
            scale_numeric_attr(node, "y2", sy, element_id, false)?,
        ]),
        "text" => {
            if sx != sy {
                return Err(CoMotionError::invalid(format!(
                    "元素 {element_id} 含 <text>，font-size 無法非等比縮放，請改用 element scale"
                )));
            }
            build_primitive_scale_splices(node, sx, element_id)
        }
        "circle" => {
            if sx != sy {
                return Err(CoMotionError::invalid(format!(
                    "元素 {element_id} 是 <circle>，無法非等比縮放，請改用 element scale"
                )));
            }
            build_primitive_scale_splices(node, sx, element_id)
        }
        "path" => {
            if sx != sy {
                return Err(CoMotionError::invalid(format!(
                    "元素 {element_id} 是 <path>，無法非等比縮放，請改用 element scale"
                )));
            }
            build_primitive_scale_splices(node, sx, element_id)
        }
        other => Err(CoMotionError::invalid(format!(
            "不支援縮放的圖元 <{other}>：{element_id}"
        ))),
    }
}

/// Resize counterpart to `scale_leaf_primitives` — a text box only has a
/// single scalar `font-size`, so a non-uniform `(sx, sy)` is rejected
/// outright; an equal `(sx, sy)` delegates to `scale_leaf_primitives`
/// (mirroring `resizeLeafPrimitives`'s text-box branch,
/// `element-edit.ts:956-977`).
fn resize_leaf_primitives(
    svg: &str,
    container: &ScannedNode,
    sx: f64,
    sy: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    element_id: &str,
) -> CoMotionResult<String> {
    if attribute_of(container, TEXT_WIDTH_ATTRIBUTE).is_some() {
        if sx != sy {
            return Err(CoMotionError::invalid(format!(
                "元素 {element_id} 含 <text>，font-size 無法非等比縮放，請改用 element scale"
            )));
        }
        return scale_leaf_primitives(svg, container, sx, fonts, element_id);
    }
    let mut splices = Vec::new();
    for primitive in meaningful_children(container) {
        splices.extend(build_primitive_resize_splices(
            primitive, sx, sy, element_id,
        )?);
    }
    Ok(apply_splices(svg, &splices))
}

/// Resize counterpart to `scale_one_container`: same worklist/re-scan shape,
/// `(sx, sy)` applied per axis instead of one `factor`. The target's own
/// container `transform` is left untouched here too — `resize_one_target`
/// applies the anchor-preserving translate delta afterward, once.
fn resize_one_container(
    svg: &str,
    id: &str,
    sx: f64,
    sy: f64,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    assert_subtree_not_locked(svg, id, force)?;

    let mut current = svg.to_string();
    let mut worklist: VecDeque<(String, bool)> = VecDeque::new();
    worklist.push_back((id.to_string(), true));

    while let Some((current_id, is_target)) = worklist.pop_front() {
        if !is_target {
            current = apply_transform_delta(&current, &current_id, true, |mut parts| {
                parts.translate_x *= sx;
                parts.translate_y *= sy;
                Ok(parts)
            })?;
        }

        let refreshed_roots = scan_document(&current)?;
        let refreshed_svg_root = require_svg_root(&refreshed_roots)?;
        let (refreshed_node, _parent) = require_container(refreshed_svg_root, &current_id)?;

        if is_group_container(refreshed_node) {
            for child in meaningful_children(refreshed_node) {
                let child_id = attribute_value(child, "id")
                    .ok_or_else(|| CoMotionError::invalid("群組子容器缺少 id，無法縮放"))?;
                worklist.push_back((child_id, false));
            }
        } else {
            current = match scale_special_container(
                &current,
                refreshed_node,
                &current_id,
                sx,
                sy,
                force,
            )? {
                Some(updated) => updated,
                None => {
                    resize_leaf_primitives(&current, refreshed_node, sx, sy, fonts, &current_id)?
                }
            };
        }
    }

    Ok(current)
}

/// Depth-first search of a parsed slide model for `id` — resize only ever
/// needs the element's own local matrix, never an ancestor chain (the
/// anchor delta below is entirely local to the target's own container).
fn find_element_by_id<'a>(elements: &'a [SlideElement], id: &str) -> Option<&'a SlideElement> {
    for element in elements {
        if element.id == id {
            return Some(element);
        }
        if let Some(found) = find_element_by_id(&element.children, id) {
            return Some(found);
        }
    }
    None
}

/// Resizes one target to exactly `(width, height)`, anchored so that the
/// named corner of its bounding box — computed in the target's own local
/// frame, i.e. with the target's own `transform` factored out via
/// `invert_matrix` — lands on exactly the same spot after the resize.
///
/// Native geometry is scaled by `(sx, sy)` about that local frame's origin
/// (`resize_one_container`, mirroring `scale_one_container`'s single-`factor`
/// version); the target's own container transform's rotation and any
/// pre-existing scale are left alone, and only its translate is shifted by
/// the delta the anchor corner moved by that scaling — expressed back
/// through the target's own matrix so a rotated target still keeps its
/// anchor corner fixed in the parent's frame.
#[allow(clippy::too_many_arguments)] // mirrors element-resize.ts's resizeElements' 1:1 parameter shape
fn resize_one_target(
    svg: &str,
    slide_path: &str,
    id: &str,
    width: f64,
    height: f64,
    anchor: ResizeAnchor,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    let model = parse_slide(svg, Some(slide_path))?;
    let element = find_element_by_id(&model.elements, id)
        .ok_or_else(|| CoMotionError::invalid(format!("找不到元素：{id}")))?;

    let inverse = invert_matrix(&element.matrix)?;
    let local_box = element_bounds(
        element,
        &ElementBoundsOptions {
            ancestors: &[inverse],
            fonts: Some(fonts),
        },
    )?;
    if local_box.width <= 0.0 || local_box.height <= 0.0 {
        return Err(CoMotionError::invalid(format!(
            "元素 {id} 沒有邊界框，無法縮放"
        )));
    }
    let sx = width / local_box.width;
    let sy = height / local_box.height;

    let corner_before = anchor_corner(anchor, &local_box);
    let corner_after = Point {
        x: corner_before.x * sx,
        y: corner_before.y * sy,
    };
    let delta_local = Point {
        x: corner_before.x - corner_after.x,
        y: corner_before.y - corner_after.y,
    };
    // The target's own matrix's linear part (no translation) carries a
    // local delta into the parent's frame — this is what makes a rotated
    // target's anchor corner land correctly instead of only working
    // axis-aligned.
    let matrix = element.matrix;
    let delta_parent = Point {
        x: matrix.a * delta_local.x + matrix.c * delta_local.y,
        y: matrix.b * delta_local.x + matrix.d * delta_local.y,
    };

    let mut current = resize_one_container(svg, id, sx, sy, fonts, force)?;
    current = apply_transform_delta(&current, id, true, |mut parts| {
        parts.translate_x += delta_parent.x;
        parts.translate_y += delta_parent.y;
        Ok(parts)
    })?;
    Ok(current)
}

/// Resizes every target to the same `(width, height)` (`comotion element
/// resize`).
#[allow(clippy::too_many_arguments)] // mirrors element-edit.ts's resizeElements' 1:1 parameter shape
pub fn resize_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    width: f64,
    height: f64,
    anchor: ResizeAnchor,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    if !width.is_finite() || width <= 0.0 {
        return Err(CoMotionError::invalid("width 必須是大於 0 的數字"));
    }
    if !height.is_finite() || height <= 0.0 {
        return Err(CoMotionError::invalid("height 必須是大於 0 的數字"));
    }
    let mut current = svg_content.to_string();
    for id in element_ids {
        current = resize_one_target(
            &current, slide_path, id, width, height, anchor, fonts, force,
        )?;
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// element style set (ADR-0014)
// ---------------------------------------------------------------------------

/// ADR-0014: the style command uses SVG attribute names directly. Nine
/// entries, not to be extended — ADR-0014 explicitly forbids growing this
/// list from within this ticket.
const STYLE_ATTRIBUTE_WHITELIST: &[&str] = &[
    "fill",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "text-anchor",
];

const FORBIDDEN_STYLE_ATTRIBUTES: &[&str] = &["transform", "x", "y", "width", "height"];

fn validate_style_attribute(attr: &str, value: &str) -> CoMotionResult<()> {
    if FORBIDDEN_STYLE_ATTRIBUTES.contains(&attr) {
        return Err(CoMotionError::invalid(format!(
            "樣式屬性 {attr} 不在樣式白名單內，位置與大小必須透過 move/scale 命令調整"
        )));
    }
    if attr.starts_with("data-comot-") {
        return Err(CoMotionError::invalid(format!(
            "樣式屬性 {attr} 是保留屬性前綴 data-comot-，不可透過 element style set 設定"
        )));
    }
    if !STYLE_ATTRIBUTE_WHITELIST.contains(&attr) {
        return Err(CoMotionError::invalid(format!(
            "樣式屬性 {attr} 不在樣式白名單內"
        )));
    }
    if attr == "opacity" {
        let n = value.parse::<f64>().unwrap_or(f64::NAN);
        if !(0.0..=1.0).contains(&n) {
            return Err(CoMotionError::invalid("opacity 必須是 0 到 1 之間的數字"));
        }
    }
    if attr == "font-size" {
        let n = value.parse::<f64>().unwrap_or(f64::NAN);
        if !n.is_finite() || n <= 0.0 {
            return Err(CoMotionError::invalid("font-size 必須是大於 0 的數字"));
        }
    }
    if attr == "stroke-width" {
        let n = value.parse::<f64>().unwrap_or(f64::NAN);
        if !n.is_finite() || n < 0.0 {
            return Err(CoMotionError::invalid("stroke-width 不可為負數"));
        }
    }
    if attr == "text-anchor" && !["start", "middle", "end"].contains(&value) {
        return Err(CoMotionError::invalid(
            "text-anchor 必須是 start、middle 或 end",
        ));
    }
    Ok(())
}

fn set_style_on_container(
    svg: &str,
    id: &str,
    attr: &str,
    value: &str,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    let roots = scan_document(svg)?;
    let svg_root = require_svg_root(&roots)?;
    let (node, _parent) = require_container(svg_root, id)?;
    assert_not_locked(node, id, force)?;
    assert_not_table_container(node, id, "樣式請用 table 命令族調整")?;
    assert_not_chart_container(node, id, "樣式請用 chart 命令族調整")?;

    if is_group_container(node) {
        return Err(CoMotionError::invalid(format!(
            "元素 {id} 是群組，沒有可套用樣式的圖元"
        )));
    }

    let is_text_box = attribute_of(node, TEXT_WIDTH_ATTRIBUTE).is_some();
    if attr == "text-anchor" && is_text_box {
        return Err(CoMotionError::invalid(format!(
            "文字框不支援 text-anchor（換行引擎假設 start）：{id}"
        )));
    }
    // A text box's font-size/font-family change re-wraps its content
    // (`rewrapTextBoxContent`, mirroring `setStyleOnContainer`'s text-box
    // branch, `element-edit.ts:1216-1252`) — every other whitelisted
    // attribute (fill/stroke/opacity/...) is a plain splice onto the
    // `<text>` primitive with no layout consequence, so only these two need
    // the rewrap path.
    if is_text_box && (attr == "font-size" || attr == "font-family") {
        let text_node = meaningful_children(node)
            .into_iter()
            .find(|primitive| primitive.tag == "text")
            .ok_or_else(|| CoMotionError::invalid(format!("元素不是合法的文字框：{id}")))?;
        let current_info = read_text_font_info(text_node, id)?;
        let with_attr = apply_splices(svg, &[set_attr_splice(text_node, attr, value)]);
        let refreshed_roots = scan_document(&with_attr)?;
        let refreshed_svg_root = require_svg_root(&refreshed_roots)?;
        let (refreshed_container, _parent) = require_container(refreshed_svg_root, id)?;
        let refreshed_text_node = meaningful_children(refreshed_container)
            .into_iter()
            .find(|primitive| primitive.tag == "text")
            .expect("the <text> node just spliced must still be findable after re-scanning");
        let refreshed_width_attr = attribute_of(refreshed_container, TEXT_WIDTH_ATTRIBUTE)
            .expect("is_text_box already checked presence");
        let width: f64 = refreshed_width_attr.value.parse().unwrap_or(f64::NAN);
        let font_family = if attr == "font-family" {
            value.to_string()
        } else {
            current_info.0
        };
        let font_size = if attr == "font-size" {
            value.parse::<f64>().unwrap_or(f64::NAN)
        } else {
            current_info.1
        };
        let result = rewrap_text_box_content(
            &with_attr,
            refreshed_container,
            refreshed_text_node,
            refreshed_width_attr.start,
            refreshed_width_attr.end,
            width,
            &font_family,
            font_size,
            fonts,
            id,
        )?;
        return Ok(result.updated);
    }

    let splices: Vec<Splice> = meaningful_children(node)
        .into_iter()
        .map(|primitive| set_attr_splice(primitive, attr, value))
        .collect();
    Ok(apply_splices(svg, &splices))
}

/// Sets `attr` to `value` on every target's primitive (`comotion element
/// style set`). `attr` must be in the whitelist and pass its per-attribute
/// value validation before any target is touched.
pub fn set_element_style(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    attr: &str,
    value: &str,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
    force: bool,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    validate_style_attribute(attr, value)?;
    let mut current = svg_content.to_string();
    for id in element_ids {
        current = set_style_on_container(&current, id, attr, value, fonts, force)?;
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slide(children: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">{children}</svg>"#
        )
    }

    // --- element insert ---

    #[test]
    fn insert_rect_appends_as_last_child_with_translate_and_native_dims() {
        let svg = slide(r#"<g id="existing"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let input = InsertElementInput {
            x: Some(10.0),
            y: Some(20.0),
            width: Some(100.0),
            height: Some(50.0),
            fill: Some("#3366ff".to_string()),
            ..Default::default()
        };
        let updated = insert_element(
            &svg,
            "slides/001.svg",
            "el-new",
            &input,
            InsertElementKind::Rect,
        )
        .unwrap();
        assert!(updated.ends_with(
            r##"<g id="existing"><rect x="0" y="0" width="1" height="1"/></g><g id="el-new" transform="translate(10 20)"><rect x="0" y="0" width="100" height="50" fill="#3366ff"/></g></svg>"##
        ));
    }

    #[test]
    fn insert_rect_missing_width_errors() {
        let svg = slide("");
        let input = InsertElementInput {
            x: Some(0.0),
            y: Some(0.0),
            height: Some(10.0),
            ..Default::default()
        };
        let err = insert_element(
            &svg,
            "slides/001.svg",
            "el-new",
            &input,
            InsertElementKind::Rect,
        )
        .unwrap_err();
        assert_eq!(err.message(), "element insert 缺少或不合法的參數：--width");
    }

    #[test]
    fn insert_image_missing_href_errors() {
        let svg = slide("");
        let input = InsertElementInput {
            x: Some(0.0),
            y: Some(0.0),
            width: Some(10.0),
            height: Some(10.0),
            ..Default::default()
        };
        let err = insert_element(
            &svg,
            "slides/001.svg",
            "el-new",
            &input,
            InsertElementKind::Image,
        )
        .unwrap_err();
        assert_eq!(err.message(), "element insert image 缺少參數：--href");
    }

    #[test]
    fn insert_embed_requires_video_kind() {
        let svg = slide("");
        let input = InsertElementInput {
            x: Some(0.0),
            y: Some(0.0),
            width: Some(10.0),
            height: Some(10.0),
            media: Some("https://youtu.be/dQw4w9WgXcQ".to_string()),
            embed: Some("youtube".to_string()),
            ..Default::default()
        };
        let err = insert_element(
            &svg,
            "slides/001.svg",
            "el-new",
            &input,
            InsertElementKind::Rect,
        )
        .unwrap_err();
        assert_eq!(
            err.message(),
            "--embed 只能用在 --kind video（收到 --kind rect）"
        );
    }

    #[test]
    fn insert_embed_requires_media() {
        let svg = slide("");
        let input = InsertElementInput {
            x: Some(0.0),
            y: Some(0.0),
            width: Some(10.0),
            height: Some(10.0),
            embed: Some("youtube".to_string()),
            ..Default::default()
        };
        let err = insert_element(
            &svg,
            "slides/001.svg",
            "el-new",
            &input,
            InsertElementKind::Video,
        )
        .unwrap_err();
        assert_eq!(
            err.message(),
            "--embed 必須搭配 --media（嵌入播放器的網址）"
        );
    }

    #[test]
    fn insert_embed_rejects_unsupported_provider() {
        let svg = slide("");
        let input = InsertElementInput {
            x: Some(0.0),
            y: Some(0.0),
            width: Some(10.0),
            height: Some(10.0),
            media: Some("https://vimeo.com/1".to_string()),
            embed: Some("vimeo".to_string()),
            ..Default::default()
        };
        let err = insert_element(
            &svg,
            "slides/001.svg",
            "el-new",
            &input,
            InsertElementKind::Video,
        )
        .unwrap_err();
        assert_eq!(
            err.message(),
            "不支援的嵌入來源：vimeo（支援的來源：youtube）"
        );
    }

    #[test]
    fn insert_video_without_href_or_fill_or_media_uses_default_video_fill() {
        let svg = slide("");
        let input = InsertElementInput {
            x: Some(0.0),
            y: Some(0.0),
            width: Some(10.0),
            height: Some(10.0),
            ..Default::default()
        };
        let updated = insert_element(
            &svg,
            "slides/001.svg",
            "el-v",
            &input,
            InsertElementKind::Video,
        )
        .unwrap();
        assert!(updated.contains(r##"fill="#889""##));
    }

    #[test]
    fn insert_video_with_media_and_no_href_uses_transparent_fill() {
        let svg = slide("");
        let input = InsertElementInput {
            x: Some(0.0),
            y: Some(0.0),
            width: Some(10.0),
            height: Some(10.0),
            media: Some("assets/clip.mp4".to_string()),
            ..Default::default()
        };
        let updated = insert_element(
            &svg,
            "slides/001.svg",
            "el-v",
            &input,
            InsertElementKind::Video,
        )
        .unwrap();
        assert!(updated.contains(r#"fill="transparent""#));
    }

    #[test]
    fn insert_line_ignores_x_y_and_uses_x1_y1_x2_y2() {
        let svg = slide("");
        let input = InsertElementInput {
            x1: Some(0.0),
            y1: Some(0.0),
            x2: Some(100.0),
            y2: Some(50.0),
            stroke: Some("black".to_string()),
            ..Default::default()
        };
        let updated = insert_element(
            &svg,
            "slides/001.svg",
            "el-l",
            &input,
            InsertElementKind::Line,
        )
        .unwrap();
        assert!(updated.contains(r#"<line x1="0" y1="0" x2="100" y2="50" stroke="black"/>"#));
        assert!(!updated.contains("transform"));
    }

    #[test]
    fn insert_path_at_origin_omits_transform() {
        let svg = slide("");
        let input = InsertElementInput {
            d: Some("M0 0 L10 10".to_string()),
            ..Default::default()
        };
        let updated = insert_element(
            &svg,
            "slides/001.svg",
            "el-p",
            &input,
            InsertElementKind::Path,
        )
        .unwrap();
        assert!(!updated.contains("transform"));
        assert!(updated.contains(r#"<path d="M0 0 L10 10"/>"#));
    }

    // --- element delete ---

    #[test]
    fn delete_removes_element_and_dangling_effect_and_comment() {
        let svg = slide(
            r#"<metadata><comot:effects xmlns:comot="https://co-motion.dev/ns"><comot:effect target="el-a" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/></comot:effects><comot:comments xmlns:comot="https://co-motion.dev/ns"><comot:comment id="c-1" target="el-a" author="agent" created="2024-01-01T00:00:00.000Z">hi</comot:comment></comot:comments></metadata><g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = delete_elements(&svg, "slides/001.svg", &["el-a".to_string()]).unwrap();
        assert!(!updated.contains("el-a"));
        assert!(!updated.contains("comot:effect "));
        assert!(!updated.contains("comot:comment "));
    }

    #[test]
    fn delete_group_covers_nested_descendant_without_double_error() {
        let svg = slide(
            r#"<g id="group"><g id="child"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let updated = delete_elements(
            &svg,
            "slides/001.svg",
            &["group".to_string(), "child".to_string()],
        )
        .unwrap();
        assert_eq!(updated, slide(""));
    }

    #[test]
    fn delete_missing_id_errors() {
        let svg = slide(r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = delete_elements(&svg, "slides/001.svg", &["el-nope".to_string()]).unwrap_err();
        assert_eq!(err.message(), "找不到元素：el-nope");
    }

    // --- element move / rotate ---

    #[test]
    fn move_applies_dx_dy_independently_per_target() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b" transform="translate(5 5)"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = move_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            10.0,
            20.0,
            false,
        )
        .unwrap();
        // "a" had no existing `transform`, so it is inserted right after
        // the tag name (before `id`); "b" already had one, so it is
        // replaced in place (its position relative to `id` is unchanged).
        assert!(updated.contains(r#"<g transform="translate(10 20)" id="a">"#));
        assert!(updated.contains(r#"<g id="b" transform="translate(15 25)">"#));
    }

    #[test]
    fn move_non_finite_dx_errors() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = move_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            f64::NAN,
            0.0,
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "dx/dy 必須是有限數字");
    }

    #[test]
    fn move_locked_target_without_force_errors_with_force_succeeds() {
        let svg = slide(
            r#"<g id="a" data-comot-lock="true"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let err =
            move_elements(&svg, "slides/001.svg", &["a".to_string()], 1.0, 1.0, false).unwrap_err();
        assert!(err.message().contains("鎖定的版面骨架"));
        let updated =
            move_elements(&svg, "slides/001.svg", &["a".to_string()], 1.0, 1.0, true).unwrap();
        assert!(updated.contains(r#"data-comot-lock="true""#));
        assert!(updated.contains(r#"transform="translate(1 1)""#));
    }

    #[test]
    fn rotate_adds_to_existing_rotation() {
        let svg = slide(
            r#"<g id="a" transform="rotate(10)"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated =
            rotate_elements(&svg, "slides/001.svg", &["a".to_string()], 5.0, false).unwrap();
        assert!(updated.contains(r#"transform="rotate(15)""#));
    }

    // --- element order ---

    #[test]
    fn order_front_moves_last_in_list_to_topmost() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g><g id="c"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = reorder_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            OrderDirection::Front,
            false,
        )
        .unwrap();
        let expected = slide(
            r#"<g id="b"><rect x="0" y="0" width="1" height="1"/></g><g id="c"><rect x="0" y="0" width="1" height="1"/></g><g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        assert_eq!(updated, expected);
    }

    #[test]
    fn order_front_on_a_single_child_is_a_no_op() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let updated = reorder_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            OrderDirection::Front,
            false,
        )
        .unwrap();
        assert_eq!(updated, svg);
    }

    #[test]
    fn order_up_swaps_with_the_next_sibling() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = reorder_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            OrderDirection::Up,
            false,
        )
        .unwrap();
        let expected = slide(
            r#"<g id="b"><rect x="0" y="0" width="1" height="1"/></g><g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        assert_eq!(updated, expected);
    }

    #[test]
    fn order_up_at_the_top_edge_is_a_no_op() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = reorder_elements(
            &svg,
            "slides/001.svg",
            &["b".to_string()],
            OrderDirection::Up,
            false,
        )
        .unwrap();
        assert_eq!(updated, svg);
    }

    // --- element lock / unlock ---

    #[test]
    fn lock_is_idempotent_and_unlock_removes_the_attribute_entirely() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let locked = lock_elements(&svg, "slides/001.svg", &["a".to_string()]).unwrap();
        assert!(locked.contains(r#"data-comot-lock="true""#));
        let locked_again = lock_elements(&locked, "slides/001.svg", &["a".to_string()]).unwrap();
        assert_eq!(locked, locked_again);

        let unlocked = unlock_elements(&locked, "slides/001.svg", &["a".to_string()]).unwrap();
        assert_eq!(unlocked, svg);
        // Unlocking an already-unlocked element is a no-op, not an error.
        let unlocked_again =
            unlock_elements(&unlocked, "slides/001.svg", &["a".to_string()]).unwrap();
        assert_eq!(unlocked_again, svg);
    }

    // Round-1 review (NOOP-300, debt item 3): every fixture above this point
    // is pure ASCII, so a leading-CJK offset bug (UTF-16 code-unit vs. byte
    // offset — the exact class of bug `effects::remove_effects_targeting`
    // had, per this crate's `effects` module tests) would slip through
    // undetected here. Each CJK character is 1 UTF-16 unit but 3 UTF-8
    // bytes, so a `<title>投影片標題文字</title>` prefix (7 CJK chars) shifts
    // every later byte offset by 14 relative to its UTF-16 offset — large
    // enough that a wrong conversion reliably corrupts or panics rather than
    // accidentally landing on the right byte by coincidence.
    fn slide_with_cjk_title(children: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><title>投影片標題文字</title>{children}</svg>"#
        )
    }

    #[test]
    fn insert_after_a_leading_cjk_title_appends_at_the_correct_byte_offset() {
        let svg = slide_with_cjk_title(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let input = InsertElementInput {
            x: Some(1.0),
            y: Some(2.0),
            width: Some(3.0),
            height: Some(4.0),
            ..Default::default()
        };
        let updated = insert_element(
            &svg,
            "slides/001.svg",
            "el-new",
            &input,
            InsertElementKind::Rect,
        )
        .unwrap();
        assert!(updated.ends_with(
            r#"<g id="el-new" transform="translate(1 2)"><rect x="0" y="0" width="3" height="4"/></g></svg>"#
        ));
    }

    #[test]
    fn delete_after_a_leading_cjk_title_removes_the_correct_node() {
        let svg = slide_with_cjk_title(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = delete_elements(&svg, "slides/001.svg", &["a".to_string()]).unwrap();
        assert_eq!(
            updated,
            slide_with_cjk_title(r#"<g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#)
        );
    }

    #[test]
    fn move_after_a_leading_cjk_title_rewrites_the_correct_transform() {
        let svg = slide_with_cjk_title(
            r#"<g id="a" transform="translate(5 5)"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated =
            move_elements(&svg, "slides/001.svg", &["a".to_string()], 1.0, 1.0, false).unwrap();
        assert_eq!(
            updated,
            slide_with_cjk_title(
                r#"<g id="a" transform="translate(6 6)"><rect x="0" y="0" width="1" height="1"/></g>"#
            )
        );
    }

    #[test]
    fn rotate_after_a_leading_cjk_title_rewrites_the_correct_transform() {
        let svg = slide_with_cjk_title(
            r#"<g id="a" transform="rotate(10)"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated =
            rotate_elements(&svg, "slides/001.svg", &["a".to_string()], 5.0, false).unwrap();
        assert_eq!(
            updated,
            slide_with_cjk_title(
                r#"<g id="a" transform="rotate(15)"><rect x="0" y="0" width="1" height="1"/></g>"#
            )
        );
    }

    #[test]
    fn order_after_a_leading_cjk_title_swaps_the_correct_siblings() {
        let svg = slide_with_cjk_title(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = reorder_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            OrderDirection::Front,
            false,
        )
        .unwrap();
        assert_eq!(
            updated,
            slide_with_cjk_title(
                r#"<g id="b"><rect x="0" y="0" width="1" height="1"/></g><g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#
            )
        );
    }

    #[test]
    fn order_up_after_a_leading_cjk_title_swaps_the_correct_siblings() {
        // `Up`/`Down` go through `move_one_step` -> `swap_adjacent_containers`,
        // a different path than `Front`/`Back`'s `move_to_edge` above — the
        // leading CJK `<title>` means byte offsets and UTF-16 offsets
        // diverge, so this exercises `utf16_offset_to_byte_offset` on that
        // path too (both directions, so the same-file mutation of either
        // `Up` or `Down` alone would still be caught).
        let svg = slide_with_cjk_title(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let after_up = reorder_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            OrderDirection::Up,
            false,
        )
        .unwrap();
        assert_eq!(
            after_up,
            slide_with_cjk_title(
                r#"<g id="b"><rect x="0" y="0" width="1" height="1"/></g><g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#
            )
        );

        let after_down = reorder_elements(
            &after_up,
            "slides/001.svg",
            &["a".to_string()],
            OrderDirection::Down,
            false,
        )
        .unwrap();
        assert_eq!(after_down, svg);
    }

    #[test]
    fn validate_id_list_rejects_empty_and_duplicate() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let empty_err = lock_elements(&svg, "slides/001.svg", &[]).unwrap_err();
        assert_eq!(empty_err.message(), "元素清單不可為空");
        let dup_err =
            lock_elements(&svg, "slides/001.svg", &["a".to_string(), "a".to_string()]).unwrap_err();
        assert_eq!(dup_err.message(), "元素清單重複：a");
    }

    // --- element scale (P4) ---

    #[test]
    fn scale_leaf_rect_scales_width_and_height_but_not_the_container_transform() {
        let svg = slide(
            r#"<g id="a" transform="translate(5 5)"><rect x="0" y="0" width="10" height="20"/></g>"#,
        );
        let updated = scale_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            2.0,
            &empty_font_book(),
            false,
        )
        .unwrap();
        assert!(
            updated.contains(r#"transform="translate(5 5)""#),
            "target's own transform must not change: {updated}"
        );
        assert!(updated.contains(r#"<rect x="0" y="0" width="20" height="40"/>"#));
    }

    #[test]
    fn scale_group_multiplies_every_descendant_translate_once_per_level() {
        let svg = slide(
            r#"<g id="grp"><g id="child" transform="translate(10 10)"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let updated = scale_elements(
            &svg,
            "slides/001.svg",
            &["grp".to_string()],
            3.0,
            &empty_font_book(),
            false,
        )
        .unwrap();
        assert!(
            !updated.contains(r#"id="grp" transform"#),
            "the group's own transform must not change: {updated}"
        );
        assert!(updated.contains(r#"transform="translate(30 30)""#));
    }

    #[test]
    fn scale_rejects_a_locked_descendant_even_though_only_the_outer_group_was_named() {
        let svg = slide(
            r#"<g id="grp"><g id="child" data-comot-lock="true"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let err = scale_elements(
            &svg,
            "slides/001.svg",
            &["grp".to_string()],
            2.0,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("鎖定的版面骨架"));
        // Force bypasses it and the child's lock attribute is left untouched.
        let updated = scale_elements(
            &svg,
            "slides/001.svg",
            &["grp".to_string()],
            2.0,
            &empty_font_book(),
            true,
        )
        .unwrap();
        assert!(updated.contains(r#"data-comot-lock="true""#));
    }

    #[test]
    fn scale_non_positive_factor_errors() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = scale_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            0.0,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "factor 必須是大於 0 的數字");
    }

    #[test]
    fn scale_table_container_uniform_factor_scales_its_own_transform() {
        let svg = slide(
            r#"<g id="t" data-comot-type="table" data-comot-cols="1" data-comot-rows="1"><g data-comot-cell="0,0"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let updated = scale_elements(
            &svg,
            "slides/001.svg",
            &["t".to_string()],
            2.0,
            &empty_font_book(),
            false,
        )
        .unwrap();
        // `format_transform` always writes both axes, never collapses an
        // equal (sx, sy) to a single-argument `scale(n)`.
        assert!(updated.contains(r#"transform="scale(2 2)""#), "{updated}");
    }

    #[test]
    fn scale_chart_container_is_an_explicit_failed_naming_noop_281() {
        let svg = slide(r#"<g id="c" data-comot-type="chart"><comot:chart/><svg/></g>"#);
        let err = scale_elements(
            &svg,
            "slides/001.svg",
            &["c".to_string()],
            2.0,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("圖表"));
        assert!(err.message().contains("NOOP-281"));
    }

    #[test]
    fn scale_text_box_rewraps_content_and_scales_font_size_and_width() {
        let svg = slide(&format!(
            r#"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="100"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#
        ));
        let updated = scale_elements(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            2.0,
            &font_book_with_default(),
            false,
        )
        .unwrap();
        assert!(
            updated.contains(&format!(r#"{TEXT_WIDTH_ATTRIBUTE}="200""#)),
            "{updated}"
        );
        assert!(updated.contains(r#"font-size="32""#), "{updated}");
    }

    #[test]
    fn scale_text_box_rejects_a_width_that_rounds_to_zero() {
        let svg = slide(&format!(
            r#"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="0.001"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#
        ));
        let err = scale_elements(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            0.001,
            &font_book_with_default(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "元素 tb 的文字框寬度縮放後不是大於 0 的數字");
    }

    #[test]
    fn scale_text_box_rejects_a_font_size_that_rounds_to_zero() {
        let svg = slide(&format!(
            r#"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="100"><text font-family="Noto Sans TC" font-size="0.001" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#
        ));
        let err = scale_elements(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            0.001,
            &font_book_with_default(),
            false,
        )
        .unwrap_err();
        assert_eq!(
            err.message(),
            "元素 tb 的 font-size 縮放後不是大於 0 的數字"
        );
    }

    #[test]
    fn scale_bare_text_primitive_font_size_scales_as_a_plain_number() {
        let svg = slide(r#"<g id="a"><text font-size="16">hi</text></g>"#);
        let updated = scale_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            1.5,
            &empty_font_book(),
            false,
        )
        .unwrap();
        assert!(updated.contains(r#"font-size="24""#));
    }

    #[test]
    fn scale_path_with_an_elliptical_arc_errors() {
        let svg = slide(r#"<g id="a"><path d="M0 0 A5 5 0 0 1 10 10"/></g>"#);
        let err = scale_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            2.0,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "path 含有橢圓弧，尚不支援縮放");
    }

    #[test]
    fn scale_path_data_rescales_every_numeric_token_including_shorthand_adjacent_decimals() {
        // "1.5.5" is SVG's shorthand for two adjacent decimals "1.5" and
        // ".5" with the repeated point omitted — this is the regex-parity
        // case `scan_number_token` has to get right without a `regex` crate.
        let svg = slide(r#"<g id="a"><path d="M-1.5.5L2e1 3"/></g>"#);
        let updated = scale_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            2.0,
            &empty_font_book(),
            false,
        )
        .unwrap();
        // -1.5*2=-3, .5*2=1, 2e1(=20)*2=40, 3*2=6 — "-3" and "1" concatenate
        // with no separator because the SOURCE had none between "-1.5" and
        // ".5" either (a `String.replace` with a global regex preserves
        // whatever separator — including none — sat between two matches).
        // This is a pre-existing quirk of the TS original's own regex-replace
        // approach, not something this port introduces or needs to fix.
        assert_eq!(updated, slide(r#"<g id="a"><path d="M-31L40 6"/></g>"#));
    }

    // --- element resize (P4) ---

    fn empty_font_book() -> HashMap<String, Box<dyn FontMetrics>> {
        HashMap::new()
    }

    fn font_book_with_default() -> HashMap<String, Box<dyn FontMetrics>> {
        let mut book: HashMap<String, Box<dyn FontMetrics>> = HashMap::new();
        book.insert(
            crate::text::DEFAULT_FONT_FAMILY.to_string(),
            Box::new(crate::text::parse_font(crate::text::DEFAULT_FONT_BYTES).unwrap()),
        );
        book
    }

    #[test]
    fn resize_nw_anchor_keeps_the_top_left_corner_fixed() {
        let svg = slide(
            r#"<g id="a" transform="translate(10 10)"><rect x="0" y="0" width="10" height="10"/></g>"#,
        );
        let updated = resize_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            20.0,
            5.0,
            ResizeAnchor::Nw,
            &empty_font_book(),
            false,
        )
        .unwrap();
        assert!(
            updated.contains(r#"transform="translate(10 10)""#),
            "nw anchor: translate must not move: {updated}"
        );
        assert!(updated.contains(r#"<rect x="0" y="0" width="20" height="5"/>"#));
    }

    #[test]
    fn resize_se_anchor_shifts_translate_to_keep_the_bottom_right_corner_fixed() {
        let svg = slide(
            r#"<g id="a" transform="translate(10 10)"><rect x="0" y="0" width="10" height="10"/></g>"#,
        );
        let updated = resize_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            20.0,
            20.0,
            ResizeAnchor::Se,
            &empty_font_book(),
            false,
        )
        .unwrap();
        // Absolute se corner before: translate(10,10) applied to the local
        // se corner (10,10) = (20,20). After scaling by 2x about the local
        // origin, the resized rect's local se corner is (20,20); mapping
        // that to the SAME absolute point (20,20) needs translate(0,0) — so
        // the (now-identity) transform attribute is dropped entirely, same
        // as `move`/`rotate` dropping an all-default transform elsewhere in
        // this file.
        assert!(!updated.contains("transform"), "{updated}");
        assert!(updated.contains(r#"<rect x="0" y="0" width="20" height="20"/>"#));
    }

    #[test]
    fn resize_width_or_height_not_positive_errors() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = resize_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            0.0,
            10.0,
            ResizeAnchor::Nw,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "width 必須是大於 0 的數字");
        let err = resize_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            10.0,
            -1.0,
            ResizeAnchor::Nw,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "height 必須是大於 0 的數字");
    }

    #[test]
    fn resize_missing_element_is_not_found_message() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = resize_elements(
            &svg,
            "slides/001.svg",
            &["nope".to_string()],
            10.0,
            10.0,
            ResizeAnchor::Nw,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "找不到元素：nope");
    }

    #[test]
    fn resize_non_uniform_on_a_circle_errors_and_points_at_element_scale() {
        let svg = slide(r#"<g id="a"><circle cx="5" cy="5" r="5"/></g>"#);
        let err = resize_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            20.0,
            5.0,
            ResizeAnchor::Nw,
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("<circle>"));
        assert!(err.message().contains("element scale"));
    }

    #[test]
    fn resize_text_box_uniformly_delegates_to_scale() {
        let svg = slide(&format!(
            r##"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="100" data-comot-text-height="25"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"##
        ));
        let updated = resize_elements(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            200.0,
            50.0,
            ResizeAnchor::Nw,
            &font_book_with_default(),
            false,
        )
        .unwrap();
        assert!(
            updated.contains(&format!(r#"{TEXT_WIDTH_ATTRIBUTE}="200""#)),
            "{updated}"
        );
        assert!(updated.contains(r#"font-size="32""#), "{updated}");
    }

    #[test]
    fn resize_text_box_non_uniformly_reports_the_font_size_message() {
        let svg = slide(&format!(
            r##"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="100" data-comot-text-height="25"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"##
        ));
        let err = resize_elements(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            200.0,
            30.0,
            ResizeAnchor::Nw,
            &font_book_with_default(),
            false,
        )
        .unwrap_err();
        assert_eq!(
            err.message(),
            "元素 tb 含 <text>，font-size 無法非等比縮放，請改用 element scale"
        );
    }

    // --- element style set (ADR-0014, P4) ---

    #[test]
    fn style_set_sets_a_whitelisted_attribute_on_every_primitive() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let updated = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "fill",
            "#ff0000",
            &empty_font_book(),
            false,
        )
        .unwrap();
        assert!(updated.contains(r##"<rect fill="#ff0000" x="0" y="0" width="1" height="1"/>"##));
    }

    #[test]
    fn style_set_rejects_forbidden_position_and_size_attributes() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        for attr in ["transform", "x", "y", "width", "height"] {
            let err = set_element_style(
                &svg,
                "slides/001.svg",
                &["a".to_string()],
                attr,
                "1",
                &empty_font_book(),
                false,
            )
            .unwrap_err();
            assert!(
                err.message().contains("move/scale"),
                "attr={attr}: {}",
                err.message()
            );
        }
    }

    #[test]
    fn style_set_rejects_data_comot_prefixed_attributes() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "data-comot-lock",
            "true",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("保留屬性前綴"));
    }

    #[test]
    fn style_set_rejects_an_attribute_outside_the_whitelist() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "rx",
            "5",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "樣式屬性 rx 不在樣式白名單內");
    }

    #[test]
    fn style_set_validates_opacity_font_size_stroke_width_and_text_anchor_ranges() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "opacity",
            "1.5",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "opacity 必須是 0 到 1 之間的數字");
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "font-size",
            "0",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "font-size 必須是大於 0 的數字");
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "stroke-width",
            "-1",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "stroke-width 不可為負數");
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "text-anchor",
            "center",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "text-anchor 必須是 start、middle 或 end");
        // And the boundary values are accepted.
        assert!(
            set_element_style(
                &svg,
                "slides/001.svg",
                &["a".to_string()],
                "opacity",
                "0",
                &empty_font_book(),
                false
            )
            .is_ok()
        );
        assert!(
            set_element_style(
                &svg,
                "slides/001.svg",
                &["a".to_string()],
                "opacity",
                "1",
                &empty_font_book(),
                false
            )
            .is_ok()
        );
    }

    #[test]
    fn style_set_rejects_a_group_target() {
        let svg =
            slide(r#"<g id="grp"><g id="a"><rect x="0" y="0" width="1" height="1"/></g></g>"#);
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["grp".to_string()],
            "fill",
            "red",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "元素 grp 是群組，沒有可套用樣式的圖元");
    }

    #[test]
    fn style_set_rejects_table_and_chart_containers() {
        let table = slide(
            r#"<g id="t" data-comot-type="table" data-comot-cols="1" data-comot-rows="1"><g data-comot-cell="0,0"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let err = set_element_style(
            &table,
            "slides/001.svg",
            &["t".to_string()],
            "fill",
            "red",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("表格"));

        let chart = slide(r#"<g id="c" data-comot-type="chart"><comot:chart/><svg/></g>"#);
        let err = set_element_style(
            &chart,
            "slides/001.svg",
            &["c".to_string()],
            "fill",
            "red",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("圖表"));
    }

    #[test]
    fn style_set_rejects_text_anchor_on_a_text_box_but_allows_fill() {
        let svg = slide(&format!(
            r#"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="100"><text font-size="16">hi</text></g>"#
        ));
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            "text-anchor",
            "middle",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("文字框不支援 text-anchor"));

        // fill has no layout consequence, so it works without needing the
        // font-size/font-family rewrap machinery below.
        let updated = set_element_style(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            "fill",
            "#000",
            &empty_font_book(),
            false,
        )
        .unwrap();
        assert!(updated.contains(r##"fill="#000""##));
    }

    #[test]
    fn style_set_font_size_on_a_text_box_rewraps_and_keeps_the_width() {
        let svg = slide(&format!(
            r#"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="100"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#
        ));
        let updated = set_element_style(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            "font-size",
            "20",
            &font_book_with_default(),
            false,
        )
        .unwrap();
        assert!(updated.contains(r#"font-size="20""#), "{updated}");
        assert!(
            updated.contains(&format!(r#"{TEXT_WIDTH_ATTRIBUTE}="100""#)),
            "width must stay unchanged: {updated}"
        );
        // A plain attribute splice (no rewrap) would never write this —
        // only `rewrap_text_box_content` does, via `set_trailing_attr_splice`.
        assert!(
            updated.contains(crate::slide::format::TEXT_HEIGHT_ATTRIBUTE),
            "must have gone through the rewrap path: {updated}"
        );
    }

    #[test]
    fn style_set_font_family_on_a_text_box_rewraps_with_the_new_family() {
        let svg = slide(&format!(
            r#"<g id="tb" {TEXT_WIDTH_ATTRIBUTE}="100"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#
        ));
        let mut fonts = font_book_with_default();
        fonts.insert(
            "Custom Family".to_string(),
            Box::new(crate::text::parse_font(crate::text::DEFAULT_FONT_BYTES).unwrap()),
        );
        let updated = set_element_style(
            &svg,
            "slides/001.svg",
            &["tb".to_string()],
            "font-family",
            "Custom Family",
            &fonts,
            false,
        )
        .unwrap();
        assert!(
            updated.contains(r#"font-family="Custom Family""#),
            "{updated}"
        );
        assert!(
            updated.contains(&format!(r#"{TEXT_WIDTH_ATTRIBUTE}="100""#)),
            "width must stay unchanged: {updated}"
        );
        // A plain attribute splice (no rewrap) would never write this —
        // only `rewrap_text_box_content` does, via `set_trailing_attr_splice`.
        assert!(
            updated.contains(crate::slide::format::TEXT_HEIGHT_ATTRIBUTE),
            "must have gone through the rewrap path: {updated}"
        );
    }

    #[test]
    fn style_set_respects_lock_and_force() {
        let svg = slide(
            r#"<g id="a" data-comot-lock="true"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let err = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "fill",
            "red",
            &empty_font_book(),
            false,
        )
        .unwrap_err();
        assert!(err.message().contains("鎖定的版面骨架"));
        let updated = set_element_style(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            "fill",
            "red",
            &empty_font_book(),
            true,
        )
        .unwrap();
        assert!(updated.contains(r#"fill="red""#));
    }
}
