// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `substituteDynamicText`, ported from
//! `packages/core/src/element-text.ts` lines 1003-1057: replaces
//! `{{ variableName }}` placeholders with the values in `variables`,
//! scanning only the character data of `<text>`/`<tspan>` leaves. A
//! placeholder naming a variable not present in `variables` is left exactly
//! as written. This is a read-time projection (`slide render`'s mutation
//! primitive), never persisted.

use crate::slide::scan::ScannedNode;
use crate::text::runs::utf16_offset_to_byte_offset;
use std::collections::HashMap;

/// Collects the byte ranges of every leaf text-bearing node in the document
/// — a `<text>` or `<tspan>` with no child elements, whose
/// `[content_start, content_end)` span (already converted to byte offsets)
/// is character data, not markup.
fn collect_text_leaf_ranges(svg_content: &str, nodes: &[ScannedNode]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for node in nodes {
        if (node.tag == "text" || node.tag == "tspan")
            && !node.self_closing
            && node.children.is_empty()
        {
            ranges.push((
                utf16_offset_to_byte_offset(svg_content, node.content_start),
                utf16_offset_to_byte_offset(svg_content, node.content_end),
            ));
        } else {
            ranges.extend(collect_text_leaf_ranges(svg_content, &node.children));
        }
    }
    ranges
}

/// Replaces `{{ variableName }}` occurrences within `text` where `name` is a
/// plain word (`[A-Za-z0-9_]+`), optionally padded with whitespace. Hand-
/// written (no regex crate in this workspace's dependency budget) rather
/// than a regex — the pattern is simple enough to scan by hand.
fn substitute_in_leaf(text: &str, variables: &HashMap<String, String>) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' && bytes.get(i + 1) == Some(&b'{') {
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            let name_start = j;
            while j < bytes.len() {
                let c = bytes[j] as char;
                if c.is_ascii_alphanumeric() || c == '_' {
                    j += 1;
                } else {
                    break;
                }
            }
            let name_end = j;
            if name_end > name_start {
                let mut k = name_end;
                while k < bytes.len() && (bytes[k] as char).is_whitespace() {
                    k += 1;
                }
                if bytes.get(k) == Some(&b'}') && bytes.get(k + 1) == Some(&b'}') {
                    let name = &text[name_start..name_end];
                    match variables.get(name) {
                        Some(value) => {
                            out.push_str(value);
                        }
                        None => {
                            out.push_str(&text[i..k + 2]);
                        }
                    }
                    i = k + 2;
                    continue;
                }
            }
        }
        // Not a recognised placeholder: copy one char forward.
        let ch = text[i..].chars().next().expect("i < bytes.len()");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Replaces `{{ variableName }}` placeholders with the values in
/// `variables`, scanning only `<text>`/`<tspan>` leaf character data.
pub fn substitute_dynamic_text(svg_content: &str, variables: &HashMap<String, String>) -> String {
    let roots = crate::slide::scan::scan_document(svg_content).unwrap_or_default();
    let ranges = collect_text_leaf_ranges(svg_content, &roots);
    let mut result = svg_content.to_string();
    for (start, end) in ranges.into_iter().rev() {
        let original = &result[start..end];
        let replaced = substitute_in_leaf(original, variables);
        if replaced != original {
            result = format!("{}{}{}", &result[..start], replaced, &result[end..]);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn substitutes_known_variable() {
        let svg =
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Slide {{ slide_number }}</text></svg>";
        let updated = substitute_dynamic_text(svg, &vars(&[("slide_number", "3")]));
        assert!(updated.contains("<text>Slide 3</text>"));
    }

    #[test]
    fn leaves_unknown_variable_untouched() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{{ mystery }}</text></svg>";
        let updated = substitute_dynamic_text(svg, &vars(&[]));
        assert!(updated.contains("<text>{{ mystery }}</text>"));
    }

    #[test]
    fn never_touches_attribute_values_or_markup() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" data-slidra-name=\"{{ slide_number }}\"><text>ok</text></svg>";
        let updated = substitute_dynamic_text(svg, &vars(&[("slide_number", "9")]));
        assert!(updated.contains("data-slidra-name=\"{{ slide_number }}\""));
    }

    #[test]
    fn substitutes_independently_per_tspan_leaf() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text><tspan>{{ a }}</tspan><tspan>{{ b }}</tspan></text></svg>";
        let updated = substitute_dynamic_text(svg, &vars(&[("a", "1"), ("b", "2")]));
        assert!(updated.contains("<tspan>1</tspan><tspan>2</tspan>"));
    }

    #[test]
    fn no_placeholder_is_a_no_op() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>plain</text></svg>";
        let updated = substitute_dynamic_text(svg, &vars(&[]));
        assert_eq!(updated, svg);
    }
}
