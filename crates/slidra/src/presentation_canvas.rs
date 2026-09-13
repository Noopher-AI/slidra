// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `presentation canvas set`, ported from
//! `packages/core/src/presentation-canvas.ts` (full file). Deliberately the
//! ONE command that never touches an element's own `transform`/geometry —
//! resizing the page never rescales content.

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::format::assert_slide_compliant;
use crate::slide::scan::scan_document;
use crate::splice::{apply_splices, set_attr_splice};
use crate::svgnum::format_svg_number;

const MIN_CANVAS_DIMENSION: f64 = 320.0;
const MAX_CANVAS_DIMENSION: f64 = 4096.0;

/// Validates a canvas width/height against the panel's declared 320–4096
/// range. Never clamps — an out-of-range value is rejected, not silently
/// squeezed to the boundary.
pub fn assert_valid_canvas_dimension(value: f64, label: &str) -> SlidraResult<()> {
    let is_integer = value.fract() == 0.0 && value.is_finite();
    if !is_integer || !(MIN_CANVAS_DIMENSION..=MAX_CANVAS_DIMENSION).contains(&value) {
        return Err(SlidraError::invalid(format!(
            "{label} must be an integer between {} and {}: {}",
            MIN_CANVAS_DIMENSION as i64,
            MAX_CANVAS_DIMENSION as i64,
            format_svg_number(value)
        )));
    }
    Ok(())
}

/// Pure `svg_content -> svg_content`: rewrites the root `<svg>`'s `viewBox`
/// to `0 0 width height`. Every other byte is untouched.
pub fn set_slide_view_box(
    svg_content: &str,
    slide_path: &str,
    width: f64,
    height: f64,
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .into_iter()
        .find(|node| node.tag == "svg")
        .expect("assert_slide_compliant guarantees an <svg> root");
    let view_box = format!(
        "0 0 {} {}",
        format_svg_number(width),
        format_svg_number(height)
    );
    Ok(apply_splices(
        svg_content,
        &[set_attr_splice(
            svg_content,
            &svg_root,
            "viewBox",
            &view_box,
        )],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_boundary_values() {
        assert!(assert_valid_canvas_dimension(320.0, "width").is_ok());
        assert!(assert_valid_canvas_dimension(4096.0, "height").is_ok());
    }

    #[test]
    fn rejects_out_of_range() {
        let err = assert_valid_canvas_dimension(319.0, "width").unwrap_err();
        assert_eq!(
            err.message(),
            "width must be an integer between 320 and 4096: 319"
        );
        let err = assert_valid_canvas_dimension(4097.0, "height").unwrap_err();
        assert_eq!(
            err.message(),
            "height must be an integer between 320 and 4096: 4097"
        );
    }

    #[test]
    fn rejects_non_integer() {
        let err = assert_valid_canvas_dimension(320.5, "width").unwrap_err();
        assert!(err.message().contains("320.5"));
    }

    #[test]
    fn set_slide_view_box_rewrites_only_the_viewbox() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><g id=\"a\"><rect width=\"10\" height=\"10\"/></g></svg>\n";
        let updated = set_slide_view_box(svg, "slides/001.svg", 1920.0, 1080.0).unwrap();
        assert_eq!(
            updated,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1920 1080\"><g id=\"a\"><rect width=\"10\" height=\"10\"/></g></svg>\n"
        );
    }
}
