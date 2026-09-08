//! `PageStyle` + `readSlidePageStyle`, ported from
//! `packages/core/src/slide-style.ts`. Only the READ half is ported —
//! `slide/format.rs`'s `SlideModel.page_style` is this ticket's only
//! caller. `setSlidePageStyle` needs `applySplices`/`setAttrSplice` from
//! `element-text.ts`, an editing-history-aware rewrite helper that is a
//! separate, later ticket's port; writing the page style is out of scope
//! here.
//!
//! ## Deviation from the ticket's suggested signature
//!
//! The ticket's guide writes this as `fn read_slide_page_style(svg_content:
//! &str) -> PageStyle` (infallible). The real TS source is NOT infallible:
//! `requireSvgRoot` throws a `CoMotionError` when the document has no
//! `<svg>` root at all (e.g. malformed markup, or markup that scans fine but
//! whose root tag is not `svg`). Swallowing that into a fabricated default
//! `PageStyle` would be exactly the "fallback for invalid input" this port's
//! house style forbids elsewhere (see `errors.rs`, `table_grid.rs`'s own
//! explicit-error stance) — so this port keeps the signature honestly
//! fallible (`CoMotionResult<PageStyle>`) instead of matching the guide
//! literally.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::scan::{ScannedNode, attribute_value, scan_document};

/// CSS property names `readSlidePageStyle`/`setSlidePageStyle` read/write on
/// the root `<svg>`'s own `style` attribute (see that TS module's header
/// comment for why a CSS declaration was chosen over a `data-comot-*`
/// attribute or a background `<rect>`).
const BACKGROUND_PROPERTY: &str = "background-color";
const ACCENT_PROPERTY: &str = "--comot-accent";

/// Ports `requireSvgRoot`. Consumes `scan_document`'s result (rather than
/// borrowing) so the un-matched sibling top-level nodes can drop normally
/// once this function returns — there is exactly one `<svg>` root in any
/// well-formed slide, so this is never expected to discard a large tree.
fn require_svg_root(svg_content: &str) -> CoMotionResult<ScannedNode> {
    let roots = scan_document(svg_content)?;
    roots
        .into_iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
}

/// A slide's Page style (#200 §4.4): background colour and accent colour.
/// `None` means the declaration is absent — never a fabricated default.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PageStyle {
    pub background: Option<String>,
    pub accent: Option<String>,
}

/// Reads `property`'s value out of a `style="a:b;c:d"`-shaped attribute
/// value, ported from `parseStyleDeclarations` + a `Map#get` narrowed to one
/// property (this module never needs to round-trip the whole declaration
/// list back to a string, unlike the TS source's `setSlidePageStyle`, which
/// this port does not implement — see module header comment). Mirrors
/// `Map#set`'s overwrite-on-duplicate-key semantics: the LAST declaration of
/// a repeated property wins, matching `parseStyleDeclarations`'s
/// `declarations.set(...)` inside its `for` loop.
fn declaration_value(style: Option<&str>, property: &str) -> Option<String> {
    let style = style?;
    let mut result = None;
    for part in style.split(';') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let key = trimmed[..colon].trim();
        let value = trimmed[colon + 1..].trim();
        if key == property {
            result = Some(value.to_string());
        }
    }
    result
}

/// Ports `readSlidePageStyle`. See this module's header comment for why the
/// signature is fallible where the ticket's guide suggested it would not be.
pub fn read_slide_page_style(svg_content: &str) -> CoMotionResult<PageStyle> {
    let svg_root = require_svg_root(svg_content)?;
    let style = attribute_value(&svg_root, "style");
    Ok(PageStyle {
        background: declaration_value(style.as_deref(), BACKGROUND_PROPERTY),
        accent: declaration_value(style.as_deref(), ACCENT_PROPERTY),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_background_and_accent_when_both_declared() {
        let svg = r#"<svg viewBox="0 0 100 100" style="background-color:#112233;--comot-accent:#445566"></svg>"#;
        let style = read_slide_page_style(svg).unwrap();
        assert_eq!(
            style,
            PageStyle {
                background: Some("#112233".to_string()),
                accent: Some("#445566".to_string())
            }
        );
    }

    #[test]
    fn no_style_attribute_yields_both_none() {
        let svg = r#"<svg viewBox="0 0 100 100"></svg>"#;
        let style = read_slide_page_style(svg).unwrap();
        assert_eq!(
            style,
            PageStyle {
                background: None,
                accent: None
            }
        );
    }

    #[test]
    fn style_attribute_with_only_one_property_leaves_the_other_none() {
        let svg = r#"<svg viewBox="0 0 100 100" style="background-color:#000000"></svg>"#;
        let style = read_slide_page_style(svg).unwrap();
        assert_eq!(
            style,
            PageStyle {
                background: Some("#000000".to_string()),
                accent: None
            }
        );
    }

    #[test]
    fn missing_svg_root_errors() {
        let err = read_slide_page_style(r#"<g id="a"/>"#).unwrap_err();
        assert!(err.message().contains("根節點不是 <svg>"));
    }
}
