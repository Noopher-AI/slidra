//! `formatSvgNumber`, ported from `packages/core/src/svg-number.ts` (10
//! lines in TS, all of it subtle):
//!
//! ```ts
//! export function formatSvgNumber(value: number): string {
//!   const rounded = Number(value.toFixed(4));
//!   return String(rounded === 0 ? 0 : rounded);
//! }
//! ```
//!
//! This is the project's single serialization rule for an SVG numeric
//! attribute: round to 4 decimal places, then print the shortest string that
//! reads back to that value, collapsing `-0` to `0`. It composes two
//! separate pieces of native JS number behavior that this file has to
//! reproduce without a JS engine to check against — see `js_to_fixed_4` and
//! the module-level `KNOWN GAP` note below for exactly where confidence runs
//! out.

/// Ports `formatSvgNumber` from `svg-number.ts`.
///
/// # Panics
///
/// Panics if `value` is not finite (`NaN` or `+-inf`). Unlike a malformed
/// transform string or malformed markup — user-facing input this codebase
/// must reject cleanly with a `CoMotionError` — a non-finite number reaching
/// this function is never legitimate: it always means some upstream
/// computation (a divide-by-zero, an unresolved geometry) already went
/// wrong. Emitting the literal strings `"NaN"` / `"Infinity"` into an SVG
/// attribute (what JS's `String()` would do) would hide that bug inside
/// output that looks superficially like a number. A panic makes the bug
/// loud at its actual source instead of silently producing invalid SVG;
/// `CoMotionError` is reserved for input this module cannot control, which
/// a caller passing it a float it just computed is not.
pub fn format_svg_number(value: f64) -> String {
    assert!(
        value.is_finite(),
        "format_svg_number: value must be finite, got {value}"
    );

    let rounded = js_to_fixed_4(value);
    if rounded == 0.0 {
        // `-0 === 0` in JS, so `rounded === 0 ? 0 : rounded` always prints
        // the literal `0`, never `-0`, for either zero. `rounded == 0.0` is
        // likewise `true` for `-0.0_f64` under IEEE 754 equality, so this
        // branch does the same collapsing.
        "0".to_string()
    } else {
        format_js_number(rounded)
    }
}

/// Ports `Number(value.toFixed(4))` — the `toFixed` half, before the
/// `Number(...)` re-parse collapses any trailing zeros `toFixed` printed.
///
/// Per ECMA-262, `toFixed` rounds the double's *exact* binary value to the
/// requested number of decimal digits, picking whichever candidate decimal
/// value is closer to that exact value (and, on a genuine exact tie, the
/// larger one). Rust's `{:.4}` formatting is also a correctly-rounded
/// decimal expansion of the exact binary value, so for the overwhelming
/// majority of inputs the two agree digit-for-digit — reformatting through a
/// string and reparsing, rather than computing a rounded `f64` by
/// multiplying/dividing by `10_000.0`, is deliberate: `value * 10_000.0`
/// introduces its own rounding error before the "round to 4 places" step
/// even happens, which `toFixed` does not.
///
/// KNOWN RISK, isolated to this function on purpose so it's easy to find and
/// fix later: the only place the two could diverge is an exact tie at the
/// 5th decimal digit of the true binary value. Rust resolves such ties
/// round-half-to-even; JS resolves them toward the larger candidate (i.e.
/// toward +infinity, not "away from zero"). This has NOT been verified
/// against a real JS engine in this environment (no JS runtime was
/// available while writing this port) — only reasoned about from the
/// ECMA-262 text and cross-checked for a couple of concrete values using
/// Python's `decimal.Decimal(float)` (which exposes the same IEEE-754
/// binary64 bit pattern JS uses) to confirm they are not actually exact
/// ties once you look at the real stored value — see the `to_fixed_4`
/// boundary test below for the specific values checked this way.
fn js_to_fixed_4(value: f64) -> f64 {
    let fixed = format!("{value:.4}");
    fixed
        .parse::<f64>()
        .expect("a `{:.4}`-formatted f64 string always reparses as f64")
}

/// Ports `String(Number)`, used both by the non-zero branch of
/// `format_svg_number` below AND — made `pub` by NOOP-281/F5 — directly by
/// callers that need JS's bare `String(number)` semantics WITHOUT
/// `formatSvgNumber`'s 4-decimal rounding: chart data-label text
/// (`chart/render.ts`'s `esc(String(value))`) and `table/edit.ts`'s
/// `translate(${x} ${y})` transform, both confirmed (plan section 4.6) to
/// use plain `String(Number)`, not `formatSvgNumber`.
///
/// Rust's `f64` `Display` impl produces the shortest decimal string that
/// round-trips back to the same `f64` — the same *goal* as JS's
/// `Number::toString()` / `String()`, though not proven to be bit-for-bit
/// the same algorithm. For this project's realistic coordinate range (SVG
/// canvas units, roughly 1e-4 to 1e5) they are expected to agree.
///
/// KNOWN GAP (out of scope for now, not silently assumed away): JS's
/// `String(Number)` switches to exponential notation for magnitudes
/// `>= 1e21` or `< 1e-6` (e.g. `String(1e21) === "1e+21"`,
/// `String(0.0000001) === "1e-7"`). Rust's `f64` `Display` NEVER emits
/// exponential notation — `format!("{}", 1e21_f64)` prints out every
/// integer digit instead of `"1e+21"`. Reimplementing JS's exact dtoa
/// algorithm (including its exponential-notation thresholds) purely to
/// cover a magnitude range no SVG coordinate or transform value in this
/// codebase will ever reach is over-engineering for this ticket; flagging
/// it here is instead of silently assuming it away. Chart/table golden
/// fixtures must not exercise this range — see plan section 4.6's final row.
pub fn format_js_number(value: f64) -> String {
    format!("{value}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_formats_as_bare_zero() {
        assert_eq!(format_svg_number(0.0), "0");
    }

    #[test]
    fn negative_zero_formats_as_bare_zero() {
        assert_eq!(format_svg_number(-0.0), "0");
    }

    #[test]
    fn typical_decimal_round_trips_without_trailing_zeros() {
        assert_eq!(format_svg_number(27.84), "27.84");
    }

    #[test]
    fn whole_number_has_no_decimal_point() {
        // Regression for the specific behavior `toFixed` + `Number` + `String`
        // composes: NOT "300.0000", NOT "300.0" (Rust's naive float Display
        // would already avoid the latter, but the point of the pipeline is
        // that `toFixed`'s fixed-width string is deliberately re-parsed away).
        assert_eq!(format_svg_number(300.0), "300");
    }

    #[test]
    fn negative_number_keeps_its_sign() {
        assert_eq!(format_svg_number(-12.5), "-12.5");
    }

    #[test]
    fn to_fixed_4_boundary_case_rounds_using_the_actual_stored_binary_value() {
        // 0.30005 is NOT exactly representable in binary64; its actual
        // stored value is 0.300049999999999983391063551607658155262470245...
        // (confirmed via Python's `decimal.Decimal(0.30005)`, which exposes
        // the exact bit pattern IEEE-754 binary64 stores — the same
        // representation JS's `number` type uses). That value sits *below*
        // the 0.30005 midpoint between 0.3000 and 0.3001, so this is not an
        // exact tie needing JS's "pick the larger candidate" tie-break rule
        // at all — both `toFixed` and Rust's `{:.4}` should round it down to
        // "0.3000" for the same reason (nearest-value rounding, no tie),
        // giving `Number("0.3000") === 0.3` and `String(0.3) === "0.3"`.
        assert_eq!(format_svg_number(0.30005), "0.3");
    }

    #[test]
    fn to_fixed_4_boundary_case_rounds_up_when_the_stored_value_is_just_above() {
        // Same reasoning as above, opposite direction: 1.00005's actual
        // stored binary64 value is 1.0000500000000001055155962603748776...
        // (again confirmed via Python's `Decimal(float)`), which sits just
        // *above* the midpoint, so both `toFixed` and `{:.4}` round up to
        // "1.0001" — again not a genuine tie.
        assert_eq!(format_svg_number(1.00005), "1.0001");
    }

    #[test]
    #[should_panic]
    fn nan_panics_rather_than_formatting() {
        format_svg_number(f64::NAN);
    }

    #[test]
    #[should_panic]
    fn infinity_panics_rather_than_formatting() {
        format_svg_number(f64::INFINITY);
    }
}
