// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! A hand-written, offset-carrying SVG scanner, ported from
//! `packages/core/src/slide/scan.ts` (the one SVG scanner in the TS
//! codebase, per that file's own header comment — every module that needs
//! to know what elements a slide document contains goes through
//! `scan_document`).
//!
//! ## Rules it follows (ported exactly, not simplified)
//!
//! 1. `<!-- -->`, `<![CDATA[ ]]>`, `<? ?>` and `<!DOCTYPE [...]>` are always
//!    skipped to their proper terminator, so markup written inside them is
//!    never read as markup. The `DOCTYPE` internal subset needs bracket-depth
//!    counting (`[`/`]`) because only a `>` seen at depth <= 0 ends it.
//! 2. Quote state is tracked while looking for a tag's `>`, so a `>` inside
//!    a quoted value (`d="M10 10 L20>20"`) never ends the tag early.
//! 3. The attribute region is tokenised character by character into
//!    name/value pairs, never searched as text — `data-note=' id="el-a"'`
//!    contains a value, not an `id` attribute.
//! 4. Syntax it cannot make sense of returns `SlidraError::invalid`. It
//!    never guesses.
//!
//! When a tag carries more than one attribute of the same name, `attribute_of`
//! resolves to the *first* one (document order) — every TS caller relies on
//! this same first-wins rule, and this port preserves it.
//!
//! ## The UTF-16 index space (critical, load-bearing — read before touching offsets)
//!
//! Every offset here (`ScannedNode::start`/`end`/`content_start`/`content_end`,
//! `ScannedAttribute::start`/`end`, and the `offset` parameter to
//! `position_at`) is a **UTF-16 code-unit offset**, exactly what JavaScript's
//! `String#length` / `String#slice` use in `scan.ts` — NOT a Rust byte
//! offset and NOT a `char` (Unicode scalar value) count. This is not a free
//! choice made independently in this file: `crate::text::runs` already
//! documents, at length, that its placeholder `ScannedNode` and `TextRun`
//! share this exact index space and depends on it being preserved when "the
//! real `slide::scan` module lands" (its words) — this *is* that module, so
//! it must produce numbers in the same space.
//!
//! Concretely: a 3-byte UTF-8 CJK character (common in this codebase's
//! Traditional-Chinese attribute values and text content) is ONE UTF-16 code
//! unit but THREE UTF-8 bytes; a 4-byte UTF-8 astral character is ONE Rust
//! `char` but TWO UTF-16 code units. Reporting raw Rust byte offsets, or
//! `char_indices()` counts, would silently disagree with every TS-produced
//! offset — and with every sibling Rust module already built against the
//! UTF-16 contract — for any document containing such a character before the
//! point being measured. See `Utf16Tracker` below for how this is computed
//! without making the whole scan O(n²).
//!
//! Internally, all actual string operations (finding delimiters, slicing tag
//! names/attribute values) still use Rust byte offsets, because that is what
//! `&str` indexing requires; `Utf16Tracker::at` is the single place a byte
//! offset is turned into the UTF-16 offset that actually gets stored in a
//! public field.

use crate::errors::{SlidraError, SlidraResult};

/// One attribute, with the UTF-16 code-unit span it occupies inside the
/// document (see the module doc comment's "UTF-16 index space" section).
#[derive(Debug)]
pub struct ScannedAttribute {
    pub name: String,
    pub value: String,
    /// Offset of the first character of the attribute name.
    pub start: usize,
    /// Offset just past the attribute value's closing quote.
    pub end: usize,
}

#[derive(Debug)]
pub struct ScannedNode {
    /// Tag name exactly as written.
    pub tag: String,
    pub attributes: Vec<ScannedAttribute>,
    /// Offset of the element's opening `<`.
    pub start: usize,
    /// Offset just past the element's last character (`>` of the close tag,
    /// or of the self-closing tag).
    pub end: usize,
    /// Offset just past the opening tag's `>`. Equals `end` for a
    /// self-closing element.
    pub content_start: usize,
    /// Offset of the closing tag's `<`. Equals `end` for a self-closing
    /// element.
    pub content_end: usize,
    pub self_closing: bool,
    pub children: Vec<ScannedNode>,
}

impl Drop for ScannedNode {
    /// The compiler-derived drop glue for a tree type recurses one native
    /// stack frame per nesting level. `scan_document` is required to handle
    /// a 100,000-level-deep document without overflowing the stack (SVG
    /// content is untrusted input, ADR-0010) — making the *parser* iterative
    /// (see `scan_document` below) accomplishes nothing if the *tree it
    /// hands back* then blows the stack the moment it is dropped. This
    /// flattens teardown onto an explicit heap-allocated stack instead, so
    /// dropping a 100,000-deep single-child chain costs one heap `Vec` and a
    /// loop, not 100,000 stack frames. See the `deeply_nested_*` tests.
    fn drop(&mut self) {
        let mut pending: Vec<ScannedNode> = std::mem::take(&mut self.children);
        while let Some(mut node) = pending.pop() {
            // Move `node`'s own children onto the shared work list before
            // `node` itself is dropped at the end of this loop iteration.
            // Its `Drop::drop` (this same function) then runs on an
            // already-empty `children`, so the recursion the compiler
            // inserts for that nested call bottoms out in one step instead
            // of diving into a full subtree.
            pending.append(&mut node.children);
        }
    }
}

/// Resolves to the *first* attribute named `name` in document order — every
/// caller in this codebase (ported along with everything else) depends on
/// this exact tie-break when a tag carries a duplicate attribute name.
pub fn attribute_of<'a>(element: &'a ScannedNode, name: &str) -> Option<&'a ScannedAttribute> {
    element
        .attributes
        .iter()
        .find(|attribute| attribute.name == name)
}

pub fn attribute_value(element: &ScannedNode, name: &str) -> Option<String> {
    attribute_of(element, name).map(|attribute| attribute.value.clone())
}

/// 1-based line and column of a UTF-16 code-unit document offset, for error
/// messages — ports `positionAt` from scan.ts. `offset` is in the same
/// UTF-16 index space as every other offset in this module (see the module
/// doc comment); it is walked by iterating `svg`'s `char`s and advancing by
/// `char::len_utf16()` rather than by byte, which is what makes this
/// consistent with the rest of the file for non-ASCII input.
///
/// Mirrors scan.ts's `positionAt` exactly, including reading `offset`
/// un-clamped for the final column subtraction even though the walk itself
/// stops at `svg`'s length if `offset` overruns it — matching TS's
/// `i < offset && i < svg.length` loop guard plus its un-clamped
/// `offset - lineStart + 1` result.
pub fn position_at(svg: &str, offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut line_start = 0usize;
    let mut utf16_pos = 0usize;
    for ch in svg.chars() {
        if utf16_pos >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            line_start = utf16_pos + 1;
        }
        utf16_pos += ch.len_utf16();
    }
    (line, offset - line_start + 1)
}

/// Exactly the four characters scan.ts's `XML_WHITESPACE` regex matches —
/// deliberately not `char::is_whitespace()`, which is Unicode-aware and
/// would accept characters (NBSP, U+3000 full-width space, ...) that the TS
/// source's `/[\t\n\r ]/` never does.
fn is_xml_whitespace(ch: char) -> bool {
    matches!(ch, '\t' | '\n' | '\r' | ' ')
}

/// Ports the TS tag-name character class `/[\w:.-]/`. JS `\w` without the
/// `u` flag is ASCII-only (`[A-Za-z0-9_]`), so this is deliberately
/// `is_ascii_alphanumeric` plus `_:.-`, not a Unicode identifier class.
fn is_tag_name_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '.' | '-')
}

/// The character at Rust byte offset `byte_pos`, or `None` past the end —
/// used in place of raw `&svg[byte_pos..]` indexing so a byte offset that
/// (through a bug elsewhere) lands off a char boundary or past `svg.len()`
/// fails soft instead of panicking. Untrusted SVG input (ADR-0010) should
/// never turn into a panic anywhere in this module, even from a bug this
/// review didn't already catch.
fn char_at(svg: &str, byte_pos: usize) -> Option<char> {
    svg.get(byte_pos..)?.chars().next()
}

fn starts_with_at(svg: &str, byte_pos: usize, pat: &str) -> bool {
    match svg.get(byte_pos..) {
        Some(rest) => rest.starts_with(pat),
        None => false,
    }
}

/// `svg.indexOf(pat, from)`, byte-offset flavour — `pat` is always an ASCII
/// literal in every call site here, so a byte-level `str::find` is exactly
/// equivalent to the TS original's UTF-16 `indexOf` (an ASCII substring
/// match lands at the same relative position in either encoding).
fn find_from(svg: &str, from: usize, pat: &str) -> Option<usize> {
    svg.get(from..)?.find(pat).map(|p| from + p)
}

fn find_char_from(svg: &str, from: usize, ch: char) -> Option<usize> {
    svg.get(from..)?.find(ch).map(|p| from + p)
}

/// Tracks the correspondence between the scanner's forward-moving Rust byte
/// position and the UTF-16 code-unit offset that position corresponds to, so
/// every public field can be filled in with a UTF-16 offset in O(1)
/// amortized work rather than by re-walking the document from byte 0 (which
/// would be correct but O(n) *per lookup*, i.e. O(n²) over a whole document —
/// exactly the kind of blow-up the 100,000-nesting requirement is guarding
/// against, just relocated from the parser into offset bookkeeping instead).
///
/// Sound only under one invariant: every byte offset passed to `at` is >=
/// the byte offset passed to the previous call. `scan_document`'s single
/// left-to-right pass over the input never needs to look backwards, so this
/// always holds in practice; the `debug_assert!` exists to catch a future
/// change that breaks it, not because it is expected to fire.
struct Utf16Tracker {
    byte: usize,
    utf16: usize,
}

impl Utf16Tracker {
    fn new() -> Self {
        Utf16Tracker { byte: 0, utf16: 0 }
    }

    fn at(&mut self, svg: &str, new_byte: usize) -> usize {
        debug_assert!(
            new_byte >= self.byte,
            "Utf16Tracker must only move forward: {new_byte} < {}",
            self.byte
        );
        if new_byte > self.byte {
            self.utf16 += svg[self.byte..new_byte].encode_utf16().count();
            self.byte = new_byte;
        }
        self.utf16
    }
}

/// `describe`: `第 N 行第 M 欄` ("line N column M") for the UTF-16 offset
/// corresponding to `byte_pos`.
fn describe(svg: &str, tracker: &mut Utf16Tracker, byte_pos: usize) -> String {
    let (line, column) = position_at(svg, tracker.at(svg, byte_pos));
    format!("line {line}, column {column}")
}

/// Rule 1: skip a `<!...>` / `<?...>` construct, returning the Rust byte
/// offset just past it, or `None` if it is never terminated.
fn skip_non_element_construct(svg: &str, i: usize) -> Option<usize> {
    if starts_with_at(svg, i, "<!--") {
        return find_from(svg, i + 4, "-->").map(|end| end + 3);
    }
    if starts_with_at(svg, i, "<![CDATA[") {
        return find_from(svg, i + 9, "]]>").map(|end| end + 3);
    }
    if char_at(svg, i + 1) == Some('?') {
        return find_from(svg, i + 2, "?>").map(|end| end + 2);
    }
    // `<!DOCTYPE ...>`, possibly with an internal subset `[...]`; only a
    // `>` seen at bracket depth <= 0 ends it.
    let mut k = i + 2;
    let mut depth: i32 = 0;
    loop {
        let ch = char_at(svg, k)?;
        if ch == '[' {
            depth += 1;
        } else if ch == ']' {
            depth -= 1;
        } else if ch == '>' && depth <= 0 {
            return Some(k + ch.len_utf8());
        }
        k += ch.len_utf8();
    }
}

/// Rule 3: tokenise an attribute region `[from, to)` (Rust byte offsets)
/// into name/value pairs with UTF-16 offsets.
fn scan_attributes(
    svg: &str,
    tracker: &mut Utf16Tracker,
    from: usize,
    to: usize,
) -> SlidraResult<Vec<ScannedAttribute>> {
    let mut attributes = Vec::new();
    let mut i = from;
    while i < to {
        while i < to {
            match char_at(svg, i) {
                Some(c) if is_xml_whitespace(c) => i += c.len_utf8(),
                _ => break,
            }
        }
        if i >= to {
            break;
        }

        let name_start = i;
        while i < to {
            match char_at(svg, i) {
                Some(c) if !is_xml_whitespace(c) && c != '=' => i += c.len_utf8(),
                _ => break,
            }
        }
        let name = svg[name_start..i].to_string();
        if name.is_empty() {
            return Err(SlidraError::invalid(
                "attribute syntax error: cannot parse attribute name",
            ));
        }

        while i < to {
            match char_at(svg, i) {
                Some(c) if is_xml_whitespace(c) => i += c.len_utf8(),
                _ => break,
            }
        }
        // Deliberately unbounded read (no `i < to` guard), matching
        // scan.ts's `svg[i] !== "="` exactly: if the region ends right after
        // the attribute name, this reads whatever real character follows
        // the region (the tag's own `>` or `/`), which is never `=`, so it
        // still produces the right error — just like the TS original.
        if char_at(svg, i) != Some('=') {
            return Err(SlidraError::invalid(format!(
                "attribute syntax error: attribute {name} is missing ="
            )));
        }
        i += 1; // '=' is one ASCII byte

        while i < to {
            match char_at(svg, i) {
                Some(c) if is_xml_whitespace(c) => i += c.len_utf8(),
                _ => break,
            }
        }
        // Unbounded read again, same reasoning as the `=` check above.
        let quote = char_at(svg, i);
        if quote != Some('"') && quote != Some('\'') {
            return Err(SlidraError::invalid(format!(
                "attribute syntax error: value of attribute {name} is not quoted"
            )));
        }
        let quote = quote.expect("just matched Some(_) above");
        i += 1; // the quote character is one ASCII byte

        let value_start = i;
        while i < to && char_at(svg, i) != Some(quote) {
            i += char_at(svg, i).map(|c| c.len_utf8()).unwrap_or(1);
        }
        if i >= to {
            return Err(SlidraError::invalid(format!(
                "attribute syntax error: quote of attribute {name} is not closed"
            )));
        }
        let value = svg[value_start..i].to_string();
        let start = tracker.at(svg, name_start);
        let end = tracker.at(svg, i + 1);
        attributes.push(ScannedAttribute {
            name,
            value,
            start,
            end,
        });
        i += 1; // skip the closing quote (one ASCII byte)
    }
    Ok(attributes)
}

/// An opening tag's parse result, still in Rust byte offsets except for
/// `content_start_utf16`, which is resolved before returning so the caller
/// never needs to convert a byte position smaller than one it has already
/// converted (see `Utf16Tracker`'s forward-only invariant).
struct OpenTag {
    tag: String,
    attributes: Vec<ScannedAttribute>,
    self_closing: bool,
    /// Rust byte offset just past the opening tag's `>` — used to keep
    /// scanning for the next `<`.
    content_start_byte: usize,
    content_start_utf16: usize,
}

/// Rule 2: find the opening tag's `>` with quote tracking, then tokenise its
/// attributes (rule 3). `start` is the Rust byte offset of the tag's `<`.
fn read_open_tag(svg: &str, tracker: &mut Utf16Tracker, start: usize) -> SlidraResult<OpenTag> {
    let mut j = start + 1;
    while let Some(ch) = char_at(svg, j) {
        if is_tag_name_char(ch) {
            j += ch.len_utf8();
        } else {
            break;
        }
    }
    let tag = svg[start + 1..j].to_string();
    if tag.is_empty() {
        return Err(SlidraError::invalid(format!(
            "markup syntax error: {} is not a valid tag",
            describe(svg, tracker, start)
        )));
    }

    let mut k = j;
    let mut quote: Option<char> = None;
    let mut found_close = false;
    while let Some(ch) = char_at(svg, k) {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
        } else if ch == '>' {
            found_close = true;
            break;
        }
        k += ch.len_utf8();
    }
    if !found_close {
        return Err(SlidraError::invalid(format!(
            "markup syntax error: {}'s <{}> tag has no closing >",
            describe(svg, tracker, start),
            tag
        )));
    }

    // `k` is the byte offset of '>', which is exactly one ASCII byte, so
    // checking the raw byte at `k - 1` is safe and correct regardless of
    // what multi-byte character (if any) precedes it: an ASCII byte value
    // can never appear as part of a different UTF-8 character's encoding.
    let self_closing = k > 0 && svg.as_bytes()[k - 1] == b'/';
    let attr_region_end = if self_closing { k - 1 } else { k };
    let attributes = scan_attributes(svg, tracker, j, attr_region_end)?;

    let content_start_byte = k + 1;
    let content_start_utf16 = tracker.at(svg, content_start_byte);
    Ok(OpenTag {
        tag,
        attributes,
        self_closing,
        content_start_byte,
        content_start_utf16,
    })
}

/// A still-open ancestor element, tracked on an explicit stack instead of
/// via native recursion (see `scan_document`'s doc comment). Offsets here
/// are already resolved to UTF-16.
struct OpenFrame {
    tag: String,
    attributes: Vec<ScannedAttribute>,
    start: usize,
    content_start: usize,
    children: Vec<ScannedNode>,
}

fn push_completed_node(
    stack: &mut [OpenFrame],
    top_nodes: &mut Vec<ScannedNode>,
    node: ScannedNode,
) {
    match stack.last_mut() {
        Some(frame) => frame.children.push(node),
        None => top_nodes.push(node),
    }
}

/// Scans the whole document into a tree of elements carrying UTF-16
/// code-unit offsets (see the module doc comment). Text, comments, CDATA,
/// processing instructions and declarations are not represented — only
/// elements are.
///
/// scan.ts's `scanNodes` recurses once per nesting level, which is fine in
/// JS's much larger default stack but is exactly the kind of thing that
/// overflows Rust's default 8MB thread stack on adversarial input (SVG
/// content is untrusted, ADR-0010: a 100,000-level-deep document is a
/// realistic attack, not a hypothetical). This port replaces that recursion
/// with an explicit `Vec<OpenFrame>` stack: pushing a frame is "recurse into
/// this element's children", popping one (on its matching close tag) is
/// "return from that call". See also `ScannedNode`'s custom `Drop` impl —
/// making the *parse* iterative does not by itself make *dropping the
/// resulting tree* safe, since the default derive-free drop glue for a
/// `Vec<ScannedNode>` full of nested `Vec<ScannedNode>` is itself recursive.
pub fn scan_document(svg: &str) -> SlidraResult<Vec<ScannedNode>> {
    let mut tracker = Utf16Tracker::new();
    let mut stack: Vec<OpenFrame> = Vec::new();
    let mut top_nodes: Vec<ScannedNode> = Vec::new();
    let mut search_from: usize = 0;

    loop {
        let i = match find_char_from(svg, search_from, '<') {
            Some(pos) => pos,
            None => {
                if let Some(frame) = stack.last() {
                    // No `describe()` here either — scan.ts's own message
                    // for this case carries no position.
                    return Err(SlidraError::invalid(format!(
                        "markup syntax error: <{}> has no matching closing tag",
                        frame.tag
                    )));
                }
                break;
            }
        };

        let marker = char_at(svg, i + 1);

        if marker == Some('!') || marker == Some('?') {
            match skip_non_element_construct(svg, i) {
                Some(next) => {
                    search_from = next;
                    continue;
                }
                None => {
                    return Err(SlidraError::invalid(format!(
                        "markup syntax error: comment or declaration in {} has no end",
                        describe(svg, &mut tracker, i)
                    )));
                }
            }
        }

        if marker == Some('/') {
            let close_end = match find_char_from(svg, i + 2, '>') {
                Some(p) => p,
                None => {
                    return Err(SlidraError::invalid(format!(
                        "markup syntax error: closing tag in {} has no closing >",
                        describe(svg, &mut tracker, i)
                    )));
                }
            };
            let closing_name = svg[i + 2..close_end].trim();

            if stack.is_empty() {
                return Err(SlidraError::invalid(format!(
                    "markup syntax error: {} has an extra closing tag",
                    describe(svg, &mut tracker, i)
                )));
            }
            let expected_tag = stack.last().expect("checked non-empty above").tag.clone();
            if closing_name != expected_tag {
                return Err(SlidraError::invalid(format!(
                    "markup syntax error: closing tag in {} is </{}>, but the currently open tag is <{}>",
                    describe(svg, &mut tracker, i),
                    closing_name,
                    expected_tag
                )));
            }

            let frame = stack.pop().expect("checked non-empty above");
            let content_end = tracker.at(svg, i);
            let end = tracker.at(svg, close_end + 1);
            let node = ScannedNode {
                tag: frame.tag,
                attributes: frame.attributes,
                start: frame.start,
                end,
                content_start: frame.content_start,
                content_end,
                self_closing: false,
                children: frame.children,
            };
            push_completed_node(&mut stack, &mut top_nodes, node);
            search_from = close_end + 1;
            continue;
        }

        // An opening tag. Convert `i` (the smallest byte offset touched by
        // this iteration) to UTF-16 before descending into `read_open_tag`,
        // which will only ever convert larger byte offsets from here on —
        // preserving `Utf16Tracker`'s forward-only invariant.
        let start_utf16 = tracker.at(svg, i);
        let open = read_open_tag(svg, &mut tracker, i)?;

        if open.self_closing {
            let node = ScannedNode {
                tag: open.tag,
                attributes: open.attributes,
                start: start_utf16,
                end: open.content_start_utf16,
                content_start: open.content_start_utf16,
                content_end: open.content_start_utf16,
                self_closing: true,
                children: Vec::new(),
            };
            push_completed_node(&mut stack, &mut top_nodes, node);
        } else {
            stack.push(OpenFrame {
                tag: open.tag,
                attributes: open.attributes,
                start: start_utf16,
                content_start: open.content_start_utf16,
                children: Vec::new(),
            });
        }
        search_from = open.content_start_byte;
    }

    Ok(top_nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_message(svg: &str) -> String {
        scan_document(svg)
            .expect_err("expected a parse error")
            .message()
            .to_string()
    }

    // --- happy path: structure and offsets (verified against a
    // line-by-line Python re-implementation of scan.ts's own algorithm,
    // not against this Rust port, so the expected numbers are independent
    // of any bug this file might share with a careless translation) ---

    #[test]
    fn parses_nested_elements_with_attributes_and_exact_offsets() {
        let svg = r#"<svg><rect id="a" width="10"/></svg>"#;
        let nodes = scan_document(svg).unwrap();
        assert_eq!(nodes.len(), 1);

        let root = &nodes[0];
        assert_eq!(root.tag, "svg");
        assert!(!root.self_closing);
        assert_eq!(
            (root.start, root.content_start, root.content_end, root.end),
            (0, 5, 30, 36)
        );
        assert_eq!(root.children.len(), 1);

        let rect = &root.children[0];
        assert_eq!(rect.tag, "rect");
        assert!(rect.self_closing);
        assert_eq!(
            (rect.start, rect.content_start, rect.content_end, rect.end),
            (5, 30, 30, 30)
        );
        assert_eq!(attribute_value(rect, "id"), Some("a".to_string()));
        assert_eq!(attribute_value(rect, "width"), Some("10".to_string()));
        assert_eq!(attribute_value(rect, "missing"), None);

        let id_attr = attribute_of(rect, "id").unwrap();
        assert_eq!((id_attr.start, id_attr.end), (11, 17));
        let width_attr = attribute_of(rect, "width").unwrap();
        assert_eq!((width_attr.start, width_attr.end), (18, 28));
    }

    #[test]
    fn self_closing_tag_has_matching_offsets_and_no_children() {
        let nodes = scan_document("<foo/>").unwrap();
        let node = &nodes[0];
        assert!(node.self_closing);
        assert_eq!(node.end, node.content_start);
        assert_eq!(node.content_start, node.content_end);
        assert!(node.children.is_empty());
    }

    #[test]
    fn duplicate_attribute_name_resolves_to_the_first_occurrence() {
        let nodes = scan_document(r#"<a id="1" id="2"/>"#).unwrap();
        assert_eq!(attribute_value(&nodes[0], "id"), Some("1".to_string()));
    }

    // --- rule 2 & 3: quote handling ---

    #[test]
    fn greater_than_inside_a_quoted_attribute_value_does_not_end_the_tag() {
        let svg = r#"<path d="M10 10 L20>20" />"#;
        let nodes = scan_document(svg).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            attribute_value(&nodes[0], "d"),
            Some("M10 10 L20>20".to_string())
        );
    }

    #[test]
    fn quoted_value_with_an_embedded_pseudo_attribute_is_one_attribute_not_two() {
        // A naive text/regex search over the attribute region would find an
        // `id="el-a"`-looking fragment inside the value; the character-by-
        // character scan (rule 3) must not.
        let svg = r#"<text data-note=' id="el-a"'/>"#;
        let nodes = scan_document(svg).unwrap();
        let node = &nodes[0];
        assert_eq!(node.attributes.len(), 1);
        assert_eq!(node.attributes[0].name, "data-note");
        assert_eq!(node.attributes[0].value, r#" id="el-a""#);
        assert_eq!(attribute_value(node, "id"), None);
    }

    // --- malformed input: each error path from the ticket's required list,
    // each pre-verified against a faithful Python re-implementation of the
    // exact scan.ts algorithm (including the `describe`/`positionAt`
    // helpers) so the fixture is known to exercise the intended branch and
    // not, say, a different error raised earlier in the scan. ---

    #[test]
    fn unclosed_comment_is_an_error() {
        assert!(err_message("<a><!-- never closed</a>").contains("comment or declaration in"));
    }

    #[test]
    fn unclosed_cdata_is_an_error() {
        assert!(err_message("<a><![CDATA[ never closed</a>").contains("comment or declaration in"));
    }

    #[test]
    fn unclosed_start_tag_missing_gt_is_an_error() {
        assert!(err_message(r#"<a bar="1""#).contains("has no closing >"));
    }

    #[test]
    fn mismatched_end_tag_name_is_an_error() {
        let message = err_message("<a></b>");
        assert!(message.contains("closing tag in"));
        assert!(message.contains("</b>"));
        assert!(message.contains("<a>"));
    }

    #[test]
    fn stray_end_tag_at_top_level_is_an_error() {
        assert!(err_message("<a></a></a>").contains("extra closing tag"));
    }

    #[test]
    fn attribute_missing_equals_is_an_error() {
        assert!(err_message("<a bar/>").contains("missing ="));
    }

    #[test]
    fn attribute_value_without_quotes_is_an_error() {
        assert!(err_message("<a bar=1/>").contains("not quoted"));
    }

    #[test]
    fn unterminated_quoted_attribute_value_is_an_error() {
        // Constructed and verified against a Python port of scan.ts's exact
        // state machine (not guessed): read_open_tag's own quote-tracking
        // `>`-search treats the bare `"` right after the tag name as
        // *opening* a quote (rules 2 and 3 track quotes identically, with
        // no notion of "inside a name" vs "inside a value" — that's the
        // whole state machine, character by character). By the time
        // `scan_attributes` re-walks the same bytes with its own name/value
        // split, the attribute "name" it recovers is the literal `"`
        // character, and the value it starts reading immediately hits the
        // region boundary before finding a matching close quote.
        assert!(err_message(r#"<a "="/>"#).contains("is not closed"));
    }

    #[test]
    fn empty_attribute_name_is_an_error() {
        assert!(err_message(r#"<a ="x"/>"#).contains("cannot parse attribute name"));
    }

    // --- UTF-16 offset semantics (the load-bearing behavior this file's
    // doc comment describes at length) ---

    #[test]
    fn offsets_are_utf16_code_units_not_utf8_bytes() {
        let prefix = r#"<a note="測試"/>"#; // 2 CJK chars: 1 UTF-16 unit / 3 UTF-8 bytes each
        let svg = format!("{prefix}<b/>");
        let nodes = scan_document(&svg).unwrap();
        assert_eq!(nodes.len(), 2);

        let expected_utf16_start = prefix.encode_utf16().count();
        assert_eq!(nodes[1].start, expected_utf16_start);
        // The whole point of the test: for non-ASCII input, the UTF-16
        // count and the UTF-8 byte length genuinely differ, so this is not
        // a tautology that would pass under either interpretation.
        assert_ne!(expected_utf16_start, prefix.len());
    }

    #[test]
    fn position_at_is_one_based_and_advances_on_newlines() {
        let svg = "ab\ncd";
        assert_eq!(position_at(svg, 0), (1, 1));
        assert_eq!(position_at(svg, 2), (1, 3)); // the '\n' itself
        assert_eq!(position_at(svg, 3), (2, 1)); // right after the '\n'
        assert_eq!(position_at(svg, 5), (2, 3)); // one past the end
    }

    // --- deep nesting must not overflow the stack, in either direction:
    // parsing it (scan_document's own iterative design) and dropping the
    // resulting tree (ScannedNode's custom Drop impl). ---

    fn nested_g_svg(depth: usize) -> String {
        let mut svg = String::with_capacity(depth * 7);
        for _ in 0..depth {
            svg.push_str("<g>");
        }
        for _ in 0..depth {
            svg.push_str("</g>");
        }
        svg
    }

    #[test]
    fn deeply_nested_100_000_elements_parses_to_the_exact_depth() {
        const DEPTH: usize = 100_000;
        let svg = nested_g_svg(DEPTH);
        let mut nodes = scan_document(&svg).expect("well-formed deeply nested input must parse");

        let mut depth = 0usize;
        // A recursive walk here would defeat the point of the test even if
        // `scan_document` itself is iterative — so this counts depth with a
        // plain loop, peeling one level of ownership off at a time (which
        // also means each peeled-off shell drops with empty `children`,
        // i.e. this loop does not exercise `ScannedNode`'s custom `Drop`;
        // see the next test for that).
        loop {
            depth += 1;
            assert_eq!(nodes.len(), 1);
            assert_eq!(nodes[0].tag, "g");
            if nodes[0].children.is_empty() {
                break;
            }
            nodes = std::mem::take(&mut nodes[0].children);
        }
        assert_eq!(depth, DEPTH);
    }

    #[test]
    fn deeply_nested_result_drops_without_overflowing_the_stack() {
        const DEPTH: usize = 100_000;
        let svg = nested_g_svg(DEPTH);
        let nodes = scan_document(&svg).expect("well-formed deeply nested input must parse");
        // Dropping the whole tree at once, instead of peeling it apart
        // level by level, is exactly what would overflow the stack under
        // the compiler's default (non-custom) drop glue — this line is the
        // actual assertion; if `ScannedNode`'s `Drop` impl were removed,
        // this test would crash the test process rather than fail an
        // `assert!`.
        drop(nodes);
    }
}
