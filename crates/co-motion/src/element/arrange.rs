//! `element align` / `element distribute` (ADR-0012, plan section 3.4).
//! Ported from `packages/core/src/element-arrange.ts`. Both commands only
//! ever touch the translate component of a target's own container
//! `transform` — never rotation/scale — and only for targets that share the
//! same immediate parent container, so there is no cross-layer
//! inverse-matrix math to do here (unlike `element::edit::resize_one_target`).
//!
//! This file's small structural helpers (`require_svg_root`, `find_container`,
//! `require_container`, `validate_id_list`) are its OWN copies, not shared
//! with `element::edit`/`element::group` — mirroring the TS original's own
//! duplication (plan section 1.1: only the four splice primitives named in
//! decision D6 were consolidated).

use crate::element::splice::{apply_splices, build_transform_splice};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::geometry::bbox::{Bbox, ElementBoundsOptions, element_bounds, union_rects};
use crate::slide::format::{SlideElement, assert_slide_compliant, parse_slide};
use crate::slide::scan::{ScannedNode, attribute_value, scan_document};
use crate::text::FontMetrics;
use std::collections::HashMap;

fn require_svg_root(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
}

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

fn validate_id_list(element_ids: &[String]) -> CoMotionResult<()> {
    if element_ids.is_empty() {
        return Err(CoMotionError::invalid("元素清單不可為空"));
    }
    let mut seen = std::collections::HashSet::with_capacity(element_ids.len());
    for id in element_ids {
        if !seen.insert(id) {
            return Err(CoMotionError::invalid(format!("元素清單重複：{id}")));
        }
    }
    Ok(())
}

/// Depth-first search of the parsed slide model for `id`. The TS original's
/// equivalent (`findElementPath`) also threads an ancestor-matrix chain
/// through this search, but `resolveTargets` below always calls
/// `elementBounds` with a hardcoded empty `ancestors: []` regardless (see
/// its own doc comment for why) — that chain is never actually read, so
/// this port does not build it either.
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

struct Target {
    id: String,
    bounds: Bbox,
}

/// Resolves every target's bounding box *within their shared parent's own
/// coordinate system* — i.e. `element_bounds` is called with NO ancestor
/// matrices, so a target's own `matrix` (its local translate/scale/rotate)
/// is the only thing applied. That keeps union/center/delta math, and the
/// resulting local-translate write-back, entirely inside the parent's
/// frame — correct even when the parent itself (or one of its ancestors)
/// carries a `scale`/`rotate` (ADR-0012 groups can nest), since that outer
/// transform never enters the computation at all.
///
/// "Same parent" is TS's `entry.parent !== parent` reference equality —
/// `ScannedNode` has no stable identity in Rust, so this compares
/// `parent.start` (a UTF-16 byte offset unique to one node within one
/// scanned document) instead (plan section 3.4, point 2).
fn resolve_targets(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
) -> CoMotionResult<Vec<Target>> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;

    let mut shared_parent_start: Option<usize> = None;
    for id in element_ids {
        let (_node, parent) = require_container(svg_root, id)?;
        match shared_parent_start {
            None => shared_parent_start = Some(parent.start),
            Some(start) if start != parent.start => {
                return Err(CoMotionError::invalid("對齊的元素必須在同一層容器內"));
            }
            _ => {}
        }
    }

    let model = parse_slide(svg_content, Some(slide_path))?;
    element_ids
        .iter()
        .map(|id| {
            let element = find_element_by_id(&model.elements, id)
                .ok_or_else(|| CoMotionError::invalid(format!("找不到元素：{id}")))?;
            let bounds = element_bounds(
                element,
                &ElementBoundsOptions {
                    ancestors: &[],
                    fonts: Some(fonts),
                },
            )?;
            Ok(Target {
                id: id.clone(),
                bounds,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// element align
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignDirection {
    Left,
    HCenter,
    Right,
    Top,
    VCenter,
    Bottom,
}

fn align_delta(direction: AlignDirection, union: &Bbox, bounds: &Bbox) -> (f64, f64) {
    match direction {
        AlignDirection::Left => (union.x - bounds.x, 0.0),
        AlignDirection::HCenter => (
            union.x + union.width / 2.0 - (bounds.x + bounds.width / 2.0),
            0.0,
        ),
        AlignDirection::Right => (union.x + union.width - (bounds.x + bounds.width), 0.0),
        AlignDirection::Top => (0.0, union.y - bounds.y),
        AlignDirection::VCenter => (
            0.0,
            union.y + union.height / 2.0 - (bounds.y + bounds.height / 2.0),
        ),
        AlignDirection::Bottom => (0.0, union.y + union.height - (bounds.y + bounds.height)),
    }
}

/// Aligns every target against the union of all targets' bounding boxes
/// (`co-motion element align`). Only each container's own translate moves;
/// an unmeasurable target (a bare `<text>` primitive with no font info, or
/// a path with an elliptical arc) makes the whole command fail, propagating
/// that error untouched. No `--force`, no lock check (plan section 4 table F).
pub fn align_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    direction: AlignDirection,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    if element_ids.len() < 2 {
        return Err(CoMotionError::invalid("對齊至少需要兩個元素"));
    }

    let targets = resolve_targets(svg_content, slide_path, element_ids, fonts)?;
    let boxes: Vec<Bbox> = targets.iter().map(|t| t.bounds).collect();
    let union = union_rects(&boxes)?;

    let mut current = svg_content.to_string();
    for target in &targets {
        let (dx, dy) = align_delta(direction, &union, &target.bounds);
        let roots = scan_document(&current)?;
        let svg_root = require_svg_root(&roots)?;
        let (node, _parent) = require_container(svg_root, &target.id)?;
        let splice = build_transform_splice(&current, node, |mut parts| {
            parts.translate_x += dx;
            parts.translate_y += dy;
            Ok(parts)
        })?;
        current = apply_splices(&current, &[splice]);
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// element distribute
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistributeAxis {
    Horizontal,
    Vertical,
}

fn center_of(axis: DistributeAxis, bounds: &Bbox) -> f64 {
    match axis {
        DistributeAxis::Horizontal => bounds.x + bounds.width / 2.0,
        DistributeAxis::Vertical => bounds.y + bounds.height / 2.0,
    }
}

/// Equalizes the spacing between targets' bounding-box CENTERS along `axis`
/// — not the gaps between their edges (決定 3, settled, do not re-litigate).
/// The first and last target by center coordinate stay fixed; every target
/// in between is repositioned to an equally-spaced center. All centers
/// coinciding is legal and produces zero displacement.
pub fn distribute_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    axis: DistributeAxis,
    fonts: &HashMap<String, Box<dyn FontMetrics>>,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    if element_ids.len() < 3 {
        return Err(CoMotionError::invalid("分佈至少需要三個元素"));
    }

    let mut targets = resolve_targets(svg_content, slide_path, element_ids, fonts)?;
    // `sort_by` is a stable sort, matching `Array.prototype.sort`'s
    // stability — targets whose centers tie keep their input order.
    targets.sort_by(|a, b| {
        center_of(axis, &a.bounds)
            .partial_cmp(&center_of(axis, &b.bounds))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let first_center = center_of(axis, &targets[0].bounds);
    let last_center = center_of(axis, &targets[targets.len() - 1].bounds);
    let step = (last_center - first_center) / (targets.len() - 1) as f64;

    let mut current = svg_content.to_string();
    for (index, target) in targets.iter().enumerate() {
        if index == 0 || index == targets.len() - 1 {
            continue; // First and last stay fixed.
        }
        let desired_center = first_center + step * index as f64;
        let delta = desired_center - center_of(axis, &target.bounds);
        let roots = scan_document(&current)?;
        let svg_root = require_svg_root(&roots)?;
        let (node, _parent) = require_container(svg_root, &target.id)?;
        let splice = build_transform_splice(&current, node, |mut parts| {
            match axis {
                DistributeAxis::Horizontal => parts.translate_x += delta,
                DistributeAxis::Vertical => parts.translate_y += delta,
            }
            Ok(parts)
        })?;
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

    fn no_fonts() -> HashMap<String, Box<dyn FontMetrics>> {
        HashMap::new()
    }

    // --- element align ---

    #[test]
    fn align_left_moves_every_target_to_the_union_left_edge() {
        let svg = slide(
            r#"<g id="a" transform="translate(5 0)"><rect x="0" y="0" width="10" height="10"/></g><g id="b" transform="translate(30 0)"><rect x="0" y="0" width="10" height="10"/></g>"#,
        );
        let updated = align_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            AlignDirection::Left,
            &no_fonts(),
        )
        .unwrap();
        // Union left edge is x=5 (from "a", bounds [5,15]; "b"'s bounds are
        // [30,40]). "a" is already there (dx=0, transform text unchanged).
        // "b" moves to x=5: dx = 5-30 = -25, new translateX = 30-25 = 5.
        assert!(
            updated.contains(r#"<g id="a" transform="translate(5 0)">"#),
            "{updated}"
        );
        assert!(
            updated.contains(r#"<g id="b" transform="translate(5 0)">"#),
            "{updated}"
        );
    }

    #[test]
    fn align_hcenter_centers_every_target_on_the_union_horizontal_midpoint() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="10" height="10"/></g><g id="b" transform="translate(40 0)"><rect x="0" y="0" width="10" height="10"/></g>"#,
        );
        let updated = align_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            AlignDirection::HCenter,
            &no_fonts(),
        )
        .unwrap();
        // Union: x in [0, 50], center 25. "a" center 5 -> dx=20. "b" center
        // 45 -> dx=-20 -> new translate x = 40-20 = 20.
        // "a" had no existing `transform`, so the new one is inserted right
        // after the tag name (before `id`) — same insertion point
        // `element::edit::move_elements`'s own tests document.
        assert!(
            updated.contains(r#"<g transform="translate(20 0)" id="a">"#),
            "{updated}"
        );
        assert!(
            updated.contains(r#"<g id="b" transform="translate(20 0)">"#),
            "{updated}"
        );
    }

    #[test]
    fn align_requires_at_least_two_elements() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = align_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string()],
            AlignDirection::Left,
            &no_fonts(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "對齊至少需要兩個元素");
    }

    #[test]
    fn align_rejects_targets_in_different_parent_containers() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="outer"><g id="b"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let err = align_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            AlignDirection::Left,
            &no_fonts(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "對齊的元素必須在同一層容器內");
    }

    #[test]
    fn align_missing_element_is_not_found() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = align_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "nope".to_string()],
            AlignDirection::Left,
            &no_fonts(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "找不到元素：nope");
    }

    // --- element distribute ---

    #[test]
    fn distribute_horizontal_equalizes_center_spacing_keeping_ends_fixed() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="10" height="10"/></g><g id="b" transform="translate(15 0)"><rect x="0" y="0" width="10" height="10"/></g><g id="c" transform="translate(100 0)"><rect x="0" y="0" width="10" height="10"/></g>"#,
        );
        let updated = distribute_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string(), "c".to_string()],
            DistributeAxis::Horizontal,
            &no_fonts(),
        )
        .unwrap();
        // Centers: a=5, b=20, c=105. Sorted already in that order. step =
        // (105-5)/2 = 50. Middle target "b" moves to center 5+50=55, i.e.
        // its box (width 10) needs x=50 -> translate(50 0) (was 15).
        assert!(
            !updated.contains(r#"id="a" transform"#),
            "ends must stay fixed: {updated}"
        );
        assert!(
            updated.contains(r#"<g id="b" transform="translate(50 0)">"#),
            "{updated}"
        );
        assert!(
            updated.contains(r#"<g id="c" transform="translate(100 0)">"#),
            "ends must stay fixed: {updated}"
        );
    }

    #[test]
    fn distribute_requires_at_least_three_elements() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let err = distribute_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            DistributeAxis::Horizontal,
            &no_fonts(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "分佈至少需要三個元素");
    }

    #[test]
    fn distribute_all_centers_coinciding_is_legal_and_moves_nothing() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="10" height="10"/></g><g id="b"><rect x="0" y="0" width="10" height="10"/></g><g id="c"><rect x="0" y="0" width="10" height="10"/></g>"#,
        );
        let updated = distribute_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string(), "c".to_string()],
            DistributeAxis::Horizontal,
            &no_fonts(),
        )
        .unwrap();
        assert_eq!(updated, svg);
    }
}
