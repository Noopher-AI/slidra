//! `element group` / `element ungroup` / `element name set` — the container
//! structure commands (ADR-0012 nested groups), ported from
//! `packages/core/src/element-group.ts` (plan section 1.1, phase P3).
//!
//! This file's small structural helpers (`require_svg_root`,
//! `find_container`, `require_container`, `validate_id_list`,
//! `meaningful_children`, `is_group_container`) are its OWN copies, not
//! shared with `element::edit` — mirroring the TS original's own doc
//! comment ("this module deliberately duplicates the small offset-splicing
//! helpers element-edit.ts already has"). Only the splice primitives named
//! in plan section 7 decision D6 were consolidated into `element::splice`.

use crate::effects::edit::remove_effects_targeting;
use crate::element::splice::{
    Splice, apply_splices, attribute_removal_splice, build_transform_splice,
};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::geometry::transform::{multiply_matrices, parse_transform};
use crate::slide::format::assert_slide_compliant;
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::text::{escape_xml_attr, utf16_offset_to_byte_offset};
use std::collections::HashSet;

fn require_svg_root(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
}

/// Depth-first search for the `<g id="...">` container named `id`, tracking
/// its immediate parent container.
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
    let mut seen = HashSet::with_capacity(element_ids.len());
    for id in element_ids {
        if !seen.insert(id) {
            return Err(CoMotionError::invalid(format!("元素清單重複：{id}")));
        }
    }
    Ok(())
}

const IGNORED_CHILD_TAGS: [&str; 2] = ["title", "desc"];

fn meaningful_children(node: &ScannedNode) -> Vec<&ScannedNode> {
    node.children
        .iter()
        .filter(|child| !IGNORED_CHILD_TAGS.contains(&child.tag.as_str()))
        .collect()
}

/// ADR-0012: a container's children are all `<g>`, or all primitives —
/// never mixed. An unbound table's cells are all `<g data-comot-cell>` too
/// (E2.T14) — explicitly excluded so `ungroup_one` below never mistakes a
/// table for an ordinary group and dissolves it into a pile of id-less
/// cells.
fn is_group_container(node: &ScannedNode) -> bool {
    if attribute_value(node, "data-comot-type").as_deref()
        == Some(crate::slide::format::TABLE_CONTAINER_TYPE)
    {
        return false;
    }
    let children = meaningful_children(node);
    !children.is_empty() && children.iter().all(|child| child.tag == "g")
}

/// `element ungroup` never treats a table as a group (E2.T14) — its cells
/// are not independently selectable members.
fn assert_not_table_container(
    node: &ScannedNode,
    element_id: &str,
    action: &str,
) -> CoMotionResult<()> {
    if attribute_value(node, "data-comot-type").as_deref()
        == Some(crate::slide::format::TABLE_CONTAINER_TYPE)
    {
        return Err(CoMotionError::invalid(format!(
            "元素 {element_id} 是表格，{action}"
        )));
    }
    Ok(())
}

fn collect_data_comot_names(node: &ScannedNode, names: &mut Vec<String>) {
    if let Some(name) = attribute_value(node, "data-comot-name") {
        names.push(name);
    }
    for child in &node.children {
        collect_data_comot_names(child, names);
    }
}

/// Parses a `Group N` name into its number, or `None` for anything else —
/// hand-written rather than `^Group (\d+)$` (plan section 7 decision D4: no
/// `regex` dependency).
fn parse_group_number(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("Group ")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok()
}

/// D1/D9: a freshly created group's default name — the highest existing
/// `Group <n>` name on the slide, plus one, or `Group 1` when none exist.
/// Deliberately never fills a gap left by a dissolved group: reusing a
/// number that already existed once would make undo/redo ambiguous about
/// which "Group 2" is meant.
fn next_group_name(svg_root: &ScannedNode) -> String {
    let mut names = Vec::new();
    collect_data_comot_names(svg_root, &mut names);
    let next = names
        .iter()
        .filter_map(|name| parse_group_number(name))
        .max()
        .map_or(1, |max| max + 1);
    format!("Group {next}")
}

// ---------------------------------------------------------------------------
// element group
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct GroupElementsResult {
    pub svg: String,
    /// Effect items removed because they targeted one of the grouped
    /// members directly (a member's individual animation does not carry
    /// over into the new group).
    pub removed_effects: usize,
}

/// Wraps every target in a brand-new `<g id="new_group_id">`. Targets must
/// share the same immediate parent container (an ancestor/descendant pair
/// never shares a parent, so that case is already rejected here without a
/// separate check). The new group carries no `transform` of its own —
/// children keep their exact transforms — and lands at the position of the
/// topmost (last in document order) target, so z-order among untouched
/// siblings is unaffected.
///
/// Any effect item that directly targets one of `element_ids` is removed —
/// grouping does not carry a member's own animation forward.
pub fn group_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    new_group_id: &str,
) -> CoMotionResult<GroupElementsResult> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    if element_ids.len() < 2 {
        return Err(CoMotionError::invalid("群組至少需要兩個元素"));
    }

    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let found: Vec<(&ScannedNode, &ScannedNode)> = element_ids
        .iter()
        .map(|id| require_container(svg_root, id))
        .collect::<CoMotionResult<_>>()?;

    let parent_start = found[0].1.start;
    if found.iter().any(|(_, parent)| parent.start != parent_start) {
        return Err(CoMotionError::invalid("群組的元素必須在同一層容器內"));
    }

    // Document order among the targets, as they actually appear in `parent`.
    let mut by_document_order = found.clone();
    by_document_order.sort_by_key(|(node, _)| node.start);
    let topmost_start = by_document_order
        .last()
        .expect("non-empty, checked above")
        .0
        .start;
    let group_name = next_group_name(svg_root);

    let mut combined_markup = format!(
        "<g id=\"{new_group_id}\" data-comot-name=\"{}\">",
        escape_xml_attr(&group_name)
    );
    for (node, _parent) in &by_document_order {
        let start = utf16_offset_to_byte_offset(svg_content, node.start);
        let end = utf16_offset_to_byte_offset(svg_content, node.end);
        combined_markup.push_str(&svg_content[start..end]);
    }
    combined_markup.push_str("</g>");

    let mut splices: Vec<Splice> = by_document_order
        .iter()
        .filter(|(node, _)| node.start != topmost_start)
        .map(|(node, _)| Splice {
            start: node.start,
            end: node.end,
            text: String::new(),
        })
        .collect();
    splices.push(Splice {
        start: topmost_start,
        end: by_document_order.last().expect("non-empty").0.end,
        text: combined_markup,
    });

    let grouped = apply_splices(svg_content, &splices);
    let removed_ids: HashSet<String> = element_ids.iter().cloned().collect();
    let (updated, removed_count) = remove_effects_targeting(&grouped, slide_path, &removed_ids)?;
    Ok(GroupElementsResult {
        svg: updated,
        removed_effects: removed_count,
    })
}

// ---------------------------------------------------------------------------
// element ungroup
// ---------------------------------------------------------------------------

struct UngroupOneResult {
    svg: String,
    /// The dissolved group's direct children, in document order.
    element_ids: Vec<String>,
    removed_effects: usize,
}

/// Dissolves one group, splicing its children in at the group's old
/// position (document order preserved) and folding the group's own
/// transform into each child's: `child_matrix' = group_matrix ∘
/// child_matrix`, so the absolute bounds of every child are unchanged. The
/// group's own `data-comot-name`/`data-comot-media` disappear with it.
///
/// Any effect item targeting the group `<g>` itself is removed along with
/// it — the id it pointed at no longer exists once the group is dissolved.
fn ungroup_one(svg_content: &str, slide_path: &str, id: &str) -> CoMotionResult<UngroupOneResult> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let (node, _parent) = require_container(svg_root, id)?;
    assert_not_table_container(node, id, "不能解散群組")?;
    if !is_group_container(node) {
        return Err(CoMotionError::invalid(format!("元素 {id} 不是群組")));
    }
    let group_matrix = parse_transform(attribute_of(node, "transform").map(|a| a.value.as_str()))?;
    let children = meaningful_children(node);

    // Fold the group's matrix into each child's own transform, one splice
    // per child, all relative to the same (pre-splice) document.
    let child_splices: Vec<Splice> = children
        .iter()
        .map(|child| {
            let child_matrix =
                parse_transform(attribute_of(child, "transform").map(|a| a.value.as_str()))?;
            let combined = multiply_matrices(&group_matrix, &child_matrix);
            build_transform_splice(svg_content, child, |_old_parts| {
                crate::geometry::transform::decompose_matrix(&combined)
            })
        })
        .collect::<CoMotionResult<_>>()?;
    let with_folded_transforms = apply_splices(svg_content, &child_splices);

    // The splices above shifted every offset inside the group; re-locate
    // it and its (now-updated) children before building the replacement
    // markup.
    let refreshed_roots = scan_document(&with_folded_transforms)?;
    let refreshed_svg_root = require_svg_root(&refreshed_roots)?;
    let (refreshed_node, _parent) = require_container(refreshed_svg_root, id)?;
    let refreshed_children = meaningful_children(refreshed_node);
    let child_ids: Vec<String> = refreshed_children
        .iter()
        .filter_map(|child| attribute_value(child, "id"))
        .collect();
    let mut children_markup = String::new();
    for child in &refreshed_children {
        let start = utf16_offset_to_byte_offset(&with_folded_transforms, child.start);
        let end = utf16_offset_to_byte_offset(&with_folded_transforms, child.end);
        children_markup.push_str(&with_folded_transforms[start..end]);
    }

    let ungrouped = apply_splices(
        &with_folded_transforms,
        &[Splice {
            start: refreshed_node.start,
            end: refreshed_node.end,
            text: children_markup,
        }],
    );

    let mut removed_ids = HashSet::new();
    removed_ids.insert(id.to_string());
    let (updated, removed_count) = remove_effects_targeting(&ungrouped, slide_path, &removed_ids)?;
    Ok(UngroupOneResult {
        svg: updated,
        element_ids: child_ids,
        removed_effects: removed_count,
    })
}

#[derive(Debug)]
pub struct UngroupElementsResult {
    pub svg: String,
    /// Every dissolved group's direct children, concatenated in processing
    /// order — the GUI reselects these.
    pub element_ids: Vec<String>,
    pub removed_effects: usize,
}

/// Ungroups every target (`comotion element ungroup`). Multiple targets
/// are processed in list order, re-scanning the document fresh before each
/// one.
pub fn ungroup_elements(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
) -> CoMotionResult<UngroupElementsResult> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    let mut current = svg_content.to_string();
    let mut all_child_ids = Vec::new();
    let mut total_removed = 0;
    for id in element_ids {
        let result = ungroup_one(&current, slide_path, id)?;
        current = result.svg;
        all_child_ids.extend(result.element_ids);
        total_removed += result.removed_effects;
    }
    Ok(UngroupElementsResult {
        svg: current,
        element_ids: all_child_ids,
        removed_effects: total_removed,
    })
}

// ---------------------------------------------------------------------------
// element name set
// ---------------------------------------------------------------------------

/// Builds the splice that sets/removes `attr` on `node` — `value == ""`
/// removes the attribute entirely (ADR-0004: no meaningless bytes).
fn name_attr_splice(svg: &str, node: &ScannedNode, attr: &str, value: &str) -> Splice {
    let existing = attribute_of(node, attr);
    if value.is_empty() {
        return match existing {
            Some(existing) => attribute_removal_splice(node.start, svg, existing),
            None => Splice {
                start: node.start,
                end: node.start,
                text: String::new(),
            },
        };
    }
    if let Some(existing) = existing {
        return Splice {
            start: existing.start,
            end: existing.end,
            text: format!("{attr}=\"{}\"", escape_xml_attr(value)),
        };
    }
    let insert_at = node.start + 1 + node.tag.encode_utf16().count();
    Splice {
        start: insert_at,
        end: insert_at,
        text: format!(" {attr}=\"{}\"", escape_xml_attr(value)),
    }
}

/// Sets `data-comot-name` on every target container (`comotion element
/// name set`). An empty string removes the attribute. Names need not be
/// unique.
pub fn set_element_name(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    name: &str,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;
    let mut current = svg_content.to_string();
    for id in element_ids {
        let roots = scan_document(&current)?;
        let svg_root = require_svg_root(&roots)?;
        let (node, _parent) = require_container(svg_root, id)?;
        let splice = name_attr_splice(&current, node, "data-comot-name", name);
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

    // --- element group ---

    #[test]
    fn group_wraps_targets_at_topmost_position_in_document_order() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="mid"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let result = group_elements(
            &svg,
            "slides/001.svg",
            &["b".to_string(), "a".to_string()],
            "el-group1",
        )
        .unwrap();
        let expected = slide(
            r#"<g id="mid"><rect x="0" y="0" width="1" height="1"/></g><g id="el-group1" data-comot-name="Group 1"><g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        assert_eq!(result.svg, expected);
        assert_eq!(result.removed_effects, 0);
    }

    #[test]
    fn group_requires_at_least_two_elements() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = group_elements(&svg, "slides/001.svg", &["a".to_string()], "el-g").unwrap_err();
        assert_eq!(err.message(), "群組至少需要兩個元素");
    }

    #[test]
    fn group_requires_the_same_parent_container() {
        let svg = slide(
            r#"<g id="outer"><g id="a"><rect x="0" y="0" width="1" height="1"/></g></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let err = group_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            "el-g",
        )
        .unwrap_err();
        assert_eq!(err.message(), "群組的元素必須在同一層容器內");
    }

    #[test]
    fn group_name_numbering_never_fills_a_gap() {
        let svg = slide(
            r#"<g id="a" data-comot-name="Group 1"><rect x="0" y="0" width="1" height="1"/></g><g id="b" data-comot-name="Group 5"><rect x="0" y="0" width="1" height="1"/></g><g id="c"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let result = group_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            "el-new",
        )
        .unwrap();
        assert!(result.svg.contains(r#"data-comot-name="Group 6""#));
    }

    #[test]
    fn group_removes_effects_directly_targeting_members() {
        let svg = slide(&format!(
            r#"<metadata><comot:effects xmlns:comot="{}"><comot:effect target="a" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/></comot:effects></metadata><g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
            crate::effects::edit::EFFECTS_NS
        ));
        let result = group_elements(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            "el-g",
        )
        .unwrap();
        assert_eq!(result.removed_effects, 1);
        assert!(!result.svg.contains("comot:effect "));
    }

    // --- element ungroup ---

    #[test]
    fn ungroup_folds_group_matrix_into_each_child_and_reports_child_ids() {
        let svg = slide(
            r#"<g id="grp" data-comot-name="Group 1" transform="translate(100 100)"><g id="a" transform="translate(5 5)"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let result = ungroup_elements(&svg, "slides/001.svg", &["grp".to_string()]).unwrap();
        assert_eq!(result.element_ids, vec!["a".to_string(), "b".to_string()]);
        // "a" already had its own `transform`, so the folded value is
        // replaced in place; "b" had none, so it is inserted right after
        // the tag name (before `id`), like every other such insertion in
        // this crate.
        assert!(
            result
                .svg
                .contains(r#"<g id="a" transform="translate(105 105)">"#)
        );
        assert!(
            result
                .svg
                .contains(r#"<g transform="translate(100 100)" id="b">"#)
        );
        assert!(!result.svg.contains("data-comot-name"));
        assert!(!result.svg.contains("grp"));
    }

    #[test]
    fn ungroup_rejects_a_non_group_container() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err = ungroup_elements(&svg, "slides/001.svg", &["a".to_string()]).unwrap_err();
        assert_eq!(err.message(), "元素 a 不是群組");
    }

    #[test]
    fn ungroup_rejects_a_table_container() {
        let svg = slide(
            r#"<g id="t" data-comot-type="table" data-comot-cols="1" data-comot-rows="1"><g data-comot-cell="0,0"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let err = ungroup_elements(&svg, "slides/001.svg", &["t".to_string()]).unwrap_err();
        assert_eq!(err.message(), "元素 t 是表格，不能解散群組");
    }

    #[test]
    fn ungroup_removes_effect_targeting_the_group_itself() {
        let svg = slide(&format!(
            r#"<metadata><comot:effects xmlns:comot="{}"><comot:effect target="grp" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/></comot:effects></metadata><g id="grp"><g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
            crate::effects::edit::EFFECTS_NS
        ));
        let result = ungroup_elements(&svg, "slides/001.svg", &["grp".to_string()]).unwrap();
        assert_eq!(result.removed_effects, 1);
        assert!(!result.svg.contains("comot:effect "));
    }

    // --- element name set ---

    #[test]
    fn name_set_writes_and_empty_string_removes_the_attribute() {
        let svg = slide(r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let named =
            set_element_name(&svg, "slides/001.svg", &["a".to_string()], "標題文字").unwrap();
        assert!(named.contains(r#"data-comot-name="標題文字""#));
        let cleared = set_element_name(&named, "slides/001.svg", &["a".to_string()], "").unwrap();
        assert_eq!(cleared, svg);
    }

    #[test]
    fn name_set_does_not_require_unique_names_across_targets() {
        let svg = slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let updated = set_element_name(
            &svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            "同名",
        )
        .unwrap();
        assert_eq!(updated.matches(r#"data-comot-name="同名""#).count(), 2);
    }
}
