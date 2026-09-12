// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! The splice-only reader/writer for `<slidra:effects>`. Ported from
//! `packages/core/src/effects/edit.ts`. Same conventions as
//! `slide/format.rs`: pure `svg_content: &str -> SlidraResult<String>`,
//! `scan_document` + splice, re-scan fresh before every mutation.
//!
//! # Every offset in this file is a UTF-16 offset
//!
//! `ScannedNode`/`ScannedAttribute`'s `start`/`end`/`content_start`/
//! `content_end` are UTF-16 code-unit offsets (`slide::scan`'s module doc),
//! NOT Rust byte offsets. Nothing here may slice `svg_content` with one:
//! every mutation goes through `element::splice::apply_splices` and every
//! read-back through `text::runs::utf16_slice`, the two places allowed to
//! convert.
//!
//! This is not a style rule. Slicing bytes with a UTF-16 offset lands the
//! splice *earlier* than intended by one position per non-BMP-safe
//! character before it, so a slide carrying so much as one line of CJK
//! speaker notes gets its `<slidra:effect>` written into the middle of a
//! neighbouring attribute value — producing an unparseable slide that
//! `validate`, `effect list` and even a whole-page `slide set` all then
//! refuse to touch, leaving `slide delete` + `slide add` as the only way
//! out. `remove_effects_targeting` was fixed for this once; the other four
//! write paths (`add`/`remove`/`move`/`set`) kept their own byte-slicing
//! copy of the primitive until this commit removed it.

use crate::effects::{
    Effect, RawEffectAttributes, allowed_effects, assert_legal_seconds, default_duration_for,
    validate_effect_item,
};
use crate::errors::{SlidraError, SlidraResult};
use crate::slide::format::assert_slide_compliant;
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::escape::escape_xml_attr;

/// Custom namespace the effect list lives in.
pub const EFFECTS_NS: &str = "https://slidra.app/ns/2026";

// The shared primitive, not a private copy: it takes the same UTF-16
// offsets `scan_document` hands out and is the one place that converts them
// to bytes. This file used to define its own `Splice`/`apply_splices` that
// sliced bytes directly — see the module doc for what that cost.
use crate::element::splice::{Splice, apply_splices};

/// One insertion at a UTF-16 offset — the shape almost every mutation here
/// needs, and the shape most likely to be written as a raw slice by mistake.
fn insert_at(offset: usize, text: String) -> Splice {
    Splice {
        start: offset,
        end: offset,
        text,
    }
}

fn require_svg_root(roots: &[ScannedNode]) -> SlidraResult<&ScannedNode> {
    roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("root node of the slide is not <svg>"))
}

/// Depth-first search for *any* element (not just `<g>`) carrying `id` — an
/// effect target can be any primitive, a `<g>`, or a media element.
fn find_element_by_id<'a>(node: &'a ScannedNode, id: &str) -> Option<&'a ScannedNode> {
    if attribute_value(node, "id").as_deref() == Some(id) {
        return Some(node);
    }
    for child in &node.children {
        if let Some(found) = find_element_by_id(child, id) {
            return Some(found);
        }
    }
    None
}

struct LocatedList<'a> {
    metadata: Option<&'a ScannedNode>,
    list: Option<&'a ScannedNode>,
}

fn locate_effects_list(svg_root: &ScannedNode) -> SlidraResult<LocatedList<'_>> {
    let Some(metadata) = svg_root
        .children
        .iter()
        .find(|child| child.tag == "metadata")
    else {
        return Ok(LocatedList {
            metadata: None,
            list: None,
        });
    };
    let lists: Vec<&ScannedNode> = metadata
        .children
        .iter()
        .filter(|child| child.tag == "slidra:effects")
        .collect();
    if lists.len() > 1 {
        return Err(SlidraError::invalid(format!(
            "the metadata of this slide has {} effect list(s), but a slide can only have one effect list, presentation is corrupted.",
            lists.len()
        )));
    }
    Ok(LocatedList {
        metadata: Some(metadata),
        list: lists.first().copied(),
    })
}

fn require_effects_list(svg_root: &ScannedNode) -> SlidraResult<&ScannedNode> {
    let located = locate_effects_list(svg_root)?;
    located
        .list
        .ok_or_else(|| SlidraError::not_found("this slide has no effect list"))
}

fn effect_nodes_of(list: &ScannedNode) -> Vec<&ScannedNode> {
    list.children
        .iter()
        .filter(|child| child.tag == "slidra:effect")
        .collect()
}

fn raw_attributes_of(node: &ScannedNode) -> RawEffectAttributes {
    RawEffectAttributes {
        target: attribute_value(node, "target"),
        family: attribute_value(node, "family"),
        effect: attribute_value(node, "effect"),
        start: attribute_value(node, "start"),
        duration: attribute_value(node, "duration"),
        delay: attribute_value(node, "delay"),
        d: attribute_value(node, "d"),
    }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/// Reads a slide's effect list (`effect list` and every other `effect`
/// command's own lookup). Unlike `apps/web/src/effects.ts`'s
/// `parseEffects`, every `effect` command except `add` requires the list to
/// already exist: there being nothing to list, remove, move, or set is
/// reported as not-found, not a quiet empty result.
///
/// Deliberately does NOT call `assert_slide_compliant` (D1): several e2e
/// fixture decks are structurally non-compliant (bare-primitive slides) yet
/// still have valid effect lists that the player and step-by-step export
/// must be able to read. `add`/`remove`/`move`/`set` below still assert
/// compliance — only the read path skips it.
pub fn read_effect_list(svg_content: &str, _slide_path: &str) -> SlidraResult<Vec<Effect>> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let list = require_effects_list(svg_root)?;
    effect_nodes_of(list)
        .into_iter()
        .enumerate()
        .map(|(index, node)| {
            let raw = raw_attributes_of(node);
            let target_exists = match &raw.target {
                Some(target) if !target.is_empty() => {
                    find_element_by_id(svg_root, target).is_some()
                }
                _ => false,
            };
            validate_effect_item(&raw, index, target_exists)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct AddEffectInput {
    pub family: String,
    pub effect: String,
    /// Defaults to "on-click". Ignored (forced to "with-previous") for every
    /// `element_ids` entry after the first.
    pub start: Option<String>,
    pub duration: Option<f64>,
    pub delay: Option<f64>,
    pub d: Option<String>,
    /// 1-based insertion position; defaults to appending at the end.
    pub index: Option<f64>,
}

fn serialize_effect(item: &EffectAttrs) -> String {
    let mut parts = vec![
        format!("target=\"{}\"", escape_xml_attr(&item.target)),
        format!("family=\"{}\"", item.family),
        format!("effect=\"{}\"", item.effect),
        format!("start=\"{}\"", item.start),
        format!("duration=\"{}\"", format_svg_number(item.duration)),
        format!("delay=\"{}\"", format_svg_number(item.delay)),
    ];
    if let Some(d) = &item.d {
        parts.push(format!("d=\"{}\"", escape_xml_attr(d)));
    }
    format!("<slidra:effect {}/>", parts.join(" "))
}

struct EffectAttrs {
    target: String,
    family: String,
    effect: String,
    start: String,
    duration: f64,
    delay: f64,
    d: Option<String>,
}

fn validate_insert_index(requested: Option<f64>, current_length: usize) -> SlidraResult<usize> {
    let Some(requested) = requested else {
        return Ok(current_length + 1);
    };
    if requested.fract() != 0.0 || requested < 1.0 || requested > (current_length + 1) as f64 {
        return Err(SlidraError::invalid("--index out of range"));
    }
    Ok(requested as usize)
}

fn insert_effect_items(
    svg_content: &str,
    items_markup: &str,
    requested_index: Option<f64>,
) -> SlidraResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let located = locate_effects_list(svg_root)?;

    let Some(list) = located.list else {
        validate_insert_index(requested_index, 0)?;
        return Ok(match located.metadata {
            None => {
                let block = format!(
                    "<metadata><slidra:effects xmlns:slidra=\"{EFFECTS_NS}\">{items_markup}</slidra:effects></metadata>"
                );
                apply_splices(svg_content, &[insert_at(svg_root.content_start, block)])
            }
            Some(metadata) => {
                let block = format!(
                    "<slidra:effects xmlns:slidra=\"{EFFECTS_NS}\">{items_markup}</slidra:effects>"
                );
                apply_splices(svg_content, &[insert_at(metadata.content_start, block)])
            }
        });
    };

    let items = effect_nodes_of(list);
    let index = validate_insert_index(requested_index, items.len())?;
    let offset = if index == items.len() + 1 {
        list.content_end
    } else {
        items[index - 1].start
    };
    Ok(apply_splices(
        svg_content,
        &[insert_at(offset, items_markup.to_string())],
    ))
}

/// Adds one effect item per `element_ids` entry (`effect add`). All ids are
/// confirmed present before any byte is written (all-or-nothing). A single
/// id produces exactly one item; more than one id produces one item per id,
/// the first carrying `input.start` (or "on-click") and every other one
/// forced to "with-previous".
pub fn add_effects(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
    input: &AddEffectInput,
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    if element_ids.is_empty() {
        return Err(SlidraError::invalid("element list must not be empty"));
    }

    let family = &input.family;
    let Some(allowed) = allowed_effects(family) else {
        return Err(SlidraError::invalid(format!(
            "family value \"{family}\" not yet implemented."
        )));
    };
    if !allowed.contains(&input.effect.as_str()) {
        return Err(SlidraError::invalid(format!(
            "effect value \"{}\" not yet implemented.",
            input.effect
        )));
    }
    let start = input
        .start
        .clone()
        .unwrap_or_else(|| "on-click".to_string());
    if !crate::effects::SUPPORTED_STARTS.contains(&start.as_str()) {
        return Err(SlidraError::invalid(format!(
            "start value \"{start}\" not yet implemented."
        )));
    }
    let d_is_blank = input.d.is_none() || matches!(&input.d, Some(s) if s.is_empty());
    if family == "path" && d_is_blank {
        return Err(SlidraError::invalid(
            "family is path, but no d given, cannot add effect.",
        ));
    }
    let duration = input
        .duration
        .unwrap_or_else(|| default_duration_for(family));
    assert_legal_seconds(duration, "add effect", "duration")?;
    let delay = input.delay.unwrap_or(0.0);
    assert_legal_seconds(delay, "add effect", "delay")?;

    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    for id in element_ids {
        if find_element_by_id(svg_root, id).is_none() {
            return Err(SlidraError::not_found(format!("element not found: {id}")));
        }
    }

    let items_markup: String = element_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            serialize_effect(&EffectAttrs {
                target: id.clone(),
                family: family.clone(),
                effect: input.effect.clone(),
                start: if i == 0 {
                    start.clone()
                } else {
                    "with-previous".to_string()
                },
                duration,
                delay,
                d: input.d.clone(),
            })
        })
        .collect();

    insert_effect_items(svg_content, &items_markup, input.index)
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/// Removes the effect items at `indices` (1-based, `effect remove`). Every
/// index is confirmed in range before anything is removed.
pub fn remove_effects(
    svg_content: &str,
    slide_path: &str,
    indices: &[i64],
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    if indices.is_empty() {
        return Err(SlidraError::invalid(
            "must specify at least one effect item to remove",
        ));
    }

    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let list = require_effects_list(svg_root)?;
    let items = effect_nodes_of(list);
    for &index in indices {
        if index < 1 || index as usize > items.len() {
            return Err(SlidraError::invalid(format!(
                "effect item index out of range: {index}"
            )));
        }
    }

    // Largest index first, so removing one never shifts the byte offset of
    // an index not yet processed.
    let mut descending: Vec<i64> = indices.to_vec();
    descending.sort_unstable();
    descending.dedup();
    descending.reverse();

    let mut current = svg_content.to_string();
    for index in descending {
        let fresh_roots = scan_document(&current)?;
        let fresh_svg_root = require_svg_root(&fresh_roots)?;
        let fresh_list = require_effects_list(fresh_svg_root)?;
        let node = effect_nodes_of(fresh_list)[index as usize - 1];
        current = apply_splices(
            &current,
            &[Splice {
                start: node.start,
                end: node.end,
                text: String::new(),
            }],
        );
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

/// Swaps the effect item at `index` (1-based) with its neighbour (`effect
/// move`). A move past either end is a tolerated no-op.
pub fn move_effect(
    svg_content: &str,
    slide_path: &str,
    index: i64,
    direction: &str,
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let list = require_effects_list(svg_root)?;
    let items = effect_nodes_of(list);
    if index < 1 || index as usize > items.len() {
        return Err(SlidraError::invalid(format!(
            "effect item index out of range: {index}"
        )));
    }

    let other_index = if direction == "up" {
        index - 1
    } else {
        index + 1
    };
    if other_index < 1 || other_index as usize > items.len() {
        return Ok(svg_content.to_string());
    }

    let lo = index.min(other_index) as usize - 1;
    let hi = index.max(other_index) as usize - 1;
    let first = items[lo];
    let second = items[hi];
    // Read back through `utf16_slice`, not `svg_content[a..b]` — these are
    // UTF-16 offsets, and byte-slicing them either panics on a char
    // boundary or silently lifts the wrong span.
    let first_text = crate::text::runs::utf16_slice(svg_content, first.start, first.end);
    let second_text = crate::text::runs::utf16_slice(svg_content, second.start, second.end);
    Ok(apply_splices(
        svg_content,
        &[
            Splice {
                start: first.start,
                end: first.end,
                text: second_text,
            },
            Splice {
                start: second.start,
                end: second.end,
                text: first_text,
            },
        ],
    ))
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct SetEffectInput {
    pub effect: Option<String>,
    pub start: Option<String>,
    pub duration: Option<f64>,
    pub delay: Option<f64>,
    pub d: Option<String>,
}

fn attr_splice(node: &ScannedNode, name: &str, value: &str) -> Splice {
    let escaped = escape_xml_attr(value);
    if let Some(existing) = attribute_of(node, name) {
        Splice {
            start: existing.start,
            end: existing.end,
            text: format!("{name}=\"{escaped}\""),
        }
    } else {
        insert_at(
            node.start + 1 + node.tag.len(),
            format!(" {name}=\"{escaped}\""),
        )
    }
}

/// Changes one or more of an effect item's mutable attributes (`effect
/// set`). `family` is never settable here — switching families is a
/// `remove` + `add` — so `effect` may only be reassigned to another name
/// already legal for the item's existing `family`, and `d` may only be set
/// on an item whose family is already `"path"`.
pub fn set_effect(
    svg_content: &str,
    slide_path: &str,
    index: i64,
    input: &SetEffectInput,
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    if input.effect.is_none()
        && input.start.is_none()
        && input.duration.is_none()
        && input.delay.is_none()
        && input.d.is_none()
    {
        return Err(SlidraError::invalid(
            "effect set must specify at least one field to change",
        ));
    }

    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let list = require_effects_list(svg_root)?;
    let items = effect_nodes_of(list);
    if index < 1 || index as usize > items.len() {
        return Err(SlidraError::invalid(format!(
            "effect item index out of range: {index}"
        )));
    }
    let node = items[index as usize - 1];
    let family = attribute_value(node, "family");
    let family = match &family {
        Some(f) if allowed_effects(f).is_some() => f.as_str(),
        _ => {
            return Err(SlidraError::invalid(
                "the family of this effect item is corrupted, cannot modify",
            ));
        }
    };

    if let Some(effect) = &input.effect {
        if !allowed_effects(family)
            .expect("checked above")
            .contains(&effect.as_str())
        {
            return Err(SlidraError::invalid(format!(
                "effect value \"{effect}\" does not belong to family \"{family}\"; family cannot be changed with set, use remove + add instead."
            )));
        }
    }
    if let Some(start) = &input.start {
        if !crate::effects::SUPPORTED_STARTS.contains(&start.as_str()) {
            return Err(SlidraError::invalid(format!(
                "start value \"{start}\" not yet implemented."
            )));
        }
    }
    if input.d.is_some() && family != "path" {
        return Err(SlidraError::invalid(
            "only family=\"path\" effect item can set d",
        ));
    }
    if let Some(duration) = input.duration {
        assert_legal_seconds(duration, "effect set", "duration")?;
    }
    if let Some(delay) = input.delay {
        assert_legal_seconds(delay, "effect set", "delay")?;
    }

    let mut splices = Vec::new();
    if let Some(effect) = &input.effect {
        splices.push(attr_splice(node, "effect", effect));
    }
    if let Some(start) = &input.start {
        splices.push(attr_splice(node, "start", start));
    }
    if let Some(duration) = input.duration {
        splices.push(attr_splice(node, "duration", &format_svg_number(duration)));
    }
    if let Some(delay) = input.delay {
        splices.push(attr_splice(node, "delay", &format_svg_number(delay)));
    }
    if let Some(d) = &input.d {
        splices.push(attr_splice(node, "d", d));
    }

    Ok(apply_splices(svg_content, &splices))
}

/// `removeEffectsTargeting`, the "dangling-target cleanup" `element/group.rs`
/// (grouping clears each new member's own effects; ungrouping clears the
/// dissolved group's own effect) and `element/edit.rs` (`element delete`
/// clears effects targeting the deleted subtree) both need (plan
/// section 3.1/3.2's "overlap with the same wave" table) — not called by
/// anything in this file's own `effect *` command family.
///
/// Removes every effect item whose `target` is in `target_ids`. A slide with
/// no effect list at all is a legal no-op (returns the content unchanged,
/// `removed_count: 0`) rather than an error — group/ungroup/delete on a
/// slide with no animations anywhere is the common case, not an error.
///
/// Returns `(updated_svg, removed_count)`, mirroring
/// `removeEffectsTargeting`'s `{ updated, removedCount }`.
///
/// Node spans here (`ScannedNode::start`/`.end`) are UTF-16 offsets, not
/// byte offsets (`slide::scan`'s module doc) — removal goes through
/// `element::splice::apply_splices` (aliased below to avoid colliding with
/// this file's own, unrelated private `Splice`/`apply_splices`), the one
/// place allowed to convert between the two, rather than slicing
/// `svg_content` directly: a `<slidra:effect>` sitting after CJK text
/// elsewhere on the slide must still be removed at the right bytes.
pub fn remove_effects_targeting(
    svg_content: &str,
    slide_path: &str,
    target_ids: &std::collections::HashSet<String>,
) -> SlidraResult<(String, usize)> {
    use crate::element::splice::{Splice as ElementSplice, apply_splices as apply_element_splices};

    assert_slide_compliant(svg_content, slide_path)?;
    if target_ids.is_empty() {
        return Ok((svg_content.to_string(), 0));
    }

    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let located = locate_effects_list(svg_root)?;
    let Some(list) = located.list else {
        return Ok((svg_content.to_string(), 0));
    };

    let removal_splices: Vec<ElementSplice> = list
        .children
        .iter()
        .filter(|node| node.tag == "slidra:effect")
        .filter_map(|node| {
            let target = attribute_value(node, "target")?;
            target_ids.contains(&target).then_some(ElementSplice {
                start: node.start,
                end: node.end,
                text: String::new(),
            })
        })
        .collect();
    let removed_count = removal_splices.len();
    Ok((
        apply_element_splices(svg_content, &removal_splices),
        removed_count,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const COMPLIANT: &str =
        r#"<svg viewBox="0 0 100 100"><g id="el1"><rect width="1" height="1"/></g></svg>"#;

    fn with_effects(list_markup: &str) -> String {
        format!(
            r#"<svg viewBox="0 0 100 100"><metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026">{list_markup}</slidra:effects></metadata><g id="el1"><rect width="1" height="1"/></g></svg>"#
        )
    }

    #[test]
    fn read_effect_list_no_list_is_not_found() {
        let err = read_effect_list(COMPLIANT, "slides/001.svg").unwrap_err();
        assert_eq!(err.message(), "this slide has no effect list");
        assert!(matches!(err, SlidraError::NotFound(_)));
    }

    #[test]
    fn read_effect_list_empty_list_is_empty() {
        let svg = with_effects("");
        let effects = read_effect_list(&svg, "slides/001.svg").unwrap();
        assert_eq!(effects, Vec::new());
    }

    #[test]
    fn read_effect_list_outside_metadata_is_not_adopted() {
        let svg = r#"<svg viewBox="0 0 100 100"><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"><slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/></slidra:effects><g id="el1"><rect width="1" height="1"/></g></svg>"#;
        let err = read_effect_list(svg, "slides/001.svg").unwrap_err();
        assert_eq!(err.message(), "this slide has no effect list");
    }

    #[test]
    fn read_effect_list_two_lists_is_damaged() {
        let svg = r#"<svg viewBox="0 0 100 100"><metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"></slidra:effects><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"></slidra:effects></metadata></svg>"#;
        let err = read_effect_list(svg, "slides/001.svg").unwrap_err();
        assert!(err.message().contains("has 2 effect list(s)"));
    }

    #[test]
    fn read_effect_list_does_not_require_slide_compliance() {
        // Bare primitive at the svg root — not wrapped in a <g> — is
        // non-compliant, but effect list must still succeed (D1).
        let svg = r#"<svg viewBox="0 0 100 100"><metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"><slidra:effect target="r1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/></slidra:effects></metadata><rect id="r1" width="1" height="1"/></svg>"#;
        let effects = read_effect_list(svg, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].index, 0);
    }

    #[test]
    fn add_effects_single_id_appends_on_click_by_default() {
        let updated = add_effects(
            COMPLIANT,
            "slides/001.svg",
            &["el1".to_string()],
            &AddEffectInput {
                family: "enter".to_string(),
                effect: "fade".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].start, "on-click");
        assert_eq!(effects[0].duration, 0.6);
    }

    #[test]
    fn add_effects_multiple_ids_forces_with_previous_after_first() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="a"><rect width="1" height="1"/></g><g id="b"><rect width="1" height="1"/></g></svg>"#;
        let updated = add_effects(
            svg,
            "slides/001.svg",
            &["a".to_string(), "b".to_string()],
            &AddEffectInput {
                family: "enter".to_string(),
                effect: "fade".to_string(),
                start: Some("on-click".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects[0].start, "on-click");
        assert_eq!(effects[1].start, "with-previous");
    }

    #[test]
    fn add_effects_all_or_nothing_on_missing_id() {
        let err = add_effects(
            COMPLIANT,
            "slides/001.svg",
            &["el1".to_string(), "nope".to_string()],
            &AddEffectInput {
                family: "enter".to_string(),
                effect: "fade".to_string(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.message(), "element not found: nope");
    }

    #[test]
    fn add_effects_index_out_of_range_is_rejected() {
        let err = add_effects(
            COMPLIANT,
            "slides/001.svg",
            &["el1".to_string()],
            &AddEffectInput {
                family: "enter".to_string(),
                effect: "fade".to_string(),
                index: Some(5.0),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.message(), "--index out of range");
    }

    #[test]
    fn remove_effects_dedups_and_removes_descending() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/><slidra:effect target="el1" family="enter" effect="appear" start="with-previous" duration="0.6" delay="0"/>"#,
        );
        let updated = remove_effects(&svg, "slides/001.svg", &[2, 2]).unwrap();
        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].effect, "fade");
    }

    #[test]
    fn remove_effects_out_of_range_is_rejected() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#,
        );
        let err = remove_effects(&svg, "slides/001.svg", &[2]).unwrap_err();
        assert_eq!(err.message(), "effect item index out of range: 2");
    }

    #[test]
    fn move_effect_boundary_is_legal_no_op() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#,
        );
        let updated = move_effect(&svg, "slides/001.svg", 1, "up").unwrap();
        assert_eq!(updated, svg);
    }

    #[test]
    fn move_effect_swaps_neighbours() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/><slidra:effect target="el1" family="enter" effect="appear" start="with-previous" duration="0.6" delay="0"/>"#,
        );
        let updated = move_effect(&svg, "slides/001.svg", 2, "up").unwrap();
        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects[0].effect, "appear");
        assert_eq!(effects[1].effect, "fade");
    }

    #[test]
    fn set_effect_no_fields_given_is_rejected() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#,
        );
        let err = set_effect(&svg, "slides/001.svg", 1, &SetEffectInput::default()).unwrap_err();
        assert_eq!(
            err.message(),
            "effect set must specify at least one field to change"
        );
    }

    #[test]
    fn set_effect_changes_effect_within_same_family() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#,
        );
        let updated = set_effect(
            &svg,
            "slides/001.svg",
            1,
            &SetEffectInput {
                effect: Some("appear".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects[0].effect, "appear");
    }

    #[test]
    fn set_effect_family_change_is_rejected() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#,
        );
        let err = set_effect(
            &svg,
            "slides/001.svg",
            1,
            &SetEffectInput {
                effect: Some("pulse".to_string()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.message().contains("family cannot be changed with set"));
    }

    #[test]
    fn set_effect_d_on_non_path_family_is_rejected() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#,
        );
        let err = set_effect(
            &svg,
            "slides/001.svg",
            1,
            &SetEffectInput {
                d: Some("M0 0".to_string()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.message(), "only family=\"path\" effect item can set d");
    }

    #[test]
    fn remove_effects_targeting_no_metadata_at_all_is_a_no_op() {
        let mut targets = HashSet::new();
        targets.insert("el1".to_string());
        let (updated, removed) =
            remove_effects_targeting(COMPLIANT, "slides/001.svg", &targets).unwrap();
        assert_eq!(updated, COMPLIANT);
        assert_eq!(removed, 0);
    }

    #[test]
    fn remove_effects_targeting_empty_target_set_is_a_no_op_even_with_a_matching_effect() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/>"#,
        );
        let (updated, removed) =
            remove_effects_targeting(&svg, "slides/001.svg", &HashSet::new()).unwrap();
        assert_eq!(updated, svg);
        assert_eq!(removed, 0);
    }

    #[test]
    fn remove_effects_targeting_removes_only_the_matching_target() {
        let svg = with_effects(
            r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/><slidra:effect target="el2" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/>"#,
        );
        let mut targets = HashSet::new();
        targets.insert("el1".to_string());
        let (updated, removed) =
            remove_effects_targeting(&svg, "slides/001.svg", &targets).unwrap();
        assert_eq!(removed, 1);
        assert!(!updated.contains(r#"target="el1""#));
        assert!(updated.contains(r#"target="el2""#));
    }

    /// The load-bearing regression this crate's UTF-16-vs-byte-offset
    /// contract exists for: a `<slidra:effect>` sitting after CJK text
    /// elsewhere in the document must still be removed at the right bytes.
    /// Each CJK character is 1 UTF-16 unit but 3 UTF-8 bytes, so treating
    /// `node.start`/`.end` as byte offsets would remove the wrong span here.
    #[test]
    fn remove_effects_targeting_removes_the_right_span_when_cjk_text_precedes_the_list() {
        let svg = r#"<svg viewBox="0 0 100 100"><title>slide title text</title><metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"><slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/></slidra:effects></metadata><g id="el1"><rect width="1" height="1"/></g></svg>"#;
        let mut targets = HashSet::new();
        targets.insert("el1".to_string());
        let (updated, removed) = remove_effects_targeting(svg, "slides/001.svg", &targets).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(
            updated,
            r#"<svg viewBox="0 0 100 100"><title>slide title text</title><metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"></slidra:effects></metadata><g id="el1"><rect width="1" height="1"/></g></svg>"#
        );
    }

    // The same regression, for the four write paths that kept slicing bytes
    // with a UTF-16 offset until this commit. One CJK character is 1 UTF-16
    // unit but 3 UTF-8 bytes, so every one of these landed its splice short
    // of the intended position — in practice, inside a neighbouring
    // attribute value, producing a slide nothing could parse afterwards.
    //
    // Each case re-parses its own output: an assertion on the exact string
    // would pass just as well if the splice were merely *differently*
    // wrong, but a document that scans back to the effects we asked for
    // cannot be corrupt.

    /// A slide carrying CJK speaker notes — the shape that made this bug
    /// reachable from ordinary use, since every Chinese deck has them.
    fn with_cjk_notes(items: &str) -> String {
        format!(
            r#"<svg viewBox="0 0 100 100"><metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">This is a Chinese speaker-notes snippet, used to push the effect list further back.</slidra:notes><slidra:effects xmlns:slidra="https://slidra.app/ns/2026">{items}</slidra:effects></metadata><g id="el1"><rect width="1" height="1"/></g><g id="el2"><rect width="1" height="1"/></g></svg>"#
        )
    }

    const ITEM_EL1: &str = r#"<slidra:effect target="el1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#;
    const ITEM_EL2: &str = r#"<slidra:effect target="el2" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>"#;

    #[test]
    fn add_effects_lands_in_the_right_place_when_cjk_notes_precede_the_list() {
        let svg = with_cjk_notes(ITEM_EL1);
        let updated = add_effects(
            &svg,
            "slides/001.svg",
            &["el2".to_string()],
            &AddEffectInput {
                family: "enter".to_string(),
                effect: "fade".to_string(),
                ..Default::default()
            },
        )
        .unwrap();

        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[0].target, "el1");
        assert_eq!(effects[1].target, "el2");
    }

    #[test]
    fn remove_effects_removes_the_right_item_when_cjk_notes_precede_the_list() {
        let svg = with_cjk_notes(&format!("{ITEM_EL1}{ITEM_EL2}"));
        let updated = remove_effects(&svg, "slides/001.svg", &[1]).unwrap();

        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].target, "el2");
    }

    #[test]
    fn move_effect_swaps_the_right_spans_when_cjk_notes_precede_the_list() {
        let svg = with_cjk_notes(&format!("{ITEM_EL1}{ITEM_EL2}"));
        let updated = move_effect(&svg, "slides/001.svg", 1, "down").unwrap();

        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[0].target, "el2");
        assert_eq!(effects[1].target, "el1");
    }

    #[test]
    fn set_effect_edits_the_right_attribute_when_cjk_notes_precede_the_list() {
        let svg = with_cjk_notes(ITEM_EL1);
        let updated = set_effect(
            &svg,
            "slides/001.svg",
            1,
            &SetEffectInput {
                duration: Some(1.25),
                ..Default::default()
            },
        )
        .unwrap();

        let effects = read_effect_list(&updated, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].duration, 1.25);
    }

    /// The exact corruption seen in the wild (a real session's
    /// `slides/001.svg`): the second `effect add` on a slide that had
    /// gained CJK notes since the first one spliced itself into the middle
    /// of `xmlns:slidra="https://slidra.app/ns/2026"`, splitting it into
    /// `…slidra.d` + `ev/ns` and leaving a document no command could
    /// parse again.
    #[test]
    fn add_effects_twice_around_a_notes_edit_never_writes_into_an_attribute_value() {
        const TWO_ELEMENTS: &str = r#"<svg viewBox="0 0 100 100"><g id="el1"><rect width="1" height="1"/></g><g id="el2"><rect width="1" height="1"/></g></svg>"#;
        let first = add_effects(
            TWO_ELEMENTS,
            "slides/001.svg",
            &["el1".to_string()],
            &AddEffectInput {
                family: "enter".to_string(),
                effect: "fade".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let with_notes = crate::slide::notes::set_slide_notes(
            &first,
            "from this point on, this island entered global view.",
        )
        .unwrap();
        let second = add_effects(
            &with_notes,
            "slides/001.svg",
            &["el2".to_string()],
            &AddEffectInput {
                family: "enter".to_string(),
                effect: "fade".to_string(),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(
            second.contains(&format!("xmlns:slidra=\"{EFFECTS_NS}\"")),
            "the namespace attribute must survive intact: {second}"
        );
        let effects = read_effect_list(&second, "slides/001.svg").unwrap();
        assert_eq!(effects.len(), 2);
    }

    #[test]
    fn remove_effects_targeting_duplicate_effects_list_is_a_loud_error() {
        let svg = r#"<svg viewBox="0 0 100 100"><metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"></slidra:effects><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"></slidra:effects></metadata><g id="el1"><rect width="1" height="1"/></g></svg>"#;
        let mut targets = HashSet::new();
        targets.insert("el1".to_string());
        let err = remove_effects_targeting(svg, "slides/001.svg", &targets).unwrap_err();
        assert!(err.message().contains("2 effect list(s)"));
    }
}
