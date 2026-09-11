//! `co-motion slide background set` (#303 §13): a locked, full-canvas
//! `<image>` at the very back of a page, marked
//! `data-comot-role="background"`, pointing at an SVG (or raster) asset.
//! One per page: setting again replaces it; `--none` removes it.

use crate::element::LOCK_ATTRIBUTE;
use crate::element::splice::{Splice, apply_splices};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::scan::{ScannedNode, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::escape::escape_xml_attr;
use crate::text::runs::utf16_offset_to_byte_offset;

pub const BACKGROUND_ROLE_ATTRIBUTE: &str = "data-comot-role";
pub const BACKGROUND_ROLE: &str = "background";
pub const BACKGROUND_ELEMENT_ID: &str = "el-background";

fn svg_root(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    roots
        .iter()
        .find(|n| n.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
}

/// The top-level container carrying the background role, if any.
pub fn find_background<'a>(root: &'a ScannedNode) -> Option<&'a ScannedNode> {
    root.children.iter().find(|c| {
        c.tag == "g"
            && attribute_value(c, BACKGROUND_ROLE_ATTRIBUTE).as_deref() == Some(BACKGROUND_ROLE)
    })
}

/// Where a new background goes: right after `<metadata>` when present
/// (document furniture stays first), else at the start of the root.
fn insert_offset(root: &ScannedNode) -> usize {
    root.children
        .iter()
        .find(|c| c.tag == "metadata")
        .map(|m| m.end)
        .unwrap_or(root.content_start)
}

pub fn background_markup(
    asset_path: &str,
    width: f64,
    height: f64,
    opacity: Option<f64>,
) -> String {
    let opacity_attr = opacity
        .map(|o| format!(" opacity=\"{}\"", format_svg_number(o)))
        .unwrap_or_default();
    // Slides live in `slides/`, so an asset reference is written relative
    // to that directory (`../assets/x.svg`) — the same form `element insert
    // image --href` uses and the only one the stage's `/api/raw/slides/`
    // base resolves (#303: a bare `assets/…` href renders as a broken image).
    format!(
        "<g id=\"{BACKGROUND_ELEMENT_ID}\" data-comot-name=\"背景圖\" {BACKGROUND_ROLE_ATTRIBUTE}=\"{BACKGROUND_ROLE}\" {LOCK_ATTRIBUTE}=\"true\"><image x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" href=\"../{}\"{opacity_attr}/></g>",
        format_svg_number(width),
        format_svg_number(height),
        escape_xml_attr(asset_path)
    )
}

/// Inserts or replaces the page's background element.
pub fn set_background(
    svg_content: &str,
    asset_path: &str,
    width: f64,
    height: f64,
    opacity: Option<f64>,
) -> CoMotionResult<String> {
    if let Some(o) = opacity {
        if !(0.0..=1.0).contains(&o) {
            return Err(CoMotionError::invalid("--opacity 必須是 0 到 1 之間的數字"));
        }
    }
    let roots = scan_document(svg_content)?;
    let root = svg_root(&roots)?;
    let markup = background_markup(asset_path, width, height, opacity);
    let splice = match find_background(root) {
        Some(existing) => Splice {
            start: existing.start,
            end: existing.end,
            text: markup,
        },
        None => {
            let at = insert_offset(root);
            Splice {
                start: at,
                end: at,
                text: markup,
            }
        }
    };
    Ok(apply_splices(svg_content, &[splice]))
}

/// Removes the background element; `NotFound` when the page has none.
pub fn clear_background(svg_content: &str) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let root = svg_root(&roots)?;
    let Some(existing) = find_background(root) else {
        return Err(CoMotionError::not_found("這一頁沒有背景圖"));
    };
    let start = utf16_offset_to_byte_offset(svg_content, existing.start);
    let end = utf16_offset_to_byte_offset(svg_content, existing.end);
    Ok(format!("{}{}", &svg_content[..start], &svg_content[end..]))
}

/// `slide add --svg`/`slide set --svg`: an agent-authored page may carry
/// its own background element; it is kept where it is and locked.
pub fn lock_declared_background(svg_content: &str) -> CoMotionResult<String> {
    let roots = scan_document(svg_content)?;
    let root = svg_root(&roots)?;
    let Some(existing) = find_background(root) else {
        return Ok(svg_content.to_string());
    };
    if attribute_value(existing, LOCK_ATTRIBUTE).as_deref() == Some("true") {
        return Ok(svg_content.to_string());
    }
    // Append the lock right before the opening tag's `>`.
    let at = existing.content_start - 1;
    let splice = Splice {
        start: at,
        end: at,
        text: format!(" {LOCK_ATTRIBUTE}=\"true\""),
    };
    Ok(apply_splices(svg_content, &[splice]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><comot:notes xmlns:comot=\"https://co-motion.dev/ns\">n</comot:notes></metadata><g id=\"el-a\"><rect x=\"0\" y=\"0\" width=\"1\" height=\"1\"/></g></svg>";

    #[test]
    fn set_inserts_a_locked_full_canvas_image_after_metadata() {
        let out = set_background(PAGE, "assets/bg.svg", 1280.0, 720.0, Some(0.8)).unwrap();
        let expected = "</metadata><g id=\"el-background\" data-comot-name=\"背景圖\" data-comot-role=\"background\" data-comot-lock=\"true\"><image x=\"0\" y=\"0\" width=\"1280\" height=\"720\" href=\"../assets/bg.svg\" opacity=\"0.8\"/></g><g id=\"el-a\">";
        assert!(out.contains(expected), "{out}");
    }

    #[test]
    fn set_again_replaces_instead_of_stacking() {
        let once = set_background(PAGE, "assets/a.svg", 1280.0, 720.0, None).unwrap();
        let twice = set_background(&once, "assets/b.svg", 1280.0, 720.0, None).unwrap();
        assert_eq!(twice.matches("data-comot-role=\"background\"").count(), 1);
        assert!(twice.contains("href=\"../assets/b.svg\""));
        assert!(!twice.contains("assets/a.svg"));
    }

    #[test]
    fn opacity_out_of_range_errors() {
        assert!(set_background(PAGE, "assets/a.svg", 1280.0, 720.0, Some(1.5)).is_err());
    }

    #[test]
    fn clear_removes_it_and_errors_when_absent() {
        let once = set_background(PAGE, "assets/a.svg", 1280.0, 720.0, None).unwrap();
        let cleared = clear_background(&once).unwrap();
        assert_eq!(cleared, PAGE);
        assert!(matches!(
            clear_background(PAGE),
            Err(CoMotionError::NotFound(_))
        ));
    }

    #[test]
    fn lock_declared_background_adds_the_lock_once() {
        let page = "<svg viewBox=\"0 0 1280 720\"><g id=\"el-bg\" data-comot-role=\"background\"><image x=\"0\" y=\"0\" width=\"1280\" height=\"720\" href=\"assets/a.svg\"/></g></svg>";
        let locked = lock_declared_background(page).unwrap();
        assert!(
            locked.contains("data-comot-role=\"background\" data-comot-lock=\"true\">"),
            "{locked}"
        );
        assert_eq!(lock_declared_background(&locked).unwrap(), locked);
        assert_eq!(lock_declared_background(PAGE).unwrap(), PAGE);
    }
}
