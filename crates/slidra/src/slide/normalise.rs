//! Normalisation (`slidra convert`), ported from
//! `packages/core/src/slide/normalise.ts` (full file, 234 lines): wraps bare
//! primitives into `<g>` containers, and moves `id`/`data-slidra-name`/
//! `data-slidra-media`/`transform` up onto the container (ADR-0012).
//!
//! Does not re-serialize the document — every byte outside the spans it
//! splices is preserved exactly. Does not hoist a primitive's native
//! coordinates into the container's `transform`.

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::format::{
    CONTAINER_ATTRIBUTES, ComplianceCode, SLIDE_PRIMITIVE_TAGS, check_slide_compliance,
};
use crate::slide::scan::{ScannedAttribute, ScannedNode, attribute_of, scan_document};
use crate::splice::{Splice, apply_splices};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormaliseResult {
    /// The normalised document. Byte-identical to the input when it was
    /// already compliant.
    pub svg: String,
    /// How many new containers were wrapped this run. 0 means nothing changed.
    pub wrapped: usize,
    /// Identifiers minted for primitives that had none.
    pub generated_ids: Vec<String>,
}

/// Problems conversion can repair. Everything else is the author's to fix
/// first.
fn is_repairable(code: ComplianceCode) -> bool {
    matches!(
        code,
        ComplianceCode::BarePrimitive
            | ComplianceCode::MissingId
            | ComplianceCode::PrimitiveTransform
    )
}

/// Normalises one slide. Errors when the slide has a problem conversion
/// refuses to repair, naming the line, so the author fixes the real problem
/// instead of getting a silently mangled file.
pub fn normalise_slide_svg(
    svg: &str,
    generate_id: &mut dyn FnMut() -> String,
) -> SlidraResult<NormaliseResult> {
    let issues = check_slide_compliance(svg);
    if let Some(blocking) = issues.iter().find(|issue| !is_repairable(issue.code)) {
        return Err(SlidraError::invalid(format!(
            "投影片不合規（第 {} 行第 {} 欄）：{}轉換命令不會替你修這一項。",
            blocking.line, blocking.column, blocking.message
        )));
    }
    if issues.is_empty() {
        return Ok(NormaliseResult {
            svg: svg.to_string(),
            wrapped: 0,
            generated_ids: Vec::new(),
        });
    }

    let roots = scan_document(svg)?;
    let svg_root = roots
        .iter()
        .find(|element| element.tag == "svg")
        .expect("compliance check guarantees an <svg> root");

    let mut used_ids: HashSet<String> = HashSet::new();
    collect_ids(&roots, &mut used_ids);
    let mut generated_ids: Vec<String> = Vec::new();
    let mut mint_id = |used_ids: &mut HashSet<String>| -> SlidraResult<String> {
        for _ in 0..8 {
            let id = generate_id();
            if id.is_empty() {
                return Err(SlidraError::invalid("轉換失敗：識別碼產生器回傳空字串"));
            }
            if !used_ids.contains(&id) {
                used_ids.insert(id.clone());
                generated_ids.push(id.clone());
                return Ok(id);
            }
        }
        Err(SlidraError::invalid(
            "轉換失敗：連續 8 次產生的識別碼都與既有元素重複",
        ))
    };

    let mut splices: Vec<Splice> = Vec::new();
    let mut wrapped = 0usize;

    for child in &svg_root.children {
        if SLIDE_PRIMITIVE_TAGS.contains(&child.tag.as_str()) {
            splices.push(wrap_primitive(svg, child, &mut mint_id, &mut used_ids)?);
            wrapped += 1;
            continue;
        }
        if child.tag != "g" {
            continue;
        }

        for container in containers_needing_work(child) {
            if attribute_of(container, "id").is_none() {
                let id = mint_id(&mut used_ids)?;
                let insert_at = container.start + 1 + container.tag.len();
                splices.push(Splice {
                    start: crate::text::runs::utf16_offset_to_byte_offset(svg, insert_at),
                    end: crate::text::runs::utf16_offset_to_byte_offset(svg, insert_at),
                    text: format!(" id=\"{id}\""),
                });
            }
            let primitives: Vec<&ScannedNode> = container
                .children
                .iter()
                .filter(|element| SLIDE_PRIMITIVE_TAGS.contains(&element.tag.as_str()))
                .collect();
            if primitives
                .iter()
                .any(|element| attribute_of(element, "transform").is_some())
            {
                for primitive in primitives {
                    splices.push(wrap_primitive(svg, primitive, &mut mint_id, &mut used_ids)?);
                    wrapped += 1;
                }
            }
        }
    }

    Ok(NormaliseResult {
        svg: apply_splices(svg, &splices),
        wrapped,
        generated_ids,
    })
}

/// Every `<g>` at or below `root`, in document order (`root` included when
/// it is itself a `<g>`).
fn containers_needing_work(root: &ScannedNode) -> Vec<&ScannedNode> {
    let mut containers = Vec::new();
    fn visit<'a>(element: &'a ScannedNode, containers: &mut Vec<&'a ScannedNode>) {
        if element.tag != "g" {
            return;
        }
        containers.push(element);
        for child in &element.children {
            visit(child, containers);
        }
    }
    visit(root, &mut containers);
    containers
}

fn collect_ids(nodes: &[ScannedNode], into: &mut HashSet<String>) {
    for element in nodes {
        if let Some(id) = attribute_of(element, "id") {
            into.insert(id.value.clone());
        }
        collect_ids(&element.children, into);
    }
}

/// Builds the replacement text that wraps one primitive in a container,
/// moving `id`, `data-slidra-name`, `data-slidra-media` and `transform` up
/// onto it. Every other attribute stays on the primitive, in its original
/// order and spacing, byte for byte.
fn wrap_primitive(
    svg: &str,
    element: &ScannedNode,
    mint_id: &mut dyn FnMut(&mut HashSet<String>) -> SlidraResult<String>,
    used_ids: &mut HashSet<String>,
) -> SlidraResult<Splice> {
    use crate::text::runs::utf16_offset_to_byte_offset as b;

    let mut lifted: Vec<(String, String)> = Vec::new();
    // Byte offsets, computed directly — see `start_of_attribute_with_leading_space`.
    let mut byte_removals: Vec<(usize, usize)> = Vec::new();
    for &name in CONTAINER_ATTRIBUTES {
        let Some(attribute) = attribute_of(element, name) else {
            continue;
        };
        lifted.push((name.to_string(), attribute.value.clone()));
        byte_removals.push((
            start_of_attribute_with_leading_space(svg, element, attribute),
            b(svg, attribute.end),
        ));
    }

    let element_start_byte = b(svg, element.start);
    let element_end_byte = b(svg, element.end);
    let mut primitive_text = svg[element_start_byte..element_end_byte].to_string();
    byte_removals.sort_by(|a, b| b.0.cmp(&a.0));
    for (start, end) in byte_removals {
        let rel_start = start - element_start_byte;
        let rel_end = end - element_start_byte;
        primitive_text = format!(
            "{}{}",
            &primitive_text[..rel_start],
            &primitive_text[rel_end..]
        );
    }

    let indent = indent_of_line_containing(svg, element_start_byte);
    let get_lifted = |name: &str| -> Option<String> {
        lifted
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };

    let mut container_attrs: Vec<String> = Vec::new();
    for &name in CONTAINER_ATTRIBUTES {
        if name == "id" {
            let value = match get_lifted("id") {
                Some(v) => v,
                None => mint_id(used_ids)?,
            };
            container_attrs.push(format!("id={}", quote(&value)?));
        } else if let Some(value) = get_lifted(name) {
            container_attrs.push(format!("{name}={}", quote(&value)?));
        }
    }

    let indented_primitive = primitive_text.split('\n').collect::<Vec<_>>().join("\n  ");
    let text = format!(
        "<g {}>\n{indent}  {indented_primitive}\n{indent}</g>",
        container_attrs.join(" ")
    );

    Ok(Splice {
        start: element_start_byte,
        end: element_end_byte,
        text,
    })
}

/// Quotes an attribute value without altering a single character of it.
fn quote(value: &str) -> SlidraResult<String> {
    if !value.contains('"') {
        return Ok(format!("\"{value}\""));
    }
    if !value.contains('\'') {
        return Ok(format!("'{value}'"));
    }
    Err(SlidraError::invalid(format!(
        "無法搬移含有兩種引號的屬性值：{value}"
    )))
}

/// Where an attribute's removal should start, so the space in front of it
/// goes too. Returns a Rust byte offset (already converted from `element`/
/// `attribute`'s native UTF-16 offset space).
fn start_of_attribute_with_leading_space(
    svg: &str,
    element: &ScannedNode,
    attribute: &ScannedAttribute,
) -> usize {
    use crate::text::runs::utf16_offset_to_byte_offset as b;
    let tag_name_end_byte = b(svg, element.start) + 1 + element.tag.len();
    let mut start_byte = b(svg, attribute.start);
    while start_byte > tag_name_end_byte {
        let Some(prev) = svg[..start_byte].chars().next_back() else {
            break;
        };
        if prev == '\t' || prev == '\n' || prev == '\r' || prev == ' ' {
            start_byte -= prev.len_utf8();
        } else {
            break;
        }
    }
    // Convert back: since UTF-16 and byte space agree in lockstep only when
    // walking whitespace one char at a time from a byte position we already
    // hold, we instead return byte offsets throughout and let the caller
    // treat `removals` as byte offsets directly (see `wrap_primitive`).
    start_byte
}

/// The leading whitespace of the line `offset_byte` (a Rust byte offset)
/// sits on, or "" when something else precedes it.
fn indent_of_line_containing(svg: &str, offset_byte: usize) -> String {
    let line_start = svg[..offset_byte].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let prefix = &svg[line_start..offset_byte];
    if prefix.chars().all(|c| c == '\t' || c == ' ') {
        prefix.to_string()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gen_ids(ids: Vec<&'static str>) -> impl FnMut() -> String {
        let mut iter = ids.into_iter();
        move || iter.next().unwrap_or("fallback-id").to_string()
    }

    #[test]
    fn already_compliant_slide_is_byte_identical() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g id=\"a\"><rect width=\"1\" height=\"1\"/></g></svg>";
        let mut gen_fn = gen_ids(vec![]);
        let result = normalise_slide_svg(svg, &mut gen_fn).unwrap();
        assert_eq!(result.svg, svg);
        assert_eq!(result.wrapped, 0);
        assert!(result.generated_ids.is_empty());
    }

    #[test]
    fn wraps_bare_primitive_and_mints_id() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">\n  <rect width=\"1\" height=\"1\"/>\n</svg>";
        let mut gen_fn = gen_ids(vec!["gen_fn-1"]);
        let result = normalise_slide_svg(svg, &mut gen_fn).unwrap();
        assert_eq!(result.wrapped, 1);
        assert_eq!(result.generated_ids, vec!["gen_fn-1".to_string()]);
        assert!(result.svg.contains("<g id=\"gen_fn-1\">"));
        assert!(result.svg.contains("<rect width=\"1\" height=\"1\"/>"));
    }

    #[test]
    fn container_missing_id_gets_one_minted() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g><rect width=\"1\" height=\"1\"/></g></svg>";
        let mut gen_fn = gen_ids(vec!["gen_fn-2"]);
        let result = normalise_slide_svg(svg, &mut gen_fn).unwrap();
        assert!(result.svg.contains("<g id=\"gen_fn-2\">"));
    }

    #[test]
    fn primitive_transform_inside_container_gets_its_own_wrapper() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g id=\"outer\"><rect id=\"r\" transform=\"translate(1 1)\" width=\"1\" height=\"1\"/></g></svg>";
        let mut gen_fn = gen_ids(vec![]);
        let result = normalise_slide_svg(svg, &mut gen_fn).unwrap();
        assert_eq!(result.wrapped, 1);
        assert!(
            result
                .svg
                .contains("<g id=\"r\" transform=\"translate(1 1)\">")
        );
        assert!(!result.svg.contains("<rect id=\"r\" transform"));
    }

    #[test]
    fn blocking_issue_errors_with_line_and_column() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><script>evil()</script></svg>";
        let mut gen_fn = gen_ids(vec![]);
        let err = normalise_slide_svg(svg, &mut gen_fn).unwrap_err();
        assert!(err.message().contains("不合規"));
        assert!(err.message().contains("轉換命令不會替你修這一項"));
    }
}
