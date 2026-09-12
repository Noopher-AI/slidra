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
//! `requireSvgRoot` throws a `SlidraError` when the document has no
//! `<svg>` root at all (e.g. malformed markup, or markup that scans fine but
//! whose root tag is not `svg`). Swallowing that into a fabricated default
//! `PageStyle` would be exactly the "fallback for invalid input" this port's
//! house style forbids elsewhere (see `errors.rs`, `table_grid.rs`'s own
//! explicit-error stance) — so this port keeps the signature honestly
//! fallible (`SlidraResult<PageStyle>`) instead of matching the guide
//! literally.

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::splice::{Splice, apply_splices, set_attr_splice};
use crate::text::runs::utf16_offset_to_byte_offset;

/// CSS property names `readSlidePageStyle`/`setSlidePageStyle` read/write on
/// the root `<svg>`'s own `style` attribute (see that TS module's header
/// comment for why a CSS declaration was chosen over a `data-slidra-*`
/// attribute or a background `<rect>`).
const BACKGROUND_PROPERTY: &str = "background-color";
const ACCENT_PROPERTY: &str = "--slidra-accent";

/// Ports `requireSvgRoot`. Consumes `scan_document`'s result (rather than
/// borrowing) so the un-matched sibling top-level nodes can drop normally
/// once this function returns — there is exactly one `<svg>` root in any
/// well-formed slide, so this is never expected to discard a large tree.
fn require_svg_root(svg_content: &str) -> SlidraResult<ScannedNode> {
    let roots = scan_document(svg_content)?;
    roots
        .into_iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("投影片的根節點不是 <svg>"))
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
pub fn read_slide_page_style(svg_content: &str) -> SlidraResult<PageStyle> {
    let svg_root = require_svg_root(svg_content)?;
    let style = attribute_value(&svg_root, "style");
    Ok(PageStyle {
        background: declaration_value(style.as_deref(), BACKGROUND_PROPERTY),
        accent: declaration_value(style.as_deref(), ACCENT_PROPERTY),
    })
}

/// `slidra slide style set`'s update input. `None` leaves that axis
/// untouched; `Some("")` clears the declaration; `Some(value)` sets it.
#[derive(Debug, Clone, Default)]
pub struct PageStyleUpdate {
    pub background: Option<String>,
    pub accent: Option<String>,
}

/// Parses `style="a:b;c:d"` into an ordered list of declarations, later
/// occurrences of the same property overwriting the value in place (mirrors
/// JS `Map#set`'s overwrite-on-duplicate-key semantics: the key keeps its
/// first-seen position, the value is whatever was assigned last).
fn parse_style_declarations(style: Option<&str>) -> Vec<(String, String)> {
    let mut declarations: Vec<(String, String)> = Vec::new();
    let Some(style) = style else {
        return declarations;
    };
    for part in style.split(';') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let key = trimmed[..colon].trim().to_string();
        let value = trimmed[colon + 1..].trim().to_string();
        if let Some(existing) = declarations.iter_mut().find(|(k, _)| *k == key) {
            existing.1 = value;
        } else {
            declarations.push((key, value));
        }
    }
    declarations
}

fn serialize_style_declarations(declarations: &[(String, String)]) -> String {
    declarations
        .iter()
        .map(|(property, value)| format!("{property}:{value}"))
        .collect::<Vec<_>>()
        .join(";")
}

/// Sets/clears the root `<svg>`'s Page style (`slidra slide style set`).
/// At least one of `background`/`accent` must be given.
pub fn set_slide_page_style(svg_content: &str, update: &PageStyleUpdate) -> SlidraResult<String> {
    if update.background.is_none() && update.accent.is_none() {
        return Err(SlidraError::invalid(
            "命令 slide style set 至少要給 --background 或 --accent",
        ));
    }
    let svg_root = require_svg_root(svg_content)?;
    let mut declarations = parse_style_declarations(attribute_value(&svg_root, "style").as_deref());

    if let Some(background) = &update.background {
        if background.is_empty() {
            declarations.retain(|(k, _)| k != BACKGROUND_PROPERTY);
        } else if let Some(existing) = declarations
            .iter_mut()
            .find(|(k, _)| k == BACKGROUND_PROPERTY)
        {
            existing.1 = background.clone();
        } else {
            declarations.push((BACKGROUND_PROPERTY.to_string(), background.clone()));
        }
    }
    if let Some(accent) = &update.accent {
        if accent.is_empty() {
            declarations.retain(|(k, _)| k != ACCENT_PROPERTY);
        } else if let Some(existing) = declarations.iter_mut().find(|(k, _)| k == ACCENT_PROPERTY) {
            existing.1 = accent.clone();
        } else {
            declarations.push((ACCENT_PROPERTY.to_string(), accent.clone()));
        }
    }

    let next_style = serialize_style_declarations(&declarations);
    if next_style.is_empty() {
        let Some(existing) = attribute_of(&svg_root, "style") else {
            return Ok(svg_content.to_string());
        };
        let tag_name_end =
            utf16_offset_to_byte_offset(svg_content, svg_root.start) + 1 + svg_root.tag.len();
        let mut start = utf16_offset_to_byte_offset(svg_content, existing.start);
        while start > tag_name_end {
            let Some(prev_char) = svg_content[..start].chars().next_back() else {
                break;
            };
            if prev_char.is_whitespace() {
                start -= prev_char.len_utf8();
            } else {
                break;
            }
        }
        let end = utf16_offset_to_byte_offset(svg_content, existing.end);
        return Ok(apply_splices(
            svg_content,
            &[Splice {
                start,
                end,
                text: String::new(),
            }],
        ));
    }
    Ok(apply_splices(
        svg_content,
        &[set_attr_splice(
            svg_content,
            &svg_root,
            "style",
            &next_style,
        )],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_background_and_accent_when_both_declared() {
        let svg = r#"<svg viewBox="0 0 100 100" style="background-color:#112233;--slidra-accent:#445566"></svg>"#;
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

    #[test]
    fn write_neither_flag_given_errors() {
        let svg = r#"<svg viewBox="0 0 100 100"></svg>"#;
        let err = set_slide_page_style(svg, &PageStyleUpdate::default()).unwrap_err();
        assert!(err.message().contains("至少要給"));
    }

    #[test]
    fn write_sets_both_on_svg_with_no_style_attribute() {
        let svg = r#"<svg viewBox="0 0 100 100"></svg>"#;
        let updated = set_slide_page_style(
            svg,
            &PageStyleUpdate {
                background: Some("#112233".to_string()),
                accent: Some("#445566".to_string()),
            },
        )
        .unwrap();
        assert_eq!(
            updated,
            r#"<svg style="background-color:#112233;--slidra-accent:#445566" viewBox="0 0 100 100"></svg>"#
        );
    }

    #[test]
    fn write_empty_string_clears_one_declaration_keeps_the_other() {
        let svg = r#"<svg viewBox="0 0 100 100" style="background-color:#112233;--slidra-accent:#445566"></svg>"#;
        let updated = set_slide_page_style(
            svg,
            &PageStyleUpdate {
                background: Some(String::new()),
                accent: None,
            },
        )
        .unwrap();
        assert_eq!(
            updated,
            r#"<svg viewBox="0 0 100 100" style="--slidra-accent:#445566"></svg>"#
        );
    }

    #[test]
    fn write_clearing_last_declaration_removes_the_whole_style_attribute() {
        let svg = r#"<svg viewBox="0 0 100 100" style="background-color:#112233"></svg>"#;
        let updated = set_slide_page_style(
            svg,
            &PageStyleUpdate {
                background: Some(String::new()),
                accent: None,
            },
        )
        .unwrap();
        assert_eq!(updated, r#"<svg viewBox="0 0 100 100"></svg>"#);
    }

    #[test]
    fn write_clearing_when_style_absent_is_a_no_op() {
        let svg = r#"<svg viewBox="0 0 100 100"></svg>"#;
        let updated = set_slide_page_style(
            svg,
            &PageStyleUpdate {
                background: Some(String::new()),
                accent: None,
            },
        )
        .unwrap();
        assert_eq!(updated, svg);
    }
}
