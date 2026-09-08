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
use crate::errors::{CoMotionError, CoMotionResult};
use crate::geometry::transform::TransformParts;
use crate::slide::format::assert_slide_compliant;
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::{escape_xml_attr, utf16_offset_to_byte_offset};
use std::collections::HashSet;

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
/// applies under `packages/web`.
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

/// Builds and appends one new element (`co-motion element insert`).
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

/// Deletes every element named in `element_ids` (`co-motion element
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
/// its own container's `transform` (`co-motion element move`).
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
/// independently (`co-motion element rotate`). A target whose existing
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

/// Reorders every target within its own parent container (`co-motion
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

/// Sets `data-comot-lock="true"` on every target's container (`co-motion
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

/// Removes `data-comot-lock` from every target's container (`co-motion
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
    fn validate_id_list_rejects_empty_and_duplicate() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let empty_err = lock_elements(&svg, "slides/001.svg", &[]).unwrap_err();
        assert_eq!(empty_err.message(), "元素清單不可為空");
        let dup_err =
            lock_elements(&svg, "slides/001.svg", &["a".to_string(), "a".to_string()]).unwrap_err();
        assert_eq!(dup_err.message(), "元素清單重複：a");
    }
}
