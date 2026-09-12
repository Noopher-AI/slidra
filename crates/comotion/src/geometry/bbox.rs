//! Bounding boxes, ported from `packages/core/src/geometry/bbox.ts`.
//! Together with `transform.rs` this is the whole of "where is this
//! element, and how big is it" — one implementation, so a CLI-side answer
//! and a future front-end preview can never disagree.
//!
//! ADR-0012, as ruled for this campaign: conversion wraps, it never hoists a
//! primitive's native coordinates into the container. So an element's
//! absolute geometry is always `container-chain matrix ∘ the primitive's own
//! native geometry`.
//!
//! ## Numeric computation vs. serialization, kept apart on purpose
//!
//! `Bbox` holds plain `f64`s — no `format_svg_number` baked in anywhere in
//! this file's math. `format_bbox` is the one place a computed `Bbox` gets
//! turned into the 4-decimal-place, trailing-zero-free strings this
//! codebase writes into SVG attributes and compares against golden
//! fixtures. Keeping the two apart means every intermediate computation
//! (`transform_rect`, `union_rects`, a group's recursive union) stays exact
//! `f64` arithmetic — rounding once, at the very end, is how this avoids
//! accumulating rounding error across a container chain.

use std::collections::HashMap;

use crate::errors::{CoMotionError, CoMotionResult};
use crate::geometry::transform::{
    Matrix, Point, apply_matrix_to_point, compose_matrices, multiply_matrices,
};
use crate::slide::format::{SlideElement, SlideElementKind, SlidePrimitive};
use crate::svgnum::format_svg_number;
use crate::text::font::FontMetrics;
use crate::text::metrics::measure_text_width;

/// Nesting limit for a container chain — a guard against a maliciously deep
/// slide blowing the call stack (ADR-0010: slide content is untrusted).
/// Defined ONCE here (not duplicated in `slide/format.rs`) so the compliance
/// check and this bbox walk can never disagree about the limit; `format.rs`
/// re-exports this constant rather than redefining it, mirroring the TS
/// source's `slide/format.ts` re-exporting it from `geometry/bbox.ts`.
pub const MAX_CONTAINER_DEPTH: usize = 64;

/// An axis-aligned bounding box: plain `f64` fields, no formatting baked in
/// (see module header comment). Ports the TS `Rect` interface — renamed here
/// to `Bbox` per this ticket's locked contract (a `SlideElement`'s own
/// computed box, not to be confused with `slide::table_grid::TableGrid`,
/// which is raw declared grid geometry, not a computed box).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A `Bbox`'s four fields, each independently passed through
/// `format_svg_number` — the shape golden-fixture comparisons and rendered
/// SVG attributes actually want. Kept as its own type (not a method that
/// returns `String`s in place) so nothing upstream is tempted to compare
/// formatted strings mid-computation, which is exactly the accumulated-
/// rounding-error trap the module header comment describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormattedBbox {
    pub x: String,
    pub y: String,
    pub width: String,
    pub height: String,
}

/// Formats a computed `Bbox` for serialization/golden-fixture comparison.
pub fn format_bbox(bbox: &Bbox) -> FormattedBbox {
    FormattedBbox {
        x: format_svg_number(bbox.x),
        y: format_svg_number(bbox.y),
        width: format_svg_number(bbox.width),
        height: format_svg_number(bbox.height),
    }
}

/// The axis-aligned box around `r`'s four corners after `m` is applied.
/// Ports `transformRect`.
pub fn transform_rect(m: &Matrix, r: &Bbox) -> Bbox {
    let corners = [
        Point { x: r.x, y: r.y },
        Point {
            x: r.x + r.width,
            y: r.y,
        },
        Point {
            x: r.x,
            y: r.y + r.height,
        },
        Point {
            x: r.x + r.width,
            y: r.y + r.height,
        },
    ]
    .map(|corner| apply_matrix_to_point(m, corner));
    let xs = corners.map(|corner| corner.x);
    let ys = corners.map(|corner| corner.y);
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    Bbox {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    }
}

/// Ports `unionRects`. An empty slice throws rather than returning a
/// degenerate zero box — there is no meaningful "bounding box of nothing".
pub fn union_rects(rects: &[Bbox]) -> CoMotionResult<Bbox> {
    if rects.is_empty() {
        return Err(CoMotionError::invalid(
            "無法計算邊界框：沒有任何矩形可以聯集",
        ));
    }
    let min_x = rects.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
    let min_y = rects.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
    let max_x = rects
        .iter()
        .map(|r| r.x + r.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = rects
        .iter()
        .map(|r| r.y + r.height)
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(Bbox {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    })
}

/// Mirrors the regex `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/` that
/// `numberAttr` (bbox.ts) validates a primitive attribute against before
/// accepting it as a bare number (rejecting percentages/units, which have no
/// single meaning inside a container chain). Structurally identical to
/// `transform.rs`'s private `is_svg_number_token` (same grammar, a different
/// TS source file) — duplicated rather than shared, matching this
/// codebase's own established precedent of keeping each file's tiny
/// number-grammar checker self-contained (see `transform.rs`'s module doc
/// comment for why it keeps its own `format_number` rather than reaching
/// into `svgnum.rs`).
fn is_plain_svg_number(text: &str) -> bool {
    let mut chars = text.chars().peekable();
    if matches!(chars.peek(), Some('+') | Some('-')) {
        chars.next();
    }
    let mut int_digits = 0usize;
    while matches!(chars.peek(), Some(c) if c.is_ascii_digit()) {
        chars.next();
        int_digits += 1;
    }
    let mut has_dot = false;
    let mut frac_digits = 0usize;
    if matches!(chars.peek(), Some('.')) {
        has_dot = true;
        chars.next();
        while matches!(chars.peek(), Some(c) if c.is_ascii_digit()) {
            chars.next();
            frac_digits += 1;
        }
    }
    let mantissa_ok = if int_digits > 0 {
        true
    } else {
        has_dot && frac_digits > 0
    };
    if !mantissa_ok {
        return false;
    }
    if matches!(chars.peek(), Some('e') | Some('E')) {
        chars.next();
        if matches!(chars.peek(), Some('+') | Some('-')) {
            chars.next();
        }
        let mut exponent_digits = 0usize;
        while matches!(chars.peek(), Some(c) if c.is_ascii_digit()) {
            chars.next();
            exponent_digits += 1;
        }
        if exponent_digits == 0 {
            return false;
        }
    }
    chars.peek().is_none()
}

/// Ports `numberAttr`. A missing attribute falls back to `fallback` only
/// where SVG itself defines that default (e.g. `<rect>`'s `x` defaults to
/// 0) — pass `None` for attributes with no default, and the absence is
/// reported as an error instead.
fn number_attr(
    primitive: &SlidePrimitive,
    name: &str,
    fallback: Option<f64>,
) -> CoMotionResult<f64> {
    let raw = match primitive.attr(name) {
        Some(r) if !r.trim().is_empty() => r,
        _ => {
            return fallback.ok_or_else(|| {
                CoMotionError::invalid(format!(
                    "<{}> 缺少計算邊界框需要的屬性：{}",
                    primitive.tag, name
                ))
            });
        }
    };
    let text = raw.trim();
    if !is_plain_svg_number(text) {
        return Err(CoMotionError::invalid(format!(
            "<{}> 的屬性 {} 不是純數字：{}（百分比與單位在容器鏈裡沒有唯一答案）",
            primitive.tag, name, text
        )));
    }
    Ok(text
        .parse::<f64>()
        .expect("is_plain_svg_number already validated the exact numeric grammar"))
}

/// Everything a `<text>` primitive's box needs that the primitive itself
/// does not carry: the font book, and the declared box width/height, which
/// the normal form keeps on the CONTAINER (`SlideElement::text_width`/
/// `text_height`) rather than on the `<text>` primitive.
///
/// `fonts` is a narrow, self-contained stand-in for `element-text.ts`'s
/// `resolveFont` + the `ReadonlyMap<string, FontMetrics>` it resolves
/// against — this ticket does not port `element-text.ts` itself (out of
/// scope beyond `readTextAlign`, see `slide/format.rs`'s header comment), so
/// there is no `crate::text::font_book`-style module to import a full
/// `resolveFont` from. The lookup-and-error behavior here is copied from
/// that function's own two lines, not guessed at.
pub struct TextBoundsContext<'a> {
    pub fonts: &'a HashMap<String, Box<dyn FontMetrics>>,
    /// The owning element's `text_width`; `None` when it is not a text box.
    pub text_width: Option<f64>,
    /// The owning element's baked-in `text_height`; `None` when absent.
    pub text_height: Option<f64>,
    /// Only ever used to name the element in an error message.
    pub element_id: String,
}

/// Ports `resolveFont`'s lookup-and-error behavior (see `TextBoundsContext`'s
/// doc comment for why this is a narrow inline stand-in rather than an
/// import).
fn resolve_font<'a>(
    fonts: &'a HashMap<String, Box<dyn FontMetrics>>,
    font_family: &str,
    element_id: &str,
) -> CoMotionResult<&'a dyn FontMetrics> {
    fonts
        .get(font_family)
        .map(|boxed| boxed.as_ref())
        .ok_or_else(|| {
            CoMotionError::invalid(format!(
                "簡報未內嵌字型 {font_family}，無法重新換行：{element_id}"
            ))
        })
}

/// The box of a `<text>` primitive (NOOP-91 §4.7). Ports `textBounds`.
///
/// Two shapes, placed differently, because the format places them
/// differently:
///
///  - A TEXT BOX (`data-comot-text-width` on the container, one `<tspan>`
///    per baked-in line): the box starts at the local origin, is the
///    declared width wide, and is `行數 × 行高` tall (or the baked-in
///    `text_height` when present) — the declared width, never a
///    re-measurement.
///  - A PLAIN `<text>` (no tspans): `y` is the FIRST BASELINE, so the box's
///    top sits `ascent` above it; width is the measured advance of the
///    string, height is one line.
///
/// A `<text>` that has tspans but no declared width errors rather than
/// measuring the concatenated string as one line — `SlidePrimitive` exposes
/// the joined text and the tspan COUNT, never the per-line split, so a
/// per-line maximum is not computable from it.
fn text_bounds(
    primitive: &SlidePrimitive,
    context: &TextBoundsContext<'_>,
) -> CoMotionResult<Bbox> {
    let font_family = primitive
        .attr("font-family")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            CoMotionError::invalid(format!(
                "<text> 缺少 font-family，無法計算邊界框：{}",
                context.element_id
            ))
        })?;

    let font_size = match primitive
        .attr("font-size")
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => 16.0,
        Some(raw) => raw.parse::<f64>().unwrap_or(f64::NAN),
    };
    if !font_size.is_finite() || font_size <= 0.0 {
        return Err(CoMotionError::invalid(format!(
            "<text> 的 font-size 不是合法的正數，無法計算邊界框：{}",
            context.element_id
        )));
    }

    let font = resolve_font(context.fonts, font_family, &context.element_id)?;
    let line_height = ((f64::from(font.ascender()) - f64::from(font.descender())
        + f64::from(font.line_gap()))
        / f64::from(font.units_per_em()))
        * font_size;
    let ascent = (f64::from(font.ascender()) / f64::from(font.units_per_em())) * font_size;
    // A `<text>` with no tspans is one line; the tspan count is the line
    // count for everything the wrap wrote.
    let line_count = if primitive.tspan_count == 0 {
        1
    } else {
        primitive.tspan_count
    };

    if let Some(text_width) = context.text_width {
        let height = context
            .text_height
            .unwrap_or(line_count as f64 * line_height);
        return Ok(Bbox {
            x: 0.0,
            y: 0.0,
            width: text_width,
            height,
        });
    }
    if primitive.tspan_count > 0 {
        return Err(CoMotionError::invalid(format!(
            "<text> 有 tspan 卻沒有 data-comot-text-width，無法計算每一行的寬度：{}",
            context.element_id
        )));
    }
    let x = number_attr(primitive, "x", Some(0.0))?;
    let y = number_attr(primitive, "y", Some(0.0))?;
    let width = measure_text_width(font, &primitive.text, font_size)?;
    Ok(Bbox {
        x,
        y: y - ascent,
        width,
        height: line_height,
    })
}

/// The bounding box of one primitive, in the coordinate system the
/// primitive itself lives in (i.e. before any container transform). Ports
/// `primitiveBounds`.
///
/// `<text>` needs font metrics, so it is only supported when `text` is
/// given; called without it, a `<text>` errors exactly the message it
/// always did.
pub fn primitive_bounds(
    primitive: &SlidePrimitive,
    text: Option<&TextBoundsContext<'_>>,
) -> CoMotionResult<Bbox> {
    match primitive.tag.as_str() {
        "rect" | "image" | "svg" => {
            let x = number_attr(primitive, "x", Some(0.0))?;
            let y = number_attr(primitive, "y", Some(0.0))?;
            let width = number_attr(primitive, "width", None)?;
            let height = number_attr(primitive, "height", None)?;
            Ok(Bbox {
                x,
                y,
                width,
                height,
            })
        }
        "circle" => {
            let cx = number_attr(primitive, "cx", Some(0.0))?;
            let cy = number_attr(primitive, "cy", Some(0.0))?;
            let r = number_attr(primitive, "r", None)?;
            Ok(Bbox {
                x: cx - r,
                y: cy - r,
                width: 2.0 * r,
                height: 2.0 * r,
            })
        }
        "ellipse" => {
            let cx = number_attr(primitive, "cx", Some(0.0))?;
            let cy = number_attr(primitive, "cy", Some(0.0))?;
            let rx = number_attr(primitive, "rx", None)?;
            let ry = number_attr(primitive, "ry", None)?;
            Ok(Bbox {
                x: cx - rx,
                y: cy - ry,
                width: 2.0 * rx,
                height: 2.0 * ry,
            })
        }
        "line" => {
            let x1 = number_attr(primitive, "x1", Some(0.0))?;
            let y1 = number_attr(primitive, "y1", Some(0.0))?;
            let x2 = number_attr(primitive, "x2", Some(0.0))?;
            let y2 = number_attr(primitive, "y2", Some(0.0))?;
            Ok(Bbox {
                x: x1.min(x2),
                y: y1.min(y2),
                width: (x2 - x1).abs(),
                height: (y2 - y1).abs(),
            })
        }
        "path" => {
            let d = primitive
                .attr("d")
                .ok_or_else(|| CoMotionError::invalid("<path> 缺少計算邊界框需要的屬性：d"))?;
            path_bounds(d)
        }
        "text" => match text {
            None => Err(CoMotionError::invalid(
                "尚無法計算文字元素的邊界框：待 #76 的字型度量落地",
            )),
            Some(context) => text_bounds(primitive, context),
        },
        other => Err(CoMotionError::invalid(format!(
            "無法計算邊界框：<{other}> 不是合法圖元"
        ))),
    }
}

// --- `<path>` `d` bounding box ---------------------------------------------

#[derive(Debug, Clone, Copy)]
enum PathTok {
    Command(char),
    Number(f64),
}

/// Matches the longest prefix of `chars` against the number grammar
/// `[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`, returning the parsed value and
/// how many `char`s it consumed, or `None` if `chars` does not start with a
/// number at all.
fn match_number(chars: &[char]) -> Option<(f64, usize)> {
    let mut i = 0usize;
    if matches!(chars.first(), Some('+') | Some('-')) {
        i += 1;
    }

    let mut int_digits = 0usize;
    while matches!(chars.get(i), Some(c) if c.is_ascii_digit()) {
        i += 1;
        int_digits += 1;
    }

    let mut frac_digits = 0usize;
    if chars.get(i) == Some(&'.') {
        let dot_pos = i;
        let mut j = i + 1;
        while matches!(chars.get(j), Some(c) if c.is_ascii_digit()) {
            j += 1;
            frac_digits += 1;
        }
        // `\d+\.?\d*` allows a bare trailing dot ("12."); `\.\d+` requires at
        // least one fraction digit when there were no integer digits either.
        // Only reject the dot outright when NEITHER alternative can use it.
        if int_digits == 0 && frac_digits == 0 {
            i = dot_pos;
        } else {
            i = j;
        }
    }

    if int_digits == 0 && frac_digits == 0 {
        return None;
    }

    if matches!(chars.get(i), Some('e') | Some('E')) {
        let mut j = i + 1;
        if matches!(chars.get(j), Some('+') | Some('-')) {
            j += 1;
        }
        let exponent_start = j;
        while matches!(chars.get(j), Some(c) if c.is_ascii_digit()) {
            j += 1;
        }
        // No exponent digit -> the regex's optional exponent group simply
        // fails to match here, contributing nothing (`i` stays put).
        if j > exponent_start {
            i = j;
        }
    }

    let text: String = chars[0..i].iter().collect();
    text.parse::<f64>().ok().map(|value| (value, i))
}

/// Splits path data into command letters and numbers. Ports the private
/// `tokenizePathData` in `geometry/bbox.ts`, which drives this off one
/// sticky regex
/// (`/([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)/gy`).
/// This hand-written scanner tries the same three alternatives in the same
/// order (their character classes never overlap, so order does not affect
/// which one matches) rather than depending on a regex crate — this
/// ticket's Rust dependencies are fixed at `clap`/`serde`/`serde_json`.
fn tokenize_path_data(d: &str) -> CoMotionResult<Vec<PathTok>> {
    let chars: Vec<char> = d.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if matches!(
            c,
            'M' | 'm'
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
                | 'Z'
                | 'z'
        ) {
            tokens.push(PathTok::Command(c));
            i += 1;
            continue;
        }
        if c == ',' || c.is_whitespace() {
            i += 1;
            while i < chars.len() && (chars[i] == ',' || chars[i].is_whitespace()) {
                i += 1;
            }
            continue;
        }
        if let Some((value, consumed)) = match_number(&chars[i..]) {
            tokens.push(PathTok::Number(value));
            i += consumed;
            continue;
        }
        let snippet: String = chars[i..].iter().take(12).collect();
        return Err(CoMotionError::invalid(format!(
            "<path> 的 d 語法錯誤：無法解析「{snippet}」"
        )));
    }
    Ok(tokens)
}

fn next_number(tokens: &[PathTok], index: &mut usize, command: &str) -> CoMotionResult<f64> {
    match tokens.get(*index) {
        Some(PathTok::Number(v)) => {
            *index += 1;
            Ok(*v)
        }
        _ => Err(CoMotionError::invalid(format!(
            "<path> 的 d 語法錯誤：{command} 指令的參數不足"
        ))),
    }
}

/// Endpoints plus every real extreme of a cubic Bézier on one axis:
/// `B'(t) = 3[(-p0+3p1-3p2+p3)t² + (2p0-4p1+2p2)t + (-p0+p1)]`, roots kept
/// only inside the open interval `(0, 1)` (the endpoints are already in
/// `values` and a root outside that range is not on the actual curve
/// segment).
fn cubic_extremes(p0: f64, p1: f64, p2: f64, p3: f64) -> Vec<f64> {
    let mut values = vec![p0, p3];
    let a = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
    let b = 2.0 * p0 - 4.0 * p1 + 2.0 * p2;
    let c = -p0 + p1;
    for t in solve_quadratic(a, b, c) {
        if t > 0.0 && t < 1.0 {
            let u = 1.0 - t;
            values.push(
                u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3,
            );
        }
    }
    values
}

/// Endpoints plus the single real extreme of a quadratic Bézier on one axis.
fn quadratic_extremes(p0: f64, p1: f64, p2: f64) -> Vec<f64> {
    let mut values = vec![p0, p2];
    let denominator = p0 - 2.0 * p1 + p2;
    if denominator != 0.0 {
        let t = (p0 - p1) / denominator;
        if t > 0.0 && t < 1.0 {
            let u = 1.0 - t;
            values.push(u * u * p0 + 2.0 * u * t * p1 + t * t * p2);
        }
    }
    values
}

fn solve_quadratic(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a == 0.0 {
        return if b == 0.0 { Vec::new() } else { vec![-c / b] };
    }
    let discriminant = b * b - 4.0 * a * c;
    if discriminant < 0.0 {
        return Vec::new();
    }
    let root = discriminant.sqrt();
    vec![(-b + root) / (2.0 * a), (-b - root) / (2.0 * a)]
}

/// Bounding box of a `<path>`'s `d`, exact for every command it supports:
/// straight segments contribute their endpoints, and Bézier segments
/// contribute the real extremes of their curve (the roots of the derivative
/// inside `0 < t < 1`), not just their control points — a control-point box
/// is always too large. Ports `pathBounds` command-for-command.
///
/// LOWER-CONFIDENCE AREA (flagged per this ticket's instructions): the
/// straight-segment (`M`/`L`/`H`/`V`/`Z`) path is exercised by this file's
/// own tests and is straightforward. The cubic/quadratic Bézier extrema math
/// (`cubic_extremes`/`quadratic_extremes`/`solve_quadratic`) is a direct
/// transcription of the TS source's formulas and has NOT been independently
/// re-derived or checked against a real browser/canvas rendering in this
/// environment (no such tooling was available) — only checked for
/// transcription fidelity against `bbox.ts`.
///
/// Elliptical arcs (`A`/`a`) are not supported and return `Err`, exactly
/// like the TS source: computing their real extrema means converting
/// endpoint parameterisation to centre parameterisation, which the TS
/// source's own comment says no ticket has needed yet. This port does not
/// close that gap either.
pub fn path_bounds(d: &str) -> CoMotionResult<Bbox> {
    let tokens = tokenize_path_data(d)?;
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();

    let mut index = 0usize;
    let mut current = Point { x: 0.0, y: 0.0 };
    let mut subpath_start = Point { x: 0.0, y: 0.0 };
    let mut command = String::new();
    // Reflection of the previous cubic's second control point, for `S`/`s`.
    let mut last_cubic_control: Option<Point> = None;
    // Reflection of the previous quadratic's control point, for `T`/`t`.
    let mut last_quad_control: Option<Point> = None;

    while index < tokens.len() {
        match tokens[index] {
            PathTok::Command(c) => {
                command = c.to_string();
                index += 1;
            }
            PathTok::Number(_) => {
                if command.is_empty() {
                    return Err(CoMotionError::invalid(
                        "<path> 的 d 語法錯誤：第一個指令必須是 M 或 m",
                    ));
                }
                // An `M`/`m` with more than one coordinate pair implicitly
                // continues as `L`/`l` (SVG 1.1 S8.3.2) — every subsequent
                // number-only iteration falls through with the SAME
                // already-updated `command`, so this branch only fires once
                // per subpath.
                if command == "M" {
                    command = "L".to_string();
                } else if command == "m" {
                    command = "l".to_string();
                }
            }
        }

        let relative = command == command.to_lowercase();
        let base = if relative {
            current
        } else {
            Point { x: 0.0, y: 0.0 }
        };

        match command.to_uppercase().as_str() {
            "M" => {
                let x = base.x + next_number(&tokens, &mut index, &command)?;
                let y = base.y + next_number(&tokens, &mut index, &command)?;
                current = Point { x, y };
                subpath_start = current;
                xs.push(x);
                ys.push(y);
                last_cubic_control = None;
                last_quad_control = None;
            }
            "L" => {
                let x = base.x + next_number(&tokens, &mut index, &command)?;
                let y = base.y + next_number(&tokens, &mut index, &command)?;
                current = Point { x, y };
                xs.push(x);
                ys.push(y);
                last_cubic_control = None;
                last_quad_control = None;
            }
            "H" => {
                let x = base.x + next_number(&tokens, &mut index, &command)?;
                current = Point { x, y: current.y };
                xs.push(x);
                ys.push(current.y);
                last_cubic_control = None;
                last_quad_control = None;
            }
            "V" => {
                let y = base.y + next_number(&tokens, &mut index, &command)?;
                current = Point { x: current.x, y };
                xs.push(current.x);
                ys.push(y);
                last_cubic_control = None;
                last_quad_control = None;
            }
            "C" | "S" => {
                let c1 = if command.eq_ignore_ascii_case("c") {
                    Point {
                        x: base.x + next_number(&tokens, &mut index, &command)?,
                        y: base.y + next_number(&tokens, &mut index, &command)?,
                    }
                } else {
                    match last_cubic_control {
                        Some(lc) => Point {
                            x: 2.0 * current.x - lc.x,
                            y: 2.0 * current.y - lc.y,
                        },
                        None => current,
                    }
                };
                let c2 = Point {
                    x: base.x + next_number(&tokens, &mut index, &command)?,
                    y: base.y + next_number(&tokens, &mut index, &command)?,
                };
                let end = Point {
                    x: base.x + next_number(&tokens, &mut index, &command)?,
                    y: base.y + next_number(&tokens, &mut index, &command)?,
                };
                xs.extend(cubic_extremes(current.x, c1.x, c2.x, end.x));
                ys.extend(cubic_extremes(current.y, c1.y, c2.y, end.y));
                current = end;
                last_cubic_control = Some(c2);
                last_quad_control = None;
            }
            "Q" | "T" => {
                let control = if command.eq_ignore_ascii_case("q") {
                    Point {
                        x: base.x + next_number(&tokens, &mut index, &command)?,
                        y: base.y + next_number(&tokens, &mut index, &command)?,
                    }
                } else {
                    match last_quad_control {
                        Some(lq) => Point {
                            x: 2.0 * current.x - lq.x,
                            y: 2.0 * current.y - lq.y,
                        },
                        None => current,
                    }
                };
                let end = Point {
                    x: base.x + next_number(&tokens, &mut index, &command)?,
                    y: base.y + next_number(&tokens, &mut index, &command)?,
                };
                xs.extend(quadratic_extremes(current.x, control.x, end.x));
                ys.extend(quadratic_extremes(current.y, control.y, end.y));
                current = end;
                last_quad_control = Some(control);
                last_cubic_control = None;
            }
            "Z" => {
                // Z takes no arguments; a number here would consume nothing
                // and spin this loop forever. Report it instead.
                if matches!(tokens.get(index), Some(PathTok::Number(_))) {
                    return Err(CoMotionError::invalid(
                        "<path> 的 d 語法錯誤：Z 指令後面不能接數字",
                    ));
                }
                current = subpath_start;
                xs.push(current.x);
                ys.push(current.y);
                last_cubic_control = None;
                last_quad_control = None;
            }
            "A" => {
                return Err(CoMotionError::invalid(
                    "尚無法計算含橢圓弧（A/a 指令）的 <path> 邊界框",
                ));
            }
            _ => {
                return Err(CoMotionError::invalid(format!(
                    "<path> 的 d 語法錯誤：不支援的指令 {command}"
                )));
            }
        }
    }

    if xs.is_empty() {
        return Err(CoMotionError::invalid(
            "<path> 的 d 沒有任何座標，無法計算邊界框",
        ));
    }
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    Ok(Bbox {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    })
}

// --- Element-level bounds (container chain + group/table/primitive union) --

/// A narrow, self-contained port of `element-text.ts`'s
/// `LIST_MARKER_ATTRIBUTE` constant — NOT a claim that `element-text.ts`
/// itself has been ported (it has not; see `slide/format.rs`'s header
/// comment). Needed only for the exclusion filter `boundsWithin` applies: a
/// list-marker `<text>` decorates a real content `<text>` and has no
/// `text_width`/`text_height` of its own, so it must never be measured
/// against the CONTAINER's `text_width`/`text_height` as if it were a second
/// text box.
const LIST_MARKER_ATTRIBUTE: &str = "data-comot-list-marker";

/// Ports `ElementBoundsOptions`.
pub struct ElementBoundsOptions<'a> {
    /// Container matrices from the slide root down to (but excluding) this
    /// element.
    pub ancestors: &'a [Matrix],
    /// Font metrics by family, for elements containing `<text>`. `None` and
    /// a `<text>` errors exactly as it always did (opt-in, see
    /// `TextBoundsContext`'s doc comment for why this map's shape is a
    /// narrow stand-in rather than a full font-book import).
    pub fonts: Option<&'a HashMap<String, Box<dyn FontMetrics>>>,
}

/// The element's axis-aligned bounding box in the slide's coordinate system:
/// the container chain's matrix applied to each primitive's native
/// geometry, or the union of the child elements' boxes for a group, or the
/// declared grid extent for a table. Ports `elementBounds`.
pub fn element_bounds(
    element: &SlideElement,
    options: &ElementBoundsOptions<'_>,
) -> CoMotionResult<Bbox> {
    let chain = compose_matrices(options.ancestors);
    bounds_within(element, &chain, 1, options.fonts)
}

fn bounds_within(
    element: &SlideElement,
    ancestor_matrix: &Matrix,
    depth: usize,
    fonts: Option<&HashMap<String, Box<dyn FontMetrics>>>,
) -> CoMotionResult<Bbox> {
    if depth > MAX_CONTAINER_DEPTH {
        return Err(CoMotionError::invalid(format!(
            "容器巢狀超過 {MAX_CONTAINER_DEPTH} 層，無法計算邊界框"
        )));
    }
    let matrix = multiply_matrices(ancestor_matrix, &element.matrix);

    // A table's bbox is its declared grid extent, not a primitive union
    // (E2.T14): cells carry no `id` and are not independently measurable
    // elements, and `element.table`'s `rows` are always core-computed
    // heights already baked into the file.
    if element.kind == SlideElementKind::Table {
        let table = element.table.as_ref().ok_or_else(|| {
            CoMotionError::invalid(format!("表格 {} 缺少 table 資料", element.id))
        })?;
        let width: f64 = table.cols.iter().sum();
        let height: f64 = table.rows.iter().sum();
        return Ok(transform_rect(
            &matrix,
            &Bbox {
                x: 0.0,
                y: 0.0,
                width,
                height,
            },
        ));
    }

    if element.kind == SlideElementKind::Group {
        if element.children.is_empty() {
            return Err(CoMotionError::invalid(format!(
                "群組 {} 裡沒有任何子元素，沒有邊界框",
                element.id
            )));
        }
        let child_boxes: Vec<Bbox> = element
            .children
            .iter()
            .map(|child| bounds_within(child, &matrix, depth + 1, fonts))
            .collect::<CoMotionResult<Vec<_>>>()?;
        return union_rects(&child_boxes);
    }

    if element.primitives.is_empty() {
        return Err(CoMotionError::invalid(format!(
            "元素 {} 裡沒有任何圖元，沒有邊界框",
            element.id
        )));
    }
    // The text context is built per element, not per primitive: text_width/
    // text_height are the CONTAINER's own attribute, never an ancestor's.
    let text_context: Option<TextBoundsContext<'_>> = fonts.map(|f| TextBoundsContext {
        fonts: f,
        text_width: element.text_width,
        text_height: element.text_height,
        element_id: element.id.clone(),
    });
    // A list-marker `<text>` never contributes its own geometry (see
    // `LIST_MARKER_ATTRIBUTE`'s doc comment). A chart's `<comot:chart>` data
    // primitive is excluded the same way (E2.T12, `chart/model.ts` out of
    // scope for this port) — it is not an SVG shape at all.
    let measurable: Vec<&SlidePrimitive> = element
        .primitives
        .iter()
        .filter(|primitive| {
            primitive.attr(LIST_MARKER_ATTRIBUTE) != Some("true") && primitive.tag != "comot:chart"
        })
        .collect();
    let boxes: Vec<Bbox> = measurable
        .iter()
        .map(|primitive| {
            Ok(transform_rect(
                &matrix,
                &primitive_bounds(primitive, text_context.as_ref())?,
            ))
        })
        .collect::<CoMotionResult<Vec<_>>>()?;
    union_rects(&boxes)
}

/// The element's top-left corner in slide coordinates — the `(x, y)` of
/// `element_bounds`. Ports `absolutePosition`.
pub fn absolute_position(
    element: &SlideElement,
    options: &ElementBoundsOptions<'_>,
) -> CoMotionResult<Point> {
    let bounds = element_bounds(element, options)?;
    Ok(Point {
        x: bounds.x,
        y: bounds.y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::transform::IDENTITY;
    use crate::slide::format::{SlideElementKind, SlidePrimitive, TextAlign};
    use crate::slide::table_grid::TableGrid;

    fn prim(tag: &str, attrs: &[(&str, &str)]) -> SlidePrimitive {
        SlidePrimitive {
            tag: tag.to_string(),
            attrs: attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            text: String::new(),
            tspan_count: 0,
            runs: Vec::new(),
        }
    }

    fn leaf_element(
        id: &str,
        kind: SlideElementKind,
        primitives: Vec<SlidePrimitive>,
    ) -> SlideElement {
        SlideElement {
            id: id.to_string(),
            name: None,
            media: None,
            kind,
            transform: None,
            matrix: IDENTITY,
            children: Vec::new(),
            primitives,
            text_width: None,
            text_height: None,
            text_align: TextAlign::Left,
            table: None,
        }
    }

    #[test]
    fn rect_bounds_reads_native_attributes() {
        let p = prim(
            "rect",
            &[("x", "1"), ("y", "2"), ("width", "3"), ("height", "4")],
        );
        let b = primitive_bounds(&p, None).unwrap();
        assert_eq!(
            b,
            Bbox {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0
            }
        );
    }

    #[test]
    fn rect_bounds_missing_width_errors() {
        let p = prim("rect", &[("x", "1"), ("y", "2")]);
        let err = primitive_bounds(&p, None).unwrap_err();
        assert!(err.message().contains("缺少計算邊界框需要的屬性"));
    }

    #[test]
    fn ellipse_bounds_centers_on_cx_cy() {
        let p = prim(
            "ellipse",
            &[("cx", "10"), ("cy", "20"), ("rx", "3"), ("ry", "4")],
        );
        let b = primitive_bounds(&p, None).unwrap();
        assert_eq!(
            b,
            Bbox {
                x: 7.0,
                y: 16.0,
                width: 6.0,
                height: 8.0
            }
        );
    }

    #[test]
    fn line_bounds_normalizes_reversed_endpoints() {
        let p = prim(
            "line",
            &[("x1", "10"), ("y1", "10"), ("x2", "2"), ("y2", "1")],
        );
        let b = primitive_bounds(&p, None).unwrap();
        assert_eq!(
            b,
            Bbox {
                x: 2.0,
                y: 1.0,
                width: 8.0,
                height: 9.0
            }
        );
    }

    #[test]
    fn percentage_attribute_is_rejected() {
        let p = prim(
            "rect",
            &[("x", "0"), ("y", "0"), ("width", "50%"), ("height", "10")],
        );
        let err = primitive_bounds(&p, None).unwrap_err();
        assert!(err.message().contains("不是純數字"));
    }

    #[test]
    fn path_bounds_of_straight_segments_only() {
        // A 10x10 right triangle: M0,0 L10,0 L10,10 Z
        let b = path_bounds("M0 0 L10 0 L10 10 Z").unwrap();
        assert_eq!(
            b,
            Bbox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0
            }
        );
    }

    #[test]
    fn path_bounds_relative_commands_accumulate_from_current_point() {
        let b = path_bounds("m5 5 l5 0 l0 5 z").unwrap();
        assert_eq!(
            b,
            Bbox {
                x: 5.0,
                y: 5.0,
                width: 5.0,
                height: 5.0
            }
        );
    }

    #[test]
    fn path_bounds_rejects_arcs() {
        let err = path_bounds("M0 0 A5 5 0 0 1 10 10").unwrap_err();
        assert!(err.message().contains("橢圓弧"));
    }

    #[test]
    fn group_bounds_is_union_of_children() {
        let child_a = leaf_element(
            "a",
            SlideElementKind::Rect,
            vec![prim(
                "rect",
                &[("x", "0"), ("y", "0"), ("width", "10"), ("height", "10")],
            )],
        );
        let child_b = leaf_element(
            "b",
            SlideElementKind::Rect,
            vec![prim(
                "rect",
                &[("x", "20"), ("y", "5"), ("width", "5"), ("height", "5")],
            )],
        );
        let group = SlideElement {
            id: "g".to_string(),
            name: None,
            media: None,
            kind: SlideElementKind::Group,
            transform: None,
            matrix: IDENTITY,
            children: vec![child_a, child_b],
            primitives: Vec::new(),
            text_width: None,
            text_height: None,
            text_align: TextAlign::Left,
            table: None,
        };
        let options = ElementBoundsOptions {
            ancestors: &[],
            fonts: None,
        };
        let bounds = element_bounds(&group, &options).unwrap();
        // Union of [0,0,10,10] and [20,5,5,5] -> x:[0,25], y:[0,10].
        assert_eq!(
            bounds,
            Bbox {
                x: 0.0,
                y: 0.0,
                width: 25.0,
                height: 10.0
            }
        );
    }

    #[test]
    fn empty_group_errors() {
        let group = SlideElement {
            id: "g".to_string(),
            name: None,
            media: None,
            kind: SlideElementKind::Group,
            transform: None,
            matrix: IDENTITY,
            children: Vec::new(),
            primitives: Vec::new(),
            text_width: None,
            text_height: None,
            text_align: TextAlign::Left,
            table: None,
        };
        let options = ElementBoundsOptions {
            ancestors: &[],
            fonts: None,
        };
        let err = element_bounds(&group, &options).unwrap_err();
        assert!(err.message().contains("沒有任何子元素"));
    }

    #[test]
    fn table_bounds_sums_declared_grid() {
        let mut table_element = leaf_element("t", SlideElementKind::Table, Vec::new());
        table_element.table = Some(TableGrid {
            cols: vec![100.0, 200.0],
            rows: vec![40.0, 60.0],
        });
        let options = ElementBoundsOptions {
            ancestors: &[],
            fonts: None,
        };
        let bounds = element_bounds(&table_element, &options).unwrap();
        assert_eq!(
            bounds,
            Bbox {
                x: 0.0,
                y: 0.0,
                width: 300.0,
                height: 100.0
            }
        );
    }

    #[test]
    fn table_bounds_missing_grid_errors() {
        let table_element = leaf_element("t", SlideElementKind::Table, Vec::new());
        let options = ElementBoundsOptions {
            ancestors: &[],
            fonts: None,
        };
        let err = element_bounds(&table_element, &options).unwrap_err();
        assert!(err.message().contains("缺少 table 資料"));
    }

    #[test]
    fn too_deep_container_chain_errors() {
        // A single-child chain of groups, MAX_CONTAINER_DEPTH + 2 levels
        // deep, must be rejected rather than silently truncated.
        let mut current = leaf_element(
            "leaf",
            SlideElementKind::Rect,
            vec![prim(
                "rect",
                &[("x", "0"), ("y", "0"), ("width", "1"), ("height", "1")],
            )],
        );
        for i in 0..(MAX_CONTAINER_DEPTH + 1) {
            current = SlideElement {
                id: format!("g{i}"),
                name: None,
                media: None,
                kind: SlideElementKind::Group,
                transform: None,
                matrix: IDENTITY,
                children: vec![current],
                primitives: Vec::new(),
                text_width: None,
                text_height: None,
                text_align: TextAlign::Left,
                table: None,
            };
        }
        let options = ElementBoundsOptions {
            ancestors: &[],
            fonts: None,
        };
        let err = element_bounds(&current, &options).unwrap_err();
        assert!(err.message().contains("巢狀超過"));
    }

    #[test]
    fn format_bbox_rounds_each_field_independently() {
        let formatted = format_bbox(&Bbox {
            x: 1.0,
            y: 2.5,
            width: 3.00001,
            height: -0.0,
        });
        assert_eq!(
            formatted,
            FormattedBbox {
                x: "1".to_string(),
                y: "2.5".to_string(),
                width: "3".to_string(),
                height: "0".to_string()
            }
        );
    }
}
