//! SVG transform maths, ported from `packages/core/src/geometry/transform.ts`.
//! This is the single implementation of "where is this element, really"
//! (ADR-0012: absolute coordinates come from multiplying the container
//! chain) — every function here mirrors one TS export, named verbatim next
//! to it below.
//!
//! Like the TS original, this module reaches for no cross-module
//! dependency for its own tiny "format a number to 4 decimal places" need
//! (`format_number`, private, at the bottom of this file) — `transform.ts`
//! does not import `svg-number.ts` either, it just keeps its own copy of the
//! same idea. This Rust port mirrors that duplication rather than reaching
//! into `crate::svgnum`, on the theory that a 1:1 structural port is easier
//! to audit against the TS source than a "helpfully" de-duplicated one; the
//! two copies (`crate::svgnum::format_svg_number` and this file's
//! `format_number`) need to be kept in sync by hand if the rounding
//! strategy ever changes, exactly as in the TS source.

use crate::errors::{CoMotionError, CoMotionResult};

/// SVG's 2x3 affine matrix, in the same column order as `matrix(a b c d e f)`.
/// Ports the `Matrix` interface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

/// Ports the `Point` interface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Ports the `IDENTITY` constant.
pub const IDENTITY: Matrix = Matrix {
    a: 1.0,
    b: 0.0,
    c: 0.0,
    d: 1.0,
    e: 0.0,
    f: 0.0,
};

const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.0;

/// The character at Rust byte offset `byte_pos`, or `None` past the end.
/// `transform` attribute values are short and always ASCII-structured
/// (numbers, function names, whitespace, commas, parens), but a `data-note`-
/// style Chinese label pasted into the wrong attribute by a caller should
/// still fail soft here rather than panic on a byte-boundary mismatch.
fn char_at(s: &str, byte_pos: usize) -> Option<char> {
    s.get(byte_pos..)?.chars().next()
}

fn find_char_from(s: &str, from: usize, ch: char) -> Option<usize> {
    s.get(from..)?.find(ch).map(|p| from + p)
}

/// Approximates JS regex `\s` (ECMA-262 `WhiteSpace` + `LineTerminator`:
/// TAB, VT, FF, SP, NBSP, ZWNBSP/BOM, LS, PS, plus Unicode's
/// `Space_Separator` general category). Rust's `char::is_whitespace()` uses
/// the Unicode `White_Space` property instead, which is extremely close but
/// not bit-identical (e.g. it additionally treats NEL U+0085 as whitespace,
/// which JS's `\s` does not). `transform` attribute strings in practice only
/// ever contain ASCII whitespace and commas between numbers, so this
/// divergence is believed unreachable on real documents — flagged rather
/// than silently assumed.
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `isSeparator` from `parseTransform`: a comma or any `\s` character.
fn is_separator(ch: char) -> bool {
    ch == ',' || is_js_whitespace(ch)
}

/// How many arguments each SVG transform function accepts (SVG 1.1 S7.4).
/// Ports the `ARITY` table; returns the CoMotionError `parseArguments`
/// throws for a name outside this table instead of a lookup failure, since
/// that is also what happens at the equivalent point in the TS source.
fn arity_for(name: &str) -> CoMotionResult<&'static [usize]> {
    match name {
        "matrix" => Ok(&[6]),
        "translate" => Ok(&[1, 2]),
        "scale" => Ok(&[1, 2]),
        "rotate" => Ok(&[1, 3]),
        "skewX" => Ok(&[1]),
        "skewY" => Ok(&[1]),
        _ => Err(CoMotionError::invalid(format!(
            "不支援的 transform 函式：{name}"
        ))),
    }
}

/// Ports `parseTransform`. `None` stands in for TS's `null`/`undefined`; both
/// that and a whitespace-only string yield `IDENTITY` — "this element has no
/// transform" is the common case, and making it the identity means it is
/// never a special case anywhere downstream.
///
/// Anything it cannot make sense of — an unknown function name, the wrong
/// number of arguments, a non-numeric argument, an unclosed parenthesis —
/// returns `Err` instead of being skipped, matching the TS source's own
/// reasoning: a silently-dropped transform would move the element, which is
/// the one failure this module must never produce quietly.
pub fn parse_transform(value: Option<&str>) -> CoMotionResult<Matrix> {
    let text = match value {
        None => return Ok(IDENTITY),
        Some(v) => v.trim(),
    };
    if text.is_empty() {
        return Ok(IDENTITY);
    }

    let mut result = IDENTITY;
    let mut i = 0usize;

    while i < text.len() {
        while i < text.len() {
            match char_at(text, i) {
                Some(c) if is_separator(c) => i += c.len_utf8(),
                _ => break,
            }
        }
        if i >= text.len() {
            break;
        }

        let name_start = i;
        while i < text.len() {
            match char_at(text, i) {
                Some(c) if c.is_ascii_alphabetic() => i += c.len_utf8(),
                _ => break,
            }
        }
        let name = &text[name_start..i];
        if name.is_empty() {
            return Err(CoMotionError::invalid(format!(
                "transform 語法錯誤：無法解析函式名稱（{text}）"
            )));
        }

        while i < text.len() {
            match char_at(text, i) {
                Some(c) if is_js_whitespace(c) => i += c.len_utf8(),
                _ => break,
            }
        }
        if char_at(text, i) != Some('(') {
            return Err(CoMotionError::invalid(format!(
                "transform 語法錯誤：{name} 後面缺少 ("
            )));
        }
        let close = match find_char_from(text, i, ')') {
            Some(p) => p,
            None => {
                return Err(CoMotionError::invalid(format!(
                    "transform 語法錯誤：{name} 的括號未封閉"
                )));
            }
        };
        let args = parse_arguments(name, &text[i + 1..close])?;
        i = close + 1; // ')' is one ASCII byte

        result = multiply_matrices(&result, &function_to_matrix(name, &args)?);
    }

    Ok(result)
}

/// Ports the number-literal check `parseArguments` runs per token:
/// `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/`. `Number()` in JS also
/// accepts `""` and `"0x10"`; this hand-rolled check (matching the TS
/// source's own hand-rolled regex, not a bare `Number()`/`str::parse`) is
/// what keeps this to the decimal-number syntax SVG actually defines.
fn is_svg_number_token(token: &str) -> bool {
    let mut chars = token.chars().peekable();
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

    // `(\d+\.?\d*|\.\d+)`: either at least one integer digit (dot and
    // fraction digits both optional), or a dot followed by at least one
    // fraction digit with no integer digit at all.
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

/// Ports `parseArguments`.
fn parse_arguments(name: &str, args_text: &str) -> CoMotionResult<Vec<f64>> {
    let arity = arity_for(name)?;

    let tokens: Vec<&str> = args_text
        .split(|c: char| c == ',' || is_js_whitespace(c))
        .filter(|t| !t.is_empty())
        .collect();

    let mut values = Vec::with_capacity(tokens.len());
    for token in tokens {
        if !is_svg_number_token(token) {
            return Err(CoMotionError::invalid(format!(
                "transform 語法錯誤：{name} 的參數不是數字（{token}）"
            )));
        }
        // `is_svg_number_token` already restricted `token` to the exact
        // grammar `str::parse::<f64>` accepts for a plain decimal/exponent
        // literal (no hex, no "inf"/"nan", no stray whitespace) — this is
        // believed to hold for every token that passes the check above, but
        // has not been verified against Rust's `dec2flt` grammar
        // char-for-char in an environment with a Rust compiler available;
        // flagged here rather than silently assumed watertight.
        let value: f64 = token.parse().map_err(|_| {
            CoMotionError::invalid(format!(
                "transform 語法錯誤：{name} 的參數不是數字（{token}）"
            ))
        })?;
        values.push(value);
    }

    if !arity.contains(&values.len()) {
        let arity_desc = arity
            .iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(" 或 ");
        return Err(CoMotionError::invalid(format!(
            "transform 語法錯誤：{name} 收到 {} 個參數，應為 {arity_desc} 個",
            values.len()
        )));
    }
    Ok(values)
}

/// The final `_ =>` arm mirrors the TS `switch`'s
/// own `default` case, which is unreachable in practice today (every name
/// `arity_for` accepts is handled above) but throws the same "unsupported
/// transform function" error rather than panicking if the two tables ever
/// drift out of sync — matching the TS source's defensive-but-dead branch
/// exactly rather than replacing it with an `unreachable!()` that would turn
/// a future drift into a crash instead of a clean error.
fn function_to_matrix(name: &str, args: &[f64]) -> CoMotionResult<Matrix> {
    match name {
        "matrix" => Ok(Matrix {
            a: args[0],
            b: args[1],
            c: args[2],
            d: args[3],
            e: args[4],
            f: args[5],
        }),
        "translate" => Ok(Matrix {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: args[0],
            f: if args.len() == 2 { args[1] } else { 0.0 },
        }),
        "scale" => {
            let sx = args[0];
            let sy = if args.len() == 2 { args[1] } else { sx };
            Ok(Matrix {
                a: sx,
                b: 0.0,
                c: 0.0,
                d: sy,
                e: 0.0,
                f: 0.0,
            })
        }
        "rotate" => {
            let radians = args[0] * DEG_TO_RAD;
            let (sin, cos) = radians.sin_cos();
            let rotation = Matrix {
                a: cos,
                b: sin,
                c: -sin,
                d: cos,
                e: 0.0,
                f: 0.0,
            };
            if args.len() == 1 {
                return Ok(rotation);
            }
            // rotate(angle cx cy) === translate(cx cy) rotate(angle) translate(-cx -cy)
            let (cx, cy) = (args[1], args[2]);
            let to_center = Matrix {
                e: cx,
                f: cy,
                ..IDENTITY
            };
            let from_center = Matrix {
                e: -cx,
                f: -cy,
                ..IDENTITY
            };
            Ok(multiply_matrices(
                &multiply_matrices(&to_center, &rotation),
                &from_center,
            ))
        }
        "skewX" => Ok(Matrix {
            a: 1.0,
            b: 0.0,
            c: (args[0] * DEG_TO_RAD).tan(),
            d: 1.0,
            e: 0.0,
            f: 0.0,
        }),
        "skewY" => Ok(Matrix {
            a: 1.0,
            b: (args[0] * DEG_TO_RAD).tan(),
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        }),
        _ => Err(CoMotionError::invalid(format!(
            "不支援的 transform 函式：{name}"
        ))),
    }
}

/// Ports `multiplyMatrix`: `outer` composed with `inner` applied first,
/// matching `<g transform=outer><g transform=inner>`.
pub fn multiply_matrices(outer: &Matrix, inner: &Matrix) -> Matrix {
    Matrix {
        a: outer.a * inner.a + outer.c * inner.b,
        b: outer.b * inner.a + outer.d * inner.b,
        c: outer.a * inner.c + outer.c * inner.d,
        d: outer.b * inner.c + outer.d * inner.d,
        e: outer.a * inner.e + outer.c * inner.f + outer.e,
        f: outer.b * inner.e + outer.d * inner.f + outer.f,
    }
}

/// Ports `composeMatrices`: multiplies a root-to-leaf container chain. An
/// empty chain is `IDENTITY`.
pub fn compose_matrices(chain: &[Matrix]) -> Matrix {
    let mut result = IDENTITY;
    for matrix in chain {
        result = multiply_matrices(&result, matrix);
    }
    result
}

/// Ports `applyMatrixToPoint`.
pub fn apply_matrix_to_point(m: &Matrix, p: Point) -> Point {
    Point {
        x: m.a * p.x + m.c * p.y + m.e,
        y: m.b * p.x + m.d * p.y + m.f,
    }
}

/// Ports `invertMatrix`. A degenerate matrix (zero determinant) returns
/// `Err` rather than a matrix full of infinities/NaNs.
pub fn invert_matrix(m: &Matrix) -> CoMotionResult<Matrix> {
    let det = m.a * m.d - m.b * m.c;
    if det == 0.0 {
        return Err(CoMotionError::invalid(
            "transform 無法反轉：矩陣的行列式為 0",
        ));
    }
    Ok(Matrix {
        a: m.d / det,
        b: -m.b / det,
        c: -m.c / det,
        d: m.a / det,
        e: (m.c * m.f - m.d * m.e) / det,
        f: (m.b * m.e - m.a * m.f) / det,
    })
}

/// Ports the `TransformParts` interface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransformParts {
    pub translate_x: f64,
    pub translate_y: f64,
    /// Degrees, same unit and sign convention as SVG's `rotate()` (positive
    /// is clockwise).
    pub rotation: f64,
    pub scale_x: f64,
    pub scale_y: f64,
}

/// Ports `decomposeMatrix`: splits a matrix into translate / rotate / scale.
///
/// A matrix carrying skew (its two basis vectors are not perpendicular) has
/// no meaning in this model, so this returns `Err` rather than a rotation
/// and scale that would not reproduce it.
pub fn decompose_matrix(m: &Matrix) -> CoMotionResult<TransformParts> {
    let scale_x = m.a.hypot(m.b);
    let determinant = m.a * m.d - m.b * m.c;
    if scale_x == 0.0 || determinant == 0.0 {
        return Err(CoMotionError::invalid(
            "transform 無法拆解：矩陣已退化（縮放為 0）",
        ));
    }
    // With no skew, (a, b) and (c, d) are perpendicular. Comparing their dot
    // product against the magnitudes rather than against an absolute
    // epsilon means the test means the same thing at any scale.
    let scale_y_raw = m.c.hypot(m.d);
    let dot = m.a * m.c + m.b * m.d;
    if dot.abs() > 1e-9 * scale_x * scale_y_raw {
        return Err(CoMotionError::invalid(
            "transform 無法拆解：矩陣含有傾斜（skew），這個模型沒有傾斜的語意",
        ));
    }
    Ok(TransformParts {
        translate_x: m.e,
        translate_y: m.f,
        rotation: m.b.atan2(m.a) / DEG_TO_RAD,
        scale_x,
        // determinant < 0 means one axis is mirrored; hypot alone cannot see it.
        scale_y: if determinant < 0.0 {
            -scale_y_raw
        } else {
            scale_y_raw
        },
    })
}

/// Ports the private `formatNumber` helper: rounds to 4 decimal places and
/// drops trailing zeros. Same rounding/formatting strategy as
/// `crate::svgnum::format_svg_number` (see that module's doc comment for the
/// `toFixed`/tie-break caveats, which apply identically here) — deliberately
/// not shared code, see this file's module doc comment for why.
fn format_number(value: f64) -> String {
    let rounded: f64 = format!("{value:.4}").parse().unwrap_or(0.0);
    if rounded == 0.0 {
        "0".to_string()
    } else {
        format!("{rounded}")
    }
}

/// Ports `formatTransform`: serializes parts back into a transform-list,
/// e.g. `"translate(640 330) rotate(-15)"`. Segments sitting at their
/// default value are omitted, and an all-default parts object yields the
/// empty string so the caller can decide to write no `transform` attribute
/// at all (ADR-0004: every byte of SVG is a per-turn token cost).
pub fn format_transform(parts: &TransformParts) -> String {
    let mut segments: Vec<String> = Vec::new();

    let tx = format_number(parts.translate_x);
    let ty = format_number(parts.translate_y);
    if tx != "0" || ty != "0" {
        segments.push(format!("translate({tx} {ty})"));
    }

    let rotation = format_number(parts.rotation);
    if rotation != "0" {
        segments.push(format!("rotate({rotation})"));
    }

    let sx = format_number(parts.scale_x);
    let sy = format_number(parts.scale_y);
    if sx != "1" || sy != "1" {
        segments.push(format!("scale({sx} {sy})"));
    }

    segments.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    fn assert_matrix_close(actual: Matrix, expected: Matrix) {
        assert!(
            (actual.a - expected.a).abs() < EPS,
            "a: {} vs {}",
            actual.a,
            expected.a
        );
        assert!(
            (actual.b - expected.b).abs() < EPS,
            "b: {} vs {}",
            actual.b,
            expected.b
        );
        assert!(
            (actual.c - expected.c).abs() < EPS,
            "c: {} vs {}",
            actual.c,
            expected.c
        );
        assert!(
            (actual.d - expected.d).abs() < EPS,
            "d: {} vs {}",
            actual.d,
            expected.d
        );
        assert!(
            (actual.e - expected.e).abs() < EPS,
            "e: {} vs {}",
            actual.e,
            expected.e
        );
        assert!(
            (actual.f - expected.f).abs() < EPS,
            "f: {} vs {}",
            actual.f,
            expected.f
        );
    }

    #[test]
    fn none_and_blank_and_whitespace_only_all_yield_identity() {
        assert_eq!(parse_transform(None).unwrap(), IDENTITY);
        assert_eq!(parse_transform(Some("")).unwrap(), IDENTITY);
        assert_eq!(parse_transform(Some("   \t  ")).unwrap(), IDENTITY);
    }

    #[test]
    fn translate_with_one_argument_defaults_y_to_zero() {
        let m = parse_transform(Some("translate(10)")).unwrap();
        assert_matrix_close(
            m,
            Matrix {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 10.0,
                f: 0.0,
            },
        );
    }

    #[test]
    fn translate_with_two_arguments_and_comma_separator() {
        let m = parse_transform(Some("translate(10, 20)")).unwrap();
        assert_matrix_close(
            m,
            Matrix {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 10.0,
                f: 20.0,
            },
        );
    }

    #[test]
    fn scale_with_one_argument_applies_uniformly() {
        let m = parse_transform(Some("scale(2)")).unwrap();
        assert_matrix_close(
            m,
            Matrix {
                a: 2.0,
                b: 0.0,
                c: 0.0,
                d: 2.0,
                e: 0.0,
                f: 0.0,
            },
        );
    }

    #[test]
    fn rotate_90_degrees_matches_hand_computed_matrix() {
        // cos(90) = 0, sin(90) = 1 -- exact values, not implementation output.
        let m = parse_transform(Some("rotate(90)")).unwrap();
        assert_matrix_close(
            m,
            Matrix {
                a: 0.0,
                b: 1.0,
                c: -1.0,
                d: 0.0,
                e: 0.0,
                f: 0.0,
            },
        );
    }

    #[test]
    fn rotate_around_a_center_point_matches_translate_rotate_translate_composition() {
        // rotate(angle cx cy) is documented (SVG 1.1 S7.6) to be exactly
        // translate(cx cy) rotate(angle) translate(-cx -cy); this test
        // builds the right-hand side independently via `translate`/`rotate`
        // parsing plus explicit multiplication, rather than reusing
        // `rotate`'s own internal center-point branch, as the expectation.
        let combined = parse_transform(Some("rotate(90 10 20)")).unwrap();
        let translate_to = parse_transform(Some("translate(10 20)")).unwrap();
        let rotate_only = parse_transform(Some("rotate(90)")).unwrap();
        let translate_back = parse_transform(Some("translate(-10 -20)")).unwrap();
        let expected = multiply_matrices(
            &multiply_matrices(&translate_to, &rotate_only),
            &translate_back,
        );
        assert_matrix_close(combined, expected);
    }

    #[test]
    fn multiple_functions_compose_left_to_right_as_outer_then_inner() {
        // "translate(10 0) scale(2)" applied to a point should first scale,
        // then translate (outer-applied-last), matching
        // `<g transform="translate(10 0)"><g transform="scale(2)">`.
        let m = parse_transform(Some("translate(10 0) scale(2)")).unwrap();
        let p = apply_matrix_to_point(&m, Point { x: 3.0, y: 5.0 });
        assert!((p.x - 16.0).abs() < EPS); // 3*2 + 10
        assert!((p.y - 10.0).abs() < EPS); // 5*2
    }

    #[test]
    fn matrix_function_maps_arguments_positionally() {
        let m = parse_transform(Some("matrix(1 2 3 4 5 6)")).unwrap();
        assert_matrix_close(
            m,
            Matrix {
                a: 1.0,
                b: 2.0,
                c: 3.0,
                d: 4.0,
                e: 5.0,
                f: 6.0,
            },
        );
    }

    #[test]
    fn unknown_function_name_is_an_error() {
        let err = parse_transform(Some("foo(1)")).unwrap_err();
        assert!(err.message().contains("不支援的 transform 函式"));
    }

    #[test]
    fn missing_open_paren_is_an_error() {
        let err = parse_transform(Some("translate")).unwrap_err();
        assert!(err.message().contains("後面缺少"));
    }

    #[test]
    fn unclosed_paren_is_an_error() {
        let err = parse_transform(Some("translate(10")).unwrap_err();
        assert!(err.message().contains("括號未封閉"));
    }

    #[test]
    fn non_numeric_argument_is_an_error() {
        let err = parse_transform(Some("translate(abc)")).unwrap_err();
        assert!(err.message().contains("不是數字"));
    }

    #[test]
    fn wrong_argument_count_is_an_error() {
        let err = parse_transform(Some("translate(1 2 3)")).unwrap_err();
        assert!(err.message().contains("應為"));
    }

    #[test]
    fn multiply_matrices_applies_inner_first() {
        // outer = translate(10,0), inner = scale(2) -> outer(inner(p))
        let outer = Matrix {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 10.0,
            f: 0.0,
        };
        let inner = Matrix {
            a: 2.0,
            b: 0.0,
            c: 0.0,
            d: 2.0,
            e: 0.0,
            f: 0.0,
        };
        let combined = multiply_matrices(&outer, &inner);
        let p = apply_matrix_to_point(&combined, Point { x: 3.0, y: 3.0 });
        assert!((p.x - 16.0).abs() < EPS);
        assert!((p.y - 6.0).abs() < EPS);
    }

    #[test]
    fn compose_matrices_of_empty_chain_is_identity() {
        assert_eq!(compose_matrices(&[]), IDENTITY);
    }

    #[test]
    fn invert_matrix_undoes_the_original() {
        let m = Matrix {
            a: 2.0,
            b: 0.0,
            c: 0.0,
            d: 4.0,
            e: 10.0,
            f: -5.0,
        };
        let inv = invert_matrix(&m).unwrap();
        let round_trip = multiply_matrices(&inv, &m);
        assert_matrix_close(round_trip, IDENTITY);
    }

    #[test]
    fn invert_degenerate_matrix_is_an_error() {
        let m = Matrix {
            a: 0.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
            e: 0.0,
            f: 0.0,
        };
        let err = invert_matrix(&m).unwrap_err();
        assert!(err.message().contains("無法反轉"));
    }

    #[test]
    fn decompose_recovers_translate_rotate_scale() {
        let m = parse_transform(Some("translate(5 7) rotate(30) scale(2 3)")).unwrap();
        let parts = decompose_matrix(&m).unwrap();
        assert!((parts.translate_x - 5.0).abs() < EPS);
        assert!((parts.translate_y - 7.0).abs() < EPS);
        assert!((parts.rotation - 30.0).abs() < EPS);
        assert!((parts.scale_x - 2.0).abs() < EPS);
        assert!((parts.scale_y - 3.0).abs() < EPS);
    }

    #[test]
    fn decompose_degenerate_zero_scale_is_an_error() {
        let m = Matrix {
            a: 0.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
            e: 0.0,
            f: 0.0,
        };
        let err = decompose_matrix(&m).unwrap_err();
        assert!(err.message().contains("已退化"));
    }

    #[test]
    fn decompose_skewed_matrix_is_an_error() {
        // (a,b) = (1,0), (c,d) = (1,1): not perpendicular -- carries skew.
        let m = Matrix {
            a: 1.0,
            b: 0.0,
            c: 1.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        };
        let err = decompose_matrix(&m).unwrap_err();
        assert!(err.message().contains("傾斜"));
    }

    #[test]
    fn format_transform_of_all_defaults_is_empty_string() {
        let parts = TransformParts {
            translate_x: 0.0,
            translate_y: 0.0,
            rotation: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
        };
        assert_eq!(format_transform(&parts), "");
    }

    #[test]
    fn format_transform_omits_default_segments_and_keeps_the_rest() {
        let parts = TransformParts {
            translate_x: 0.0,
            translate_y: 0.0,
            rotation: -15.0,
            scale_x: 1.0,
            scale_y: 1.0,
        };
        assert_eq!(format_transform(&parts), "rotate(-15)");
    }

    #[test]
    fn format_transform_includes_translate_and_scale_with_expected_text() {
        let parts = TransformParts {
            translate_x: 640.0,
            translate_y: 330.0,
            rotation: 0.0,
            scale_x: 2.0,
            scale_y: 2.0,
        };
        assert_eq!(format_transform(&parts), "translate(640 330) scale(2 2)");
    }
}
