//! `element copy` / `element cut` / `element paste` / `element duplicate`
//! (plan section 1.1, phase P7) — this ticket's
//! technically riskiest phase (plan section 0): a from-scratch allowlist
//! sanitizer over pasted markup (ADR-0010), a system-clipboard exchange SVG
//! format, and a WHATWG-`URL`-shaped defense-in-depth check ported without
//! a `URL` implementation to delegate to (plan decision D4: no `regex`, no
//! new crate at all).
//!
//! Small offset-splicing helpers below duplicate `element::edit`'s /
//! `element::group`'s on purpose, matching the TS original's own
//! per-file duplication (only the four primitives named in plan section 7
//! decision D6 — `apply_splices`/`attribute_removal_splice`/
//! `build_transform_splice`/`set_attr_splice`, all reused directly from
//! `element::splice` here — were actually consolidated).

use crate::element::splice::{Splice, apply_splices, build_transform_splice};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::geometry::transform::{
    Matrix, TransformParts, compose_matrices, multiply_matrices, parse_transform,
};
use crate::slide::format::assert_slide_compliant;
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::text::runs::utf16_slice;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

// ---------------------------------------------------------------------------
// shared small helpers (own copies — see module doc comment on duplication)
// ---------------------------------------------------------------------------

fn require_svg_root(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
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

/// Depth-first search for container `id`, tracking the chain of ancestor
/// `<g>` matrices from the root down to (excluding) the found node itself.
/// Returns `Err` the moment an ANCESTOR's own `transform` fails to parse —
/// matches the TS original's un-caught `parseTransform` call inside the
/// same walk (a malformed transform anywhere on the path to a target is a
/// real error, not a reason to skip that branch).
fn find_container_with_ancestors<'a>(
    parent: &'a ScannedNode,
    id: &str,
    ancestors: &mut Vec<Matrix>,
) -> CoMotionResult<Option<&'a ScannedNode>> {
    for child in &parent.children {
        if child.tag != "g" {
            continue;
        }
        if attribute_value(child, "id").as_deref() == Some(id) {
            return Ok(Some(child));
        }
        let child_matrix = parse_transform(attribute_value(child, "transform").as_deref())?;
        ancestors.push(child_matrix);
        let found = find_container_with_ancestors(child, id, ancestors)?;
        if found.is_some() {
            return Ok(found);
        }
        ancestors.pop();
    }
    Ok(None)
}

fn require_container_with_ancestors<'a>(
    svg_root: &'a ScannedNode,
    id: &str,
) -> CoMotionResult<(&'a ScannedNode, Vec<Matrix>)> {
    let mut ancestors = Vec::new();
    let node = find_container_with_ancestors(svg_root, id, &mut ancestors)?
        .ok_or_else(|| CoMotionError::invalid(format!("找不到元素：{id}")))?;
    Ok((node, ancestors))
}

/// Every container id in `node`'s subtree, itself included — used to find
/// every effect referencing the copied target or a descendant of it.
fn collect_container_ids(node: &ScannedNode, into: &mut HashSet<String>) {
    if let Some(id) = attribute_value(node, "id") {
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

/// Applies `build_transform_splice`-style mutation to a STANDALONE markup
/// fragment's own top-level node (its own coordinate system, not the whole
/// document it was cut from).
fn rewrite_fragment_transform(
    markup: &str,
    mutate: impl FnOnce(TransformParts) -> CoMotionResult<TransformParts>,
) -> CoMotionResult<String> {
    let roots = scan_document(markup)?;
    let root = roots
        .first()
        .ok_or_else(|| CoMotionError::invalid("剪貼簿片段是空的"))?;
    let splice = build_transform_splice(markup, root, mutate)?;
    Ok(apply_splices(markup, &[splice]))
}

fn splice_insert(svg: &str, utf16_offset: usize, text: &str) -> String {
    let byte_offset = crate::text::utf16_offset_to_byte_offset(svg, utf16_offset);
    format!("{}{}{}", &svg[..byte_offset], text, &svg[byte_offset..])
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

/// Extracts a copyable snapshot of every target (`comotion element copy`).
/// Does not mutate `svg_content`. Each target's ancestor-chain matrix (if it
/// sits inside a group) is folded into its own `transform`, so pasting it
/// back at the root level of any slide preserves its visual position. Every
/// `<comot:effect>` whose `target` names the copied element or any of its
/// descendants is captured verbatim, in document order.
pub fn extract_elements_for_copy(
    svg_content: &str,
    slide_path: &str,
    element_ids: &[String],
) -> CoMotionResult<ClipboardPayload> {
    assert_slide_compliant(svg_content, slide_path)?;
    validate_id_list(element_ids)?;

    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;

    let mut copied_ids: HashSet<String> = HashSet::new();
    let mut elements = Vec::with_capacity(element_ids.len());
    for id in element_ids {
        let (node, ancestors) = require_container_with_ancestors(svg_root, id)?;
        collect_container_ids(node, &mut copied_ids);
        let own_matrix = parse_transform(attribute_value(node, "transform").as_deref())?;
        let folded_matrix = multiply_matrices(&compose_matrices(&ancestors), &own_matrix);
        let node_text = utf16_slice(svg_content, node.start, node.end);
        let rebased = rewrite_fragment_transform(&node_text, |_parts| {
            crate::geometry::transform::decompose_matrix(&folded_matrix)
        })?;
        elements.push(rebased);
    }

    let mut effects = Vec::new();
    if let Some(metadata) = svg_root.children.iter().find(|c| c.tag == "metadata") {
        if let Some(effects_list) = metadata.children.iter().find(|c| c.tag == "comot:effects") {
            for effect in &effects_list.children {
                if effect.tag != "comot:effect" {
                    continue;
                }
                if let Some(target) = attribute_value(effect, "target") {
                    if copied_ids.contains(&target) {
                        effects.push(utf16_slice(svg_content, effect.start, effect.end));
                    }
                }
            }
        }
    }

    let view_box = attribute_value(svg_root, "viewBox");

    Ok(ClipboardPayload {
        source_slide_path: slide_path.to_string(),
        elements,
        effects,
        view_box,
    })
}

// ---------------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------------

/// Regenerates every container id inside a standalone markup fragment (its
/// own top-level id included), consistently, via `generate_id()`.
fn regenerate_ids(
    markup: &str,
    generate_id: &mut impl FnMut() -> String,
) -> CoMotionResult<(String, HashMap<String, String>)> {
    let roots = scan_document(markup)?;
    let root = roots
        .first()
        .ok_or_else(|| CoMotionError::invalid("剪貼簿片段是空的"))?;
    let mut id_map = HashMap::new();

    fn collect(
        node: &ScannedNode,
        id_map: &mut HashMap<String, String>,
        generate_id: &mut impl FnMut() -> String,
    ) {
        if let Some(id_attr) = attribute_of(node, "id") {
            id_map.insert(id_attr.value.clone(), generate_id());
        }
        for child in &node.children {
            if child.tag == "g" {
                collect(child, id_map, generate_id);
            }
        }
    }
    collect(root, &mut id_map, generate_id);

    fn walk(node: &ScannedNode, id_map: &HashMap<String, String>, splices: &mut Vec<Splice>) {
        if let Some(id_attr) = attribute_of(node, "id") {
            splices.push(Splice {
                start: id_attr.start,
                end: id_attr.end,
                text: format!("id=\"{}\"", id_map[&id_attr.value]),
            });
        }
        for child in &node.children {
            if child.tag == "g" {
                walk(child, id_map, splices);
            }
        }
    }
    let mut splices = Vec::new();
    walk(root, &id_map, &mut splices);

    Ok((apply_splices(markup, &splices), id_map))
}

fn rewrite_effect_target(
    effect_markup: &str,
    id_map: &HashMap<String, String>,
) -> CoMotionResult<String> {
    let roots = scan_document(effect_markup)?;
    let node = roots
        .first()
        .ok_or_else(|| CoMotionError::invalid("剪貼簿片段是空的"))?;
    let attr = attribute_of(node, "target")
        .ok_or_else(|| CoMotionError::invalid("剪貼簿資料損毀：effect 缺少 target 屬性"))?;
    let new_id = id_map.get(&attr.value).ok_or_else(|| {
        CoMotionError::invalid(format!(
            "剪貼簿資料不一致：effect 的 target 找不到對應的新元素（{}）",
            attr.value
        ))
    })?;
    Ok(apply_splices(
        effect_markup,
        &[Splice {
            start: attr.start,
            end: attr.end,
            text: format!("target=\"{new_id}\""),
        }],
    ))
}

/// Appends `markup` as the last child of `<svg>`.
fn append_markup(svg_content: &str, markup: &str) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    Ok(splice_insert(svg_content, svg_root.content_end, markup))
}

/// Inserts `effect_markups`, joined, at the end of the target slide's effect
/// list — creating `<metadata><comot:effects>` if the slide has none yet.
fn append_effects(svg_content: &str, effect_markups: &[String]) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let joined = effect_markups.concat();

    if let Some(metadata) = svg_root.children.iter().find(|c| c.tag == "metadata") {
        if let Some(effects_list) = metadata.children.iter().find(|c| c.tag == "comot:effects") {
            return Ok(splice_insert(
                svg_content,
                effects_list.content_end,
                &joined,
            ));
        }
        let block = format!("<comot:effects xmlns:comot=\"{EFFECTS_NS}\">{joined}</comot:effects>");
        return Ok(splice_insert(svg_content, metadata.content_end, &block));
    }
    let block = format!(
        "<metadata><comot:effects xmlns:comot=\"{EFFECTS_NS}\">{joined}</comot:effects></metadata>"
    );
    Ok(splice_insert(svg_content, svg_root.content_start, &block))
}

// ---------------------------------------------------------------------------
// clipboard SVG (system clipboard exchange format)
// ---------------------------------------------------------------------------

/// A copy/paste payload — one entry per copied top-level element (ancestor
/// transform already folded in) plus the effects targeting any of them.
/// Field order and `camelCase` renaming match `JSON.stringify`'s output for
/// the TS `ClipboardPayload` interface exactly (declaration order = key
/// order for both `serde_json` and V8); `view_box` is omitted from the
/// serialized object entirely when absent (`skip_serializing_if`), matching
/// `JSON.stringify` dropping an `undefined` field rather than writing
/// `"viewBox":null` — the two engines must produce byte-identical clipboard
/// files.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPayload {
    pub source_slide_path: String,
    /// Full container markup, one entry per copied target.
    pub elements: Vec<String>,
    /// `<comot:effect>` markup, verbatim, in original document order.
    pub effects: Vec<String>,
    /// The source slide's `<svg viewBox>`, verbatim. `None` for a payload
    /// written before this field existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_box: Option<String>,
}

const CLIPBOARD_MARKER_ATTR: &str = "data-comot-clipboard";
const CLIPBOARD_MARKER_VALUE: &str = "elements";
const CLIPBOARD_SOURCE_ATTR: &str = "data-comot-source";

/// Used only to satisfy `assert_slide_compliant`'s missing-viewbox check
/// while sanitising a fragment in isolation — never the payload's own
/// `view_box`.
const SANITIZE_PLACEHOLDER_VIEWBOX: &str = "0 0 1280 720";

/// `EFFECTS_NS` — the ONE shared namespace `<comot:effects>`
/// lives in everywhere it's read or written (`effects::edit::EFFECTS_NS`,
/// `packages/web/src/effects.ts`, `packages/core/src/notes.ts`'s
/// `NOTES_NS`). Reused directly, not redeclared — this ticket's own
/// `effects::remove_effects_targeting` (P2 foundation) already established
/// that constant.
use crate::effects::edit::EFFECTS_NS;

const XML_NAMED_ENTITIES: [(&str, char); 5] = [
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
];

/// XML 1.0 §2.2 legal character ranges — the code points a conforming XML
/// character reference may target. Anything else (surrogate halves,
/// `0xFFFE`/`0xFFFF`, code points above `0x10FFFF`, most C0 controls) would
/// make the written slide unparsable by any XML parser.
fn is_legal_xml_code_point(code_point: u32) -> bool {
    code_point == 0x9
        || code_point == 0xa
        || code_point == 0xd
        || (0x20..=0xd7ff).contains(&code_point)
        || (0xe000..=0xfffd).contains(&code_point)
        || (0x10000..=0x10ffff).contains(&code_point)
}

/// Finds the next `&name;` / `&#123;` / `&#x1F;` entity-reference-SHAPED
/// span at or after byte offset `from` (case-insensitive name/hex letters,
/// matching TS's `/gi` flag), returning `(start, end, whole_match)`.
/// Shape-only: does not validate that a named entity is one of the five
/// legal ones, or that a numeric one names a legal XML code point.
/// ASCII-only pattern on an otherwise-arbitrary UTF-8 string is safe to scan
/// byte-by-byte: none of `&`, `#`, `x`/`X`, digits, letters, or `;` can ever
/// appear as a continuation byte of a multi-byte UTF-8 sequence.
fn find_entity_reference(s: &str, from: usize) -> Option<(usize, usize, &str)> {
    let bytes = s.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let mut j = i + 1;
            if j < bytes.len() && bytes[j] == b'#' {
                j += 1;
                if j < bytes.len() && (bytes[j] == b'x' || bytes[j] == b'X') {
                    let hex_start = j + 1;
                    let mut k = hex_start;
                    while k < bytes.len() && bytes[k].is_ascii_hexdigit() {
                        k += 1;
                    }
                    if k > hex_start && k < bytes.len() && bytes[k] == b';' {
                        return Some((i, k + 1, &s[i..=k]));
                    }
                } else {
                    let dec_start = j;
                    let mut k = dec_start;
                    while k < bytes.len() && bytes[k].is_ascii_digit() {
                        k += 1;
                    }
                    if k > dec_start && k < bytes.len() && bytes[k] == b';' {
                        return Some((i, k + 1, &s[i..=k]));
                    }
                }
            } else {
                let name_start = j;
                let mut k = name_start;
                while k < bytes.len() && bytes[k].is_ascii_alphabetic() {
                    k += 1;
                }
                if k > name_start && k < bytes.len() && bytes[k] == b';' {
                    return Some((i, k + 1, &s[i..=k]));
                }
            }
        }
        i += 1;
    }
    None
}

/// Decimal (`&#104;`), hex (`&#x68;`) and the five predefined XML entities —
/// the only character references a browser's XML/SVG parser resolves.
/// Total — never panics: a numeric reference outside the legal XML range is
/// returned verbatim (undecoded), so the caller rejects it explicitly via
/// `has_illegal_numeric_character_reference` instead.
fn decode_xml_entities(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut cursor = 0usize;
    while let Some((start, end, whole)) = find_entity_reference(value, cursor) {
        result.push_str(&value[cursor..start]);
        let inner = &whole[1..whole.len() - 1]; // strip leading '&' and trailing ';'
        let decoded = if let Some(rest) = inner.strip_prefix('#') {
            let code_point: Option<u32> =
                if let Some(hex) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    rest.parse().ok()
                };
            match code_point {
                Some(cp) if is_legal_xml_code_point(cp) => char::from_u32(cp).map(String::from),
                _ => None,
            }
        } else {
            XML_NAMED_ENTITIES
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(inner))
                .map(|(_, replacement)| replacement.to_string())
        };
        result.push_str(&decoded.unwrap_or_else(|| whole.to_string()));
        cursor = end;
    }
    result.push_str(&value[cursor..]);
    result
}

/// A numeric character reference (`&#…;`/`&#x…;`) whose code point
/// `decode_xml_entities` would refuse to decode — writing it verbatim would
/// produce a slide no XML parser can read back.
fn has_illegal_numeric_character_reference(value: &str) -> bool {
    let mut cursor = 0usize;
    while let Some((_start, end, whole)) = find_entity_reference(value, cursor) {
        let inner = &whole[1..whole.len() - 1];
        if let Some(rest) = inner.strip_prefix('#') {
            let code_point: Option<u32> =
                if let Some(hex) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    rest.parse().ok()
                };
            if let Some(cp) = code_point {
                if !is_legal_xml_code_point(cp) {
                    return true;
                }
            }
        }
        cursor = end;
    }
    false
}

/// Ports `XML_REFERENCE_RE`: matches only the five legal named XML entities
/// or a numeric reference SHAPE (not legality-checked here) — narrower than
/// `find_entity_reference` (`decode_xml_entities`'s own pattern, which
/// accepts ANY alphabetic name). Used only by `has_illegal_raw_xml_text` to
/// find and strip well-formed reference shapes before checking for a stray
/// bare `&`.
fn match_named_or_numeric_reference(s: &str, start: usize) -> Option<usize> {
    let rest = s.get(start + 1..)?;
    for name in ["amp", "lt", "gt", "quot", "apos"] {
        if let Some(after) = rest.strip_prefix(name) {
            if after.starts_with(';') {
                return Some(start + 1 + name.len() + 1);
            }
        }
    }
    let bytes = rest.as_bytes();
    if !bytes.is_empty() && bytes[0] == b'#' {
        if bytes.len() > 1 && (bytes[1] == b'x' || bytes[1] == b'X') {
            let mut k = 2;
            while k < bytes.len() && bytes[k].is_ascii_hexdigit() {
                k += 1;
            }
            if k > 2 && k < bytes.len() && bytes[k] == b';' {
                return Some(start + 1 + k + 1);
            }
        } else {
            let mut k = 1;
            while k < bytes.len() && bytes[k].is_ascii_digit() {
                k += 1;
            }
            if k > 1 && k < bytes.len() && bytes[k] == b';' {
                return Some(start + 1 + k + 1);
            }
        }
    }
    None
}

fn strip_xml_reference_re_matches(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut cursor = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(end) = match_named_or_numeric_reference(s, i) {
                result.push_str(&s[cursor..i]);
                cursor = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    result.push_str(&s[cursor..]);
    result
}

/// `null` (`None`) when `raw` is well-formed XML text; otherwise a
/// human-readable reason. This check runs once, ahead of any grammar, so no
/// per-attribute grammar needs to reason about raw vs. decoded XML legality.
fn has_illegal_raw_xml_text(raw: &str) -> Option<&'static str> {
    if raw.contains('<') {
        return Some("含有未逸出的 <");
    }
    if strip_xml_reference_re_matches(raw).contains('&') {
        return Some("含有未開啟合法字元參照的 &");
    }
    if has_illegal_numeric_character_reference(raw) {
        return Some("含有非法的 XML 字元參照");
    }
    for ch in raw.chars() {
        if !is_legal_xml_code_point(ch as u32) {
            return Some("含有 XML 1.0 不允許的字元");
        }
    }
    None
}

/// Delegates, as closely as a hand-written port can, to the same
/// WHATWG `URL` parser a browser uses — but this crate cannot import one
/// (plan decision D4: no new crate dependency, `url` included). This is
/// therefore a PROVEN REDUCTION, not a URL parser: `isRelativeRef`'s shape
/// gate (`is_relative_ref` below) only ever calls this with a value that
/// already contains no `:`, no `\`, no C0/DEL/C1 control character, and does
/// not start with `//` — the TS test suite's own
/// "WHATWG URL parser characteristics I1 depends on" documents that the
/// ONLY way a reference changes scheme+host from its base is via an
/// explicit `scheme:` prefix (`new URL("https:evil.example/x.png", "http://...")`
/// resolves to host `evil.example`, not the base's) or a `//host` authority
/// marker — both already excluded upstream. Re-checking both invariants
/// here (rather than trusting the caller) makes this fail closed if ever
/// called directly with un-gated input, the same defense-in-depth posture
/// the TS original has even though it delegates to a real parser to get it.
fn resolves_within_document(value: &str) -> bool {
    if value.contains(':') || value.contains('\\') {
        return false;
    }
    if value.starts_with("//") {
        return false;
    }
    true
}

// ---------------------------------------------------------------------------
// Value grammars — the allowlist's third layer.
// ---------------------------------------------------------------------------

type Grammar = Arc<dyn Fn(&str) -> bool + Send + Sync>;

fn grammar(f: fn(&str) -> bool) -> Grammar {
    Arc::new(f)
}

fn enum_of(values: &'static [&'static str]) -> Grammar {
    Arc::new(move |value: &str| values.contains(&value))
}

fn match_mantissa(bytes: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 {
        if i < bytes.len() && bytes[i] == b'.' {
            let frac_start = i + 1;
            let mut j = frac_start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > frac_start {
                return Some(j);
            }
        }
        return Some(i);
    }
    if !bytes.is_empty() && bytes[0] == b'.' {
        let mut j = 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > 1 {
            return Some(j);
        }
    }
    None
}

/// Ports `NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/` —
/// stricter than `element::edit`'s path-data number scanner (that one
/// tokenizes SUBSTRINGS inside a larger string; this one anchors the WHOLE
/// value, and rejects a trailing bare `.` like `"5."` that the path scanner
/// would happily treat as `"5"` followed by literal text).
fn is_number(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let mantissa_len = match match_mantissa(&bytes[i..]) {
        Some(len) => len,
        None => return false,
    };
    i += mantissa_len;
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let exp_digits_start = j;
        let mut k = exp_digits_start;
        while k < bytes.len() && bytes[k].is_ascii_digit() {
            k += 1;
        }
        if k > exp_digits_start {
            i = k;
        }
    }
    i == bytes.len()
}

/// One or more `NUMBER`s separated by whitespace or commas; `exact_count`,
/// when given, pins the count.
fn number_list(exact_count: Option<usize>) -> Grammar {
    Arc::new(move |value: &str| {
        let parts: Vec<&str> = value
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|p| !p.is_empty())
            .collect();
        if parts.is_empty() {
            return false;
        }
        if let Some(n) = exact_count {
            if parts.len() != n {
                return false;
            }
        }
        parts.iter().all(|p| is_number(p))
    })
}

fn is_xml_name(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

fn is_hex_color(value: &str) -> bool {
    match value.strip_prefix('#') {
        Some(hex) => {
            matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
        }
        None => false,
    }
}

fn is_named_color(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphabetic())
}

fn is_paint_url_ref(value: &str) -> bool {
    match value
        .strip_prefix("url(#")
        .and_then(|s| s.strip_suffix(')'))
    {
        Some(inner) => is_xml_name(inner),
        None => false,
    }
}

/// Narrower than the write side (`element style set` does not
/// validate `fill`/`stroke`'s value at all beyond the style whitelist) —
/// known mis-rejection: `fill="rgb(1,2,3)"`. Not fixed here (plan section
/// 2, boundary 11).
fn is_paint(value: &str) -> bool {
    value == "none"
        || value == "currentColor"
        || is_hex_color(value)
        || is_named_color(value)
        || is_paint_url_ref(value)
}

fn is_transform_charset(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " ,.()+-eE\t\n\r".contains(c))
}

/// Conservative character set as a first gate, `parse_transform` (already a
/// strict allowlist parser) as the real judge.
fn is_transform(value: &str) -> bool {
    is_transform_charset(value) && parse_transform(Some(value)).is_ok()
}

/// Character set only — path data isn't a reference carrier, so there's
/// nothing to parse for, only a shape to bound. Known mis-rejection: an
/// arbitrary `element insert path --d` string outside SVG path syntax.
fn is_path_data(value: &str) -> bool {
    value.chars().all(|c| {
        matches!(
            c,
            'M' | 'm'
                | 'Z'
                | 'z'
                | 'L'
                | 'l'
                | 'H'
                | 'h'
                | 'V'
                | 'v'
                | 'C'
                | 'c'
                | 'S'
                | 's'
                | 'Q'
                | 'q'
                | 'T'
                | 't'
                | 'A'
                | 'a'
                | '0'..='9' | 'e' | 'E' | '.' | ',' | '+' | '-'
        ) || c.is_whitespace()
    })
}

fn is_relative_ref_fragment(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(is_xml_name)
}

fn is_relative_ref_path_charset(value: &str) -> bool {
    value.chars().all(|c| {
        let cp = c as u32;
        !(cp <= 0x1f || (0x7f..=0x9f).contains(&cp) || c == ':' || c == '\\')
    })
}

/// Known mis-rejection: no non-ASCII sample this ticket's
/// predecessor tested ever relied on the charset alone — only on the
/// `:`/`\`/leading-`//` exclusions or `resolves_within_document`. A
/// Chinese asset filename (ordinary input for a Traditional-Chinese-first
/// product) passes: the charset excludes only `:`/`\`/control characters,
/// not non-ASCII text.
fn is_relative_ref(value: &str) -> bool {
    let shape_ok = value.is_empty()
        || is_relative_ref_fragment(value)
        || (is_relative_ref_path_charset(value) && !value.starts_with("//"));
    shape_ok && resolves_within_document(value)
}

fn is_cell_ref(value: &str) -> bool {
    match value.split_once(',') {
        Some((a, b)) => {
            !a.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && !b.is_empty()
                && b.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// Excludes `(`/`)`/`\`/`:`/`;`/`<`/`>`/`"`/`'`/`&` — i.e. every character a
/// CSS function, a protocol, or a markup delimiter needs. Known
/// mis-rejection: a quoted/comma-listed font-family value.
fn is_font_family(value: &str) -> bool {
    value.chars().count() <= 128
        && value.chars().all(|c| {
            !matches!(
                c,
                '(' | ')' | '\\' | ':' | ';' | '<' | '>' | '"' | '\'' | '&'
            )
        })
}

/// Free-form display text (`data-comot-name`) — excludes only control
/// characters; markup delimiters are `has_illegal_raw_xml_text`'s job, not
/// this grammar's.
fn is_free_text(value: &str) -> bool {
    value.chars().all(|c| {
        let cp = c as u32;
        !(cp <= 0x08
            || cp == 0x0b
            || cp == 0x0c
            || (0x0e..=0x1f).contains(&cp)
            || (0x7f..=0x9f).contains(&cp))
    })
}

/// `data-comot-list`: one whitespace(single-space)-separated token per
/// paragraph — no upper bound on paragraph count.
fn is_list_spec(value: &str) -> bool {
    !value.is_empty()
        && value
            .split(' ')
            .all(|tok| matches!(tok, "bullet" | "number" | "none"))
}

const FONT_WEIGHTS: [&str; 13] = [
    "normal", "bold", "lighter", "bolder", "100", "200", "300", "400", "500", "600", "700", "800",
    "900",
];

/// Shared by every primitive tag — `<g>` is deliberately excluded (it has
/// no `fill`/`stroke`/`opacity` of its own).
fn common_attributes() -> HashMap<&'static str, Grammar> {
    let mut m: HashMap<&'static str, Grammar> = HashMap::new();
    m.insert("id", grammar(is_xml_name));
    m.insert("data-comot-name", grammar(is_free_text));
    m.insert("fill", grammar(is_paint));
    m.insert("stroke", grammar(is_paint));
    m.insert("stroke-width", grammar(is_number));
    m.insert("stroke-dasharray", number_list(None));
    m.insert("opacity", grammar(is_number));
    m
}

/// Shared by `text`/`tspan`.
fn textish_attributes() -> HashMap<&'static str, Grammar> {
    let mut m: HashMap<&'static str, Grammar> = HashMap::new();
    m.insert("font-family", grammar(is_font_family));
    m.insert("font-size", grammar(is_number));
    m.insert("font-weight", enum_of(&FONT_WEIGHTS));
    m.insert("font-style", enum_of(&["normal", "italic", "oblique"]));
    m.insert("text-anchor", enum_of(&["start", "middle", "end"]));
    m
}

/// Plan §4.3: one grammar map per tag `sanitize_clipboard_markup`
/// ("element" kind) may see. A tag with no entry here is rejected outright —
/// this *is* the allowlist's tag layer, alongside `assert_slide_compliant`'s
/// own (broader, structural) tag sweep.
fn element_tag_attributes() -> &'static HashMap<&'static str, HashMap<&'static str, Grammar>> {
    static MAP: OnceLock<HashMap<&'static str, HashMap<&'static str, Grammar>>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut m = HashMap::new();

        let mut g: HashMap<&'static str, Grammar> = HashMap::new();
        g.insert("id", grammar(is_xml_name));
        g.insert("transform", grammar(is_transform));
        g.insert("data-comot-name", grammar(is_free_text));
        g.insert("data-comot-media", grammar(is_relative_ref));
        g.insert("data-comot-lock", enum_of(&["true"]));
        g.insert("data-comot-type", enum_of(&["table"]));
        g.insert("data-comot-cell", grammar(is_cell_ref));
        g.insert("data-comot-cols", number_list(None));
        g.insert("data-comot-rows", number_list(None));
        g.insert("data-comot-header", enum_of(&["1"]));
        g.insert("data-comot-theme", enum_of(&["dark", "light", "zebra"]));
        g.insert("data-comot-span", grammar(is_cell_ref));
        g.insert("data-comot-repeat", enum_of(&["row"]));
        g.insert("data-comot-generated", enum_of(&["1"]));
        g.insert("data-comot-align", enum_of(&["left", "center", "right"]));
        g.insert("display", enum_of(&["none"]));
        g.insert("data-comot-text-width", grammar(is_number));
        g.insert("data-comot-text-height", grammar(is_number));
        g.insert(
            "data-comot-text-align",
            enum_of(&["left", "center", "right"]),
        );
        m.insert("g", g);

        let mut rect = common_attributes();
        rect.insert("x", grammar(is_number));
        rect.insert("y", grammar(is_number));
        rect.insert("width", grammar(is_number));
        rect.insert("height", grammar(is_number));
        rect.insert("rx", grammar(is_number));
        rect.insert("ry", grammar(is_number));
        rect.insert("fill-opacity", grammar(is_number));
        rect.insert("pointer-events", enum_of(&["all"]));
        m.insert("rect", rect);

        let mut ellipse = common_attributes();
        ellipse.insert("cx", grammar(is_number));
        ellipse.insert("cy", grammar(is_number));
        ellipse.insert("rx", grammar(is_number));
        ellipse.insert("ry", grammar(is_number));
        m.insert("ellipse", ellipse);

        let mut circle = common_attributes();
        circle.insert("cx", grammar(is_number));
        circle.insert("cy", grammar(is_number));
        circle.insert("r", grammar(is_number));
        circle.insert("data-comot-media", grammar(is_relative_ref));
        m.insert("circle", circle);

        let mut line = common_attributes();
        line.insert("x1", grammar(is_number));
        line.insert("y1", grammar(is_number));
        line.insert("x2", grammar(is_number));
        line.insert("y2", grammar(is_number));
        m.insert("line", line);

        let mut path = common_attributes();
        path.insert("d", grammar(is_path_data));
        m.insert("path", path);

        let mut image = common_attributes();
        image.insert("x", grammar(is_number));
        image.insert("y", grammar(is_number));
        image.insert("width", grammar(is_number));
        image.insert("height", grammar(is_number));
        image.insert("href", grammar(is_relative_ref));
        image.insert(
            "preserveAspectRatio",
            enum_of(&["none", "xMidYMid meet", "xMidYMid slice"]),
        );
        image.insert("data-comot-media", grammar(is_relative_ref));
        m.insert("image", image);

        let mut text = common_attributes();
        text.extend(textish_attributes());
        text.insert("x", grammar(is_number));
        text.insert("y", grammar(is_number));
        text.insert("xml:space", enum_of(&["preserve"]));
        text.insert("data-comot-list", grammar(is_list_spec));
        text.insert("data-comot-list-marker", enum_of(&["true"]));
        m.insert("text", text);

        let mut tspan = common_attributes();
        tspan.extend(textish_attributes());
        tspan.insert("x", grammar(is_number));
        tspan.insert("y", grammar(is_number));
        tspan.insert("data-comot-break", enum_of(&["1"]));
        m.insert("tspan", tspan);

        let mut title: HashMap<&'static str, Grammar> = HashMap::new();
        title.insert("id", grammar(is_xml_name));
        m.insert("title", title);

        let mut desc: HashMap<&'static str, Grammar> = HashMap::new();
        desc.insert("id", grammar(is_xml_name));
        m.insert("desc", desc);

        m
    })
}

/// The fixed effect value sets a `<comot:effect>` grammar validates against
/// — own, private copy (not shared with `effects::mod`, F6's eventual
/// territory), matching `packages/core/src/effects/index.ts`'s
/// `SUPPORTED_EFFECTS`/`SUPPORTED_STARTS` exactly.
const EFFECT_FAMILIES: [&str; 5] = ["enter", "emphasis", "exit", "path", "media"];
const EFFECT_NAMES: [&str; 14] = [
    "appear",
    "fade",
    "fly-up",
    "fly-left",
    "zoom",
    "pulse",
    "spin",
    "grow",
    "disappear",
    "fade-out",
    "zoom-out",
    "path",
    "play",
    "pause",
];
const EFFECT_STARTS: [&str; 3] = ["on-click", "with-previous", "after-previous"];

fn effect_attribute_grammar() -> &'static HashMap<&'static str, Grammar> {
    static MAP: OnceLock<HashMap<&'static str, Grammar>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut m: HashMap<&'static str, Grammar> = HashMap::new();
        m.insert("target", grammar(is_xml_name));
        m.insert("family", enum_of(&EFFECT_FAMILIES));
        m.insert("effect", enum_of(&EFFECT_NAMES));
        m.insert("start", enum_of(&EFFECT_STARTS));
        m.insert("duration", grammar(is_number));
        m.insert("delay", grammar(is_number));
        m.insert("d", grammar(is_path_data));
        m
    })
}

/// [Corrective Strategy #1, D6] Every grammar runs against both the raw
/// attribute value and its one-pass entity-decode — a grammar checked only
/// against the raw form is one an entity-encoded payload can slip past.
fn check_attribute_value(
    tag: &str,
    attr_name: &str,
    value: &str,
    label: &str,
    grammar: &Grammar,
) -> CoMotionResult<()> {
    if let Some(problem) = has_illegal_raw_xml_text(value) {
        return Err(CoMotionError::invalid(format!(
            "剪貼簿內容不可信：{label} 的 <{tag}> 屬性 {attr_name} 的原始文字不是合法的 XML（{problem}）"
        )));
    }
    if has_illegal_numeric_character_reference(value) {
        return Err(CoMotionError::invalid(format!(
            "剪貼簿內容不可信：{label} 的 <{tag}> 屬性 {attr_name} 含有非法的 XML 字元參照（{value}）"
        )));
    }
    let decoded = decode_xml_entities(value);
    let forms: [&str; 2] = if decoded == value {
        [value, value]
    } else {
        [value, decoded.as_str()]
    };
    let forms: &[&str] = if decoded == value {
        &forms[..1]
    } else {
        &forms[..]
    };
    for form in forms {
        if !grammar(form) {
            return Err(CoMotionError::invalid(format!(
                "剪貼簿內容不可信：{label} 的 <{tag}> 屬性 {attr_name} 的值不符合允許的格式（{value}）"
            )));
        }
    }
    Ok(())
}

fn check_node_attributes(node: &ScannedNode, label: &str, is_effect: bool) -> CoMotionResult<()> {
    let tag_grammar: Option<&HashMap<&str, Grammar>> = if is_effect {
        if node.tag == "comot:effect" {
            Some(effect_attribute_grammar())
        } else {
            None
        }
    } else {
        element_tag_attributes().get(node.tag.as_str())
    };
    let Some(tag_grammar) = tag_grammar else {
        return Err(CoMotionError::invalid(format!(
            "剪貼簿內容不可信：{label} 含有不在允許清單內的標籤 <{}>",
            node.tag
        )));
    };
    for attribute in &node.attributes {
        let Some(attr_grammar) = tag_grammar.get(attribute.name.as_str()) else {
            return Err(CoMotionError::invalid(format!(
                "剪貼簿內容不可信：{label} 的 <{}> 屬性 {} 不在允許清單內",
                node.tag, attribute.name
            )));
        };
        check_attribute_value(
            &node.tag,
            &attribute.name,
            &attribute.value,
            label,
            attr_grammar,
        )?;
    }
    for child in &node.children {
        check_node_attributes(child, label, is_effect)?;
    }
    Ok(())
}

/// Same raw-form XML legality as `check_attribute_value`, applied
/// to element/character content instead of an attribute value.
fn check_text_content(markup: &str, node: &ScannedNode, label: &str) -> CoMotionResult<()> {
    if node.self_closing {
        return Ok(());
    }
    let mut cursor = node.content_start;
    let mut spans: Vec<String> = Vec::new();
    for child in &node.children {
        spans.push(utf16_slice(markup, cursor, child.start));
        check_text_content(markup, child, label)?;
        cursor = child.end;
    }
    spans.push(utf16_slice(markup, cursor, node.content_end));
    for span in &spans {
        if let Some(problem) = has_illegal_raw_xml_text(span) {
            return Err(CoMotionError::invalid(format!(
                "剪貼簿內容不可信：{label} 的 <{}> 文字內容不是合法的 XML（{problem}）",
                node.tag
            )));
        }
    }
    Ok(())
}

fn contains_doctype_entity_cdata_or_comment(markup: &str) -> bool {
    let upper = markup.to_ascii_uppercase();
    upper.contains("<!DOCTYPE")
        || upper.contains("<!ENTITY")
        || upper.contains("<![CDATA[")
        || upper.contains("<!--")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardMarkupKind {
    Element,
    Effect,
}

/// The one gate every pasted fragment — internal or from the system
/// clipboard — must pass before it is spliced into a presentation
/// (ADR-0010). Never patches a bad fragment into something acceptable:
/// every violation errors, none are silently stripped.
pub fn sanitize_clipboard_markup(markup: &str, kind: ClipboardMarkupKind) -> CoMotionResult<()> {
    if contains_doctype_entity_cdata_or_comment(markup) {
        return Err(CoMotionError::invalid(
            "剪貼簿內容不可信：含有 DOCTYPE、ENTITY 宣告、CDATA 區塊或註解",
        ));
    }

    let label = match kind {
        ClipboardMarkupKind::Element => "剪貼簿元素",
        ClipboardMarkupKind::Effect => "剪貼簿效果項",
    };
    let wrapped = match kind {
        ClipboardMarkupKind::Element => {
            format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{SANITIZE_PLACEHOLDER_VIEWBOX}\">{markup}</svg>"
            )
        }
        ClipboardMarkupKind::Effect => format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{SANITIZE_PLACEHOLDER_VIEWBOX}\"><metadata><comot:effects xmlns:comot=\"{EFFECTS_NS}\">{markup}</comot:effects></metadata></svg>"
        ),
    };
    assert_slide_compliant(&wrapped, label)?;

    let roots = scan_document(markup)?;
    let expected_root_tag = match kind {
        ClipboardMarkupKind::Element => "g",
        ClipboardMarkupKind::Effect => "comot:effect",
    };
    if roots.len() != 1 || roots[0].tag != expected_root_tag {
        return Err(CoMotionError::invalid(format!(
            "剪貼簿內容不可信：{label} 必須是恰好一個 <{expected_root_tag}> 根節點"
        )));
    }
    for root in &roots {
        check_node_attributes(root, label, matches!(kind, ClipboardMarkupKind::Effect))?;
        check_text_content(markup, root, label)?;
    }
    Ok(())
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

/// Serialises a clipboard payload into the single exchange format both
/// `text/plain` and `image/svg+xml` carry: a standalone, self-describing
/// `<svg>` — a legal document on its own, and a compliant slide fragment
/// (`assert_slide_compliant` accepts it) at the same time. Sanitises every
/// element/effect first, so nothing this app ever *writes* to the system
/// clipboard can itself be the unsafe half of a round trip.
pub fn serialize_clipboard_svg(payload: &ClipboardPayload) -> CoMotionResult<String> {
    for element in &payload.elements {
        sanitize_clipboard_markup(element, ClipboardMarkupKind::Element)?;
    }
    for effect in &payload.effects {
        sanitize_clipboard_markup(effect, ClipboardMarkupKind::Effect)?;
    }

    let number_list_4 = number_list(Some(4));
    let raw_view_box = payload
        .view_box
        .as_deref()
        .unwrap_or(SANITIZE_PLACEHOLDER_VIEWBOX);
    let view_box = escape_attr(if number_list_4(raw_view_box) {
        raw_view_box
    } else {
        SANITIZE_PLACEHOLDER_VIEWBOX
    });
    let effects_block = if !payload.effects.is_empty() {
        format!(
            "<metadata><comot:effects xmlns:comot=\"{EFFECTS_NS}\">{}</comot:effects></metadata>",
            payload.effects.concat()
        )
    } else {
        String::new()
    };
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:comot=\"{EFFECTS_NS}\" viewBox=\"{view_box}\" {CLIPBOARD_MARKER_ATTR}=\"{CLIPBOARD_MARKER_VALUE}\" {CLIPBOARD_SOURCE_ATTR}=\"{}\">{effects_block}{}</svg>",
        escape_attr(&payload.source_slide_path),
        payload.elements.concat()
    ))
}

/// `serialize_clipboard_svg`'s approximate inverse. Returns `None` — never
/// errors — when `markup` is not a comotion element clipboard payload at
/// all (wrong root marker, or not parseable): the ordinary "plain
/// text/foreign SVG on the system clipboard" case a paste handler must
/// treat as a silent no-op, not an error.
pub fn parse_clipboard_svg(markup: &str) -> Option<ClipboardPayload> {
    let roots = scan_document(markup).ok()?;
    let svg_root = roots.iter().find(|n| n.tag == "svg")?;
    if attribute_value(svg_root, CLIPBOARD_MARKER_ATTR).as_deref() != Some(CLIPBOARD_MARKER_VALUE) {
        return None;
    }
    let source_slide_path = attribute_value(svg_root, CLIPBOARD_SOURCE_ATTR)?;

    let raw_view_box = attribute_value(svg_root, "viewBox");
    if let Some(vb) = &raw_view_box {
        if !number_list(Some(4))(vb) {
            return None;
        }
    }

    let mut effects = Vec::new();
    if let Some(metadata) = svg_root.children.iter().find(|c| c.tag == "metadata") {
        if let Some(effects_list) = metadata.children.iter().find(|c| c.tag == "comot:effects") {
            for effect in &effects_list.children {
                if effect.tag == "comot:effect" {
                    effects.push(utf16_slice(markup, effect.start, effect.end));
                }
            }
        }
    }

    let elements: Vec<String> = svg_root
        .children
        .iter()
        .filter(|c| c.tag == "g")
        .map(|c| utf16_slice(markup, c.start, c.end))
        .collect();

    Some(ClipboardPayload {
        source_slide_path,
        elements,
        effects,
        view_box: raw_view_box,
    })
}

#[derive(Debug)]
pub struct PasteResult {
    pub updated: String,
    /// The new ids assigned to `payload.elements`' top-level containers, in
    /// payload order (never a descendant's id).
    pub element_ids: Vec<String>,
}

/// Pastes a clipboard payload into `slide_path`: every container id —
/// including descendants — is regenerated via `generate_id()` and
/// consistently substituted everywhere it is referenced (including effect
/// `target`s); elements land as the last children of `<svg>` (topmost
/// z-order), in clipboard order; `dx`/`dy` are added to each pasted
/// top-level container's own translate; effects are appended at the end of
/// the target slide's effect list.
pub fn paste_elements(
    svg_content: &str,
    slide_path: &str,
    payload: &ClipboardPayload,
    dx: f64,
    dy: f64,
    mut generate_id: impl FnMut() -> String,
) -> CoMotionResult<PasteResult> {
    assert_slide_compliant(svg_content, slide_path)?;
    if !dx.is_finite() || !dy.is_finite() {
        return Err(CoMotionError::invalid("dx/dy 必須是有限數字"));
    }
    if payload.elements.is_empty() {
        return Err(CoMotionError::invalid("剪貼簿是空的"));
    }
    for element in &payload.elements {
        sanitize_clipboard_markup(element, ClipboardMarkupKind::Element)?;
    }
    for effect in &payload.effects {
        sanitize_clipboard_markup(effect, ClipboardMarkupKind::Effect)?;
    }

    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut pasted_ids = Vec::with_capacity(payload.elements.len());
    let mut prepared_elements = Vec::with_capacity(payload.elements.len());
    for markup in &payload.elements {
        let roots = scan_document(markup)?;
        let original_id = roots.first().and_then(|root| attribute_value(root, "id"));
        let (renamed, local_map) = regenerate_ids(markup, &mut generate_id)?;
        for (old_id, new_id) in local_map {
            id_map.insert(old_id, new_id);
        }
        let translated = rewrite_fragment_transform(&renamed, |mut parts| {
            parts.translate_x += dx;
            parts.translate_y += dy;
            Ok(parts)
        })?;
        prepared_elements.push(translated);
        if let Some(oid) = original_id {
            pasted_ids.push(
                id_map
                    .get(&oid)
                    .cloned()
                    .expect("regenerate_ids always maps the fragment's own root id"),
            );
        }
    }

    let mut updated = append_markup(svg_content, &prepared_elements.concat())?;

    if !payload.effects.is_empty() {
        let mut prepared_effects = Vec::with_capacity(payload.effects.len());
        for effect in &payload.effects {
            prepared_effects.push(rewrite_effect_target(effect, &id_map)?);
        }
        updated = append_effects(&updated, &prepared_effects)?;
    }

    Ok(PasteResult {
        updated,
        element_ids: pasted_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slide(children: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">{children}</svg>"#
        )
    }

    fn ids(seed: &[&str]) -> impl FnMut() -> String {
        let mut it = seed.iter().copied();
        move || {
            it.next()
                .expect("test id generator ran out of seeded ids")
                .to_string()
        }
    }

    // --- grammars ---

    #[test]
    fn is_number_matches_the_anchored_number_grammar_exactly() {
        for ok in [
            "0", "1", "-1", "+1", "1.5", ".5", "1e10", "1.5e-3", "-.5e+2",
        ] {
            assert!(is_number(ok), "{ok} should be a number");
        }
        for bad in ["", "5.", "-", ".", "1.2.3", "1e", "abc", "1 2", "1,000"] {
            assert!(!is_number(bad), "{bad} should NOT be a number");
        }
    }

    #[test]
    fn number_list_respects_exact_count_and_separators() {
        let list4 = number_list(Some(4));
        assert!(list4("0 0 1280 720"));
        assert!(list4("0,0,1280,720"));
        assert!(!list4("0 0 1280"));
        assert!(!list4("0 0 1280 720 extra"));
        assert!(!list4(""));
    }

    #[test]
    fn is_xml_name_matches_a_generated_element_id_shape() {
        assert!(is_xml_name("el-Ab3_9.x"));
        assert!(!is_xml_name("9el"));
        assert!(!is_xml_name(""));
        assert!(!is_xml_name("el a"));
    }

    #[test]
    fn is_paint_accepts_hex_named_url_ref_and_keywords_rejects_rgb_function() {
        assert!(is_paint("none"));
        assert!(is_paint("currentColor"));
        assert!(is_paint("#fff"));
        assert!(is_paint("#ff0000"));
        assert!(is_paint("#ff0000ff"));
        assert!(is_paint("red"));
        assert!(is_paint("url(#grad-1)"));
        // Known mis-rejection, not fixed by this port.
        assert!(!is_paint("rgb(1,2,3)"));
    }

    #[test]
    fn is_transform_delegates_to_the_real_parser_behind_a_charset_gate() {
        assert!(is_transform(""));
        assert!(is_transform("translate(10 20)"));
        assert!(is_transform("translate(10 20) rotate(45)"));
        // skewX/skewY parse fine (parseTransform supports the full SVG
        // transform-function grammar) — it's decompose_matrix, not
        // parseTransform, that later rejects skew as unrepresentable.
        assert!(is_transform("skewX(10)"));
        assert!(!is_transform("translate(10 20); alert(1)")); // charset rejects ';'
        assert!(!is_transform("bogusFn(1)")); // charset passes, parser rejects unknown function
    }

    #[test]
    fn is_relative_ref_accepts_empty_fragment_and_non_ascii_path_rejects_colon_and_leading_slash_slash()
     {
        assert!(is_relative_ref(""));
        assert!(is_relative_ref("#el-a1"));
        assert!(is_relative_ref("assets/圖片.png")); // non-ASCII path is ordinary input
        assert!(is_relative_ref("/assets/x.png")); // single leading slash stays on the same host
        // "#9invalid" fails the FRAGMENT-specific sub-check (fragments must
        // be XML names) but still satisfies the general PATH charset
        // sub-check (which does not exclude '#') — either branch passing is
        // enough, matching the TS original's `||` shape gate exactly.
        assert!(is_relative_ref("#9invalid"));
        assert!(!is_relative_ref("javascript:alert(1)"));
        assert!(!is_relative_ref("//evil.example/x.png"));
        assert!(!is_relative_ref("a\\b"));
    }

    #[test]
    fn resolves_within_document_fails_closed_on_colon_backslash_or_double_slash() {
        assert!(resolves_within_document("assets/x.png"));
        assert!(resolves_within_document(""));
        assert!(!resolves_within_document("https:evil.example"));
        assert!(!resolves_within_document("a\\b"));
        assert!(!resolves_within_document("//evil.example"));
    }

    #[test]
    fn is_cell_ref_matches_row_comma_col() {
        assert!(is_cell_ref("0,0"));
        assert!(is_cell_ref("12,34"));
        assert!(!is_cell_ref("0,"));
        assert!(!is_cell_ref(",0"));
        assert!(!is_cell_ref("0-0"));
    }

    #[test]
    fn is_font_family_rejects_quotes_and_comma_lists_known_mis_rejection() {
        assert!(is_font_family("Noto Sans TC"));
        // Known mis-rejection: a quoted/comma-separated CSS
        // font-family list, not fixed by this port.
        assert!(!is_font_family("\"Noto Sans TC\", sans-serif"));
    }

    #[test]
    fn is_list_spec_matches_single_space_separated_tokens_any_length() {
        assert!(is_list_spec("bullet"));
        assert!(is_list_spec("bullet number none bullet"));
        assert!(!is_list_spec(""));
        assert!(!is_list_spec("bullet  number")); // double space
        assert!(!is_list_spec("bullet,number"));
    }

    // --- decode / raw-xml-legality ---

    #[test]
    fn decode_xml_entities_decodes_named_and_numeric_references_leaves_illegal_ones_verbatim() {
        assert_eq!(decode_xml_entities("a&amp;b"), "a&b");
        assert_eq!(decode_xml_entities("&#65;&#x42;"), "AB");
        // A surrogate-half numeric reference is illegal — returned verbatim.
        assert_eq!(decode_xml_entities("&#xD800;"), "&#xD800;");
        assert_eq!(decode_xml_entities("no entities here"), "no entities here");
    }

    #[test]
    fn has_illegal_raw_xml_text_flags_unescaped_lt_and_bare_ampersand() {
        assert!(has_illegal_raw_xml_text("a<b").is_some());
        assert!(has_illegal_raw_xml_text("a&b").is_some());
        assert!(has_illegal_raw_xml_text("a&amp;b").is_none());
        assert!(has_illegal_raw_xml_text("plain text").is_none());
    }

    // --- sanitize_clipboard_markup ---

    #[test]
    fn sanitize_accepts_a_well_formed_element_fragment() {
        let markup = r##"<g id="el-a" transform="translate(10 20)" data-comot-name="標題"><rect x="0" y="0" width="10" height="10" fill="#ff0000"/></g>"##;
        assert!(sanitize_clipboard_markup(markup, ClipboardMarkupKind::Element).is_ok());
    }

    #[test]
    fn sanitize_rejects_a_tag_outside_the_allowlist() {
        // `assert_slide_compliant`'s own structural sweep already rejects
        // every unknown tag inside an "element" fragment's <g> wrapper
        // (requiring one of the fixed slide-primitive tags), so this
        // module's OWN `check_node_attributes` tag rejection is only
        // reachable through the "effect" kind: content inside
        // `<metadata>` only gets `assert_slide_compliant`'s forbidden-tag
        // sweep (script/foreignObject), not a full unknown-tag rejection —
        // see this module's doc comment on `check_node_attributes`.
        let markup = r#"<comot:effect target="el-a" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"><sometag/></comot:effect>"#;
        let err = sanitize_clipboard_markup(markup, ClipboardMarkupKind::Effect).unwrap_err();
        assert!(
            err.message().contains("不在允許清單內的標籤"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn sanitize_rejects_an_attribute_outside_the_tags_allowlist() {
        let markup =
            r#"<g id="el-a"><rect x="0" y="0" width="10" height="10" onload="alert(1)"/></g>"#;
        let err = sanitize_clipboard_markup(markup, ClipboardMarkupKind::Element).unwrap_err();
        assert!(
            err.message().contains("不在允許清單內"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn sanitize_rejects_doctype_entity_cdata_and_comment() {
        for poison in [
            r#"<!DOCTYPE svg><g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
            r#"<g id="el-a"><!--comment--><rect x="0" y="0" width="1" height="1"/></g>"#,
            r#"<g id="el-a"><![CDATA[x]]><rect x="0" y="0" width="1" height="1"/></g>"#,
        ] {
            let err = sanitize_clipboard_markup(poison, ClipboardMarkupKind::Element).unwrap_err();
            assert!(err.message().contains("DOCTYPE"), "{}", err.message());
        }
    }

    #[test]
    fn sanitize_rejects_more_than_one_root() {
        let two_roots = r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g><g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>"#;
        let err = sanitize_clipboard_markup(two_roots, ClipboardMarkupKind::Element).unwrap_err();
        assert!(err.message().contains("恰好一個"), "{}", err.message());
    }

    #[test]
    fn sanitize_rejects_the_wrong_root_tag() {
        // Same structural-sweep reasoning as the tag-outside-allowlist test
        // above: a bare non-"g" root for "element" kind is already rejected
        // by `assert_slide_compliant` itself ("a bare primitive must be
        // wrapped in a <g> container"),
        // never reaching this module's own root-tag check — so this is
        // exercised via "effect" kind instead, where a non-"comot:effect"
        // top-level tag inside `<metadata>` passes the structural sweep.
        let wrong_tag = "<sometag/>";
        let err = sanitize_clipboard_markup(wrong_tag, ClipboardMarkupKind::Effect).unwrap_err();
        assert!(err.message().contains("恰好一個"), "{}", err.message());
    }

    #[test]
    fn sanitize_rejects_an_unescaped_less_than_in_attribute_value() {
        let markup =
            r#"<g id="el-a" data-comot-name="x<y"><rect x="0" y="0" width="1" height="1"/></g>"#;
        let err = sanitize_clipboard_markup(markup, ClipboardMarkupKind::Element).unwrap_err();
        assert!(
            err.message().contains("不是合法的 XML"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn sanitize_catches_an_entity_encoded_bypass_of_the_relative_ref_grammar() {
        // "&#58;" decodes to ":" — checkAttributeValue must test the DECODED
        // form too, or an entity-encoded colon smuggles a scheme past the
        // relative-ref grammar's charset gate.
        let markup = r#"<g id="el-a"><image x="0" y="0" width="1" height="1" href="javascript&#58;alert(1)"/></g>"#;
        let err = sanitize_clipboard_markup(markup, ClipboardMarkupKind::Element).unwrap_err();
        assert!(
            err.message().contains("不符合允許的格式"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn sanitize_accepts_a_well_formed_effect_fragment() {
        let markup = r#"<comot:effect target="el-a" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/>"#;
        assert!(sanitize_clipboard_markup(markup, ClipboardMarkupKind::Effect).is_ok());
    }

    #[test]
    fn sanitize_effect_rejects_an_unsupported_family_or_effect_name() {
        let bad_family = r#"<comot:effect target="el-a" family="bogus" effect="fade" start="on-click" duration="0.4" delay="0"/>"#;
        assert!(sanitize_clipboard_markup(bad_family, ClipboardMarkupKind::Effect).is_err());
        let bad_effect = r#"<comot:effect target="el-a" family="enter" effect="bogus" start="on-click" duration="0.4" delay="0"/>"#;
        assert!(sanitize_clipboard_markup(bad_effect, ClipboardMarkupKind::Effect).is_err());
    }

    // --- extract_elements_for_copy ---

    #[test]
    fn extract_copies_a_root_level_element_and_does_not_mutate_the_source() {
        let svg = slide(
            r#"<g id="el-a" transform="translate(10 20)"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let before = svg.clone();
        let payload =
            extract_elements_for_copy(&svg, "slides/001.svg", &["el-a".to_string()]).unwrap();
        assert_eq!(payload.elements.len(), 1);
        assert!(payload.elements[0].contains(r#"transform="translate(10 20)""#));
        assert_eq!(payload.source_slide_path, "slides/001.svg");
        assert_eq!(payload.view_box.as_deref(), Some("0 0 1280 720"));
        assert_eq!(svg, before, "copy must not mutate the source document");
    }

    #[test]
    fn extract_folds_the_ancestor_group_transform_into_the_copied_fragment() {
        let svg = slide(
            r#"<g id="outer" transform="translate(100 100)"><g id="el-a" transform="translate(5 5)"><rect x="0" y="0" width="1" height="1"/></g></g>"#,
        );
        let payload =
            extract_elements_for_copy(&svg, "slides/001.svg", &["el-a".to_string()]).unwrap();
        // Folded translate = outer(100,100) composed with own(5,5) = (105, 105).
        assert!(
            payload.elements[0].contains(r#"transform="translate(105 105)""#),
            "{}",
            payload.elements[0]
        );
    }

    #[test]
    fn extract_captures_only_effects_targeting_a_copied_element_or_its_descendant() {
        let svg = slide(&format!(
            r#"<metadata><comot:effects xmlns:comot="{EFFECTS_NS}"><comot:effect target="el-a" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/><comot:effect target="el-b" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/></comot:effects></metadata><g id="el-a"><rect x="0" y="0" width="1" height="1"/></g><g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>"#
        ));
        let payload =
            extract_elements_for_copy(&svg, "slides/001.svg", &["el-a".to_string()]).unwrap();
        assert_eq!(payload.effects.len(), 1);
        assert!(payload.effects[0].contains(r#"target="el-a""#));
    }

    #[test]
    fn extract_missing_element_is_not_found() {
        let svg = slide(r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let err =
            extract_elements_for_copy(&svg, "slides/001.svg", &["nope".to_string()]).unwrap_err();
        assert_eq!(err.message(), "找不到元素：nope");
    }

    // --- serialize / parse round trip ---

    #[test]
    fn serialize_then_parse_round_trips_the_payload() {
        let payload = ClipboardPayload {
            source_slide_path: "slides/001.svg".to_string(),
            elements: vec![
                r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#.to_string(),
            ],
            effects: vec![],
            view_box: Some("0 0 1280 720".to_string()),
        };
        let svg = serialize_clipboard_svg(&payload).unwrap();
        let parsed = parse_clipboard_svg(&svg).unwrap();
        assert_eq!(parsed, payload);
    }

    #[test]
    fn parse_returns_none_for_a_foreign_svg_with_no_clipboard_marker() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>"#;
        assert!(parse_clipboard_svg(svg).is_none());
    }

    #[test]
    fn serialize_falls_back_to_the_placeholder_viewbox_when_the_payload_one_is_malformed() {
        let payload = ClipboardPayload {
            source_slide_path: "slides/001.svg".to_string(),
            elements: vec![],
            effects: vec![],
            view_box: Some(r#"0 0 1 1" onload="fetch(1)"#.to_string()),
        };
        let svg = serialize_clipboard_svg(&payload).unwrap();
        assert!(svg.contains(r#"viewBox="0 0 1280 720""#), "{svg}");
        assert!(!svg.contains("onload"), "{svg}");
    }

    // --- paste_elements ---

    #[test]
    fn paste_regenerates_ids_applies_dx_dy_and_appends_at_the_end() {
        let target = slide(r#"<g id="existing"><rect x="0" y="0" width="1" height="1"/></g>"#);
        let payload = ClipboardPayload {
            source_slide_path: "slides/001.svg".to_string(),
            elements: vec![
                r#"<g id="el-old"><rect x="0" y="0" width="1" height="1"/></g>"#.to_string(),
            ],
            effects: vec![],
            view_box: None,
        };
        let result = paste_elements(
            &target,
            "slides/002.svg",
            &payload,
            10.0,
            20.0,
            ids(&["el-new1"]),
        )
        .unwrap();
        assert_eq!(result.element_ids, vec!["el-new1".to_string()]);
        // The pasted fragment had no existing `transform`, so it is inserted
        // right after the tag name (before `id`) — same insertion point
        // `set_attr_splice` uses elsewhere in this crate.
        assert!(result.updated.ends_with(
            r##"<g transform="translate(10 20)" id="el-new1"><rect x="0" y="0" width="1" height="1"/></g></svg>"##
        ), "{}", result.updated);
        assert!(!result.updated.contains("el-old"));
    }

    #[test]
    fn paste_rewrites_effect_targets_through_the_regenerated_id_map() {
        let target = slide("");
        let payload = ClipboardPayload {
            source_slide_path: "slides/001.svg".to_string(),
            elements: vec![r#"<g id="el-old"><rect x="0" y="0" width="1" height="1"/></g>"#.to_string()],
            effects: vec![
                r#"<comot:effect target="el-old" family="enter" effect="fade" start="on-click" duration="0.4" delay="0"/>"#
                    .to_string(),
            ],
            view_box: None,
        };
        let result = paste_elements(
            &target,
            "slides/001.svg",
            &payload,
            0.0,
            0.0,
            ids(&["el-new1"]),
        )
        .unwrap();
        assert!(
            result.updated.contains(r#"target="el-new1""#),
            "{}",
            result.updated
        );
        assert!(!result.updated.contains("el-old"));
    }

    #[test]
    fn paste_empty_payload_errors() {
        let target = slide("");
        let payload = ClipboardPayload {
            source_slide_path: "slides/001.svg".to_string(),
            elements: vec![],
            effects: vec![],
            view_box: None,
        };
        let err =
            paste_elements(&target, "slides/001.svg", &payload, 0.0, 0.0, ids(&[])).unwrap_err();
        assert_eq!(err.message(), "剪貼簿是空的");
    }

    #[test]
    fn paste_non_finite_dx_dy_errors() {
        let target = slide("");
        let payload = ClipboardPayload {
            source_slide_path: "slides/001.svg".to_string(),
            elements: vec![
                r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#.to_string(),
            ],
            effects: vec![],
            view_box: None,
        };
        let err = paste_elements(
            &target,
            "slides/001.svg",
            &payload,
            f64::NAN,
            0.0,
            ids(&["x"]),
        )
        .unwrap_err();
        assert_eq!(err.message(), "dx/dy 必須是有限數字");
    }

    #[test]
    fn paste_rejects_a_payload_that_fails_sanitization() {
        let target = slide("");
        let payload = ClipboardPayload {
            source_slide_path: "slides/001.svg".to_string(),
            elements: vec![
                r#"<g id="el-a"><rect x="0" y="0" width="1" height="1" onload="x"/></g>"#
                    .to_string(),
            ],
            effects: vec![],
            view_box: None,
        };
        let err =
            paste_elements(&target, "slides/001.svg", &payload, 0.0, 0.0, ids(&["x"])).unwrap_err();
        assert!(
            err.message().contains("不在允許清單內"),
            "{}",
            err.message()
        );
        // Rejected before any write.
        assert_eq!(target, slide(""));
    }

    #[test]
    fn copy_then_paste_round_trips_through_the_system_clipboard_svg_format() {
        let source = slide(
            r#"<g id="el-a" transform="translate(3 4)"><rect x="0" y="0" width="1" height="1"/></g>"#,
        );
        let payload =
            extract_elements_for_copy(&source, "slides/001.svg", &["el-a".to_string()]).unwrap();
        let svg = serialize_clipboard_svg(&payload).unwrap();
        let parsed = parse_clipboard_svg(&svg).unwrap();

        let target = slide("");
        let result = paste_elements(
            &target,
            "slides/002.svg",
            &parsed,
            0.0,
            0.0,
            ids(&["el-new1"]),
        )
        .unwrap();
        assert!(
            result.updated.contains(r#"transform="translate(3 4)""#),
            "{}",
            result.updated
        );
    }
}
