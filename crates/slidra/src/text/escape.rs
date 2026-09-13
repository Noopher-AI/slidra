// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! XML escaping for text content and attribute values embedded in
//! `<tspan>`/`<text>` markup.
//!
//! In the TypeScript source these three functions (`escapeXmlText`,
//! `unescapeXmlText`, `escapeXmlAttr`) do NOT live under
//! `packages/core/src/text/` — there is no `text/escape.ts`. They live in
//! `packages/core/src/element-text.ts`, and `packages/core/src/text/render.ts`
//! / `packages/core/src/text/runs.ts` both import them from there rather than
//! duplicating the rule (`element-text.ts`'s own header comment calls this
//! out explicitly: "one escaping rule, same as one measurement implementation
//! and one rounding rule"). `element-text.ts` is a large SVG-splice module
//! that is otherwise out of this ticket's scope (it is not in the file list
//! this ticket ports), so only these three functions are pulled out of it —
//! into this file, under the Rust `text/` tree that `render.rs` and `runs.rs`
//! actually live in — rather than porting the whole module.
//!
//! Ported verbatim from `packages/core/src/element-text.ts` lines 44-75.

/// Escapes the three characters XML character data requires escaped.
/// Order matters: `&` first, so the `&` it inserts for `<`/`>` below is
/// never itself re-escaped.
pub fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `escape_xml_text`'s exact inverse, for the three entities this codebase
/// ever writes into character data. `&amp;` is decoded last, deliberately:
/// decoding it first would turn a literal `&lt;` typed by an author (encoded
/// as `&amp;lt;`) into `<` instead of leaving it as the four literal
/// characters it was.
///
/// Only these three entities are recognised. A hand-authored SVG using a
/// different named entity (`&quot;`, `&apos;`) or a numeric character
/// reference (`&#65;`) in element text content is out of this function's
/// scope — nothing this codebase's own write paths ever produce needs one.
pub fn unescape_xml_text(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// `escape_xml_text` plus quoting, for building a double-quoted attribute
/// value from caller-supplied text.
pub fn escape_xml_attr(value: &str) -> String {
    escape_xml_text(value).replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_amp_lt_gt_in_that_order() {
        assert_eq!(escape_xml_text("a & b < c > d"), "a &amp; b &lt; c &gt; d");
    }

    #[test]
    fn escaping_does_not_double_escape_the_ampersand_it_inserts() {
        // A literal "<" becomes "&lt;"; the "&" that step introduces must
        // not be escaped again by a later pass.
        assert_eq!(escape_xml_text("<"), "&lt;");
    }

    #[test]
    fn unescape_is_exact_inverse_of_escape_for_plain_text() {
        let original = "5 < 10 & 10 > 5";
        assert_eq!(unescape_xml_text(&escape_xml_text(original)), original);
    }

    #[test]
    fn unescape_decodes_amp_last_so_literal_amp_lt_survives() {
        // An author who typed the literal four characters "&lt;" gets them
        // escaped once to "&amp;lt;"; decoding must reproduce exactly "&lt;",
        // not "<".
        assert_eq!(unescape_xml_text("&amp;lt;"), "&lt;");
    }

    #[test]
    fn escape_attr_also_escapes_double_quotes() {
        assert_eq!(
            escape_xml_attr(r#"say "hi" & <bye>"#),
            "say &quot;hi&quot; &amp; &lt;bye&gt;"
        );
    }
}
