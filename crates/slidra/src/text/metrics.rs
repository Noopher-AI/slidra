//! `measureTextWidth`, ported from `packages/core/src/text-metrics.ts` lines
//! 591-626 (the `FontMetrics`/`parseFont` half of that file lives in
//! `font.rs`).
//!
//! Order matters, exactly as in the TS source: shape first (GSUB ligature
//! substitution over the WHOLE glyph sequence, which can shrink it), then
//! sum font-unit advances *and* GPOS pair kerning between what remains
//! adjacent in one pass, and only at the very end convert the accumulated
//! font-unit sum to pixels with a single division
//! (`sumUnits * fontSizePx / unitsPerEm`). Converting each glyph's width to
//! pixels individually and summing pixel values would silently diverge from
//! this reference on floating-point rounding — never do that.

use crate::errors::{SlidraError, SlidraResult};
use crate::text::font::FontMetrics;

/// Measures the rendered width, in pixels, of `text` at `font_size_px` using
/// `font`. See the module doc comment for the shaping order this must
/// preserve.
pub fn measure_text_width(
    font: &dyn FontMetrics,
    text: &str,
    font_size_px: f64,
) -> SlidraResult<f64> {
    // Validation happens BEFORE the empty-text/zero-size early return below
    // — this is the TS source's own order (`text-metrics.ts` lines 602-607),
    // not incidental: an invalid `font_size_px` still errors even when
    // `text` is empty, a quirk this port preserves rather than "fixes".
    if font_size_px.is_nan() || !font_size_px.is_finite() || font_size_px < 0.0 {
        return Err(SlidraError::invalid("字級必須是非負的有限數"));
    }
    if text.is_empty() || font_size_px == 0.0 {
        return Ok(0.0);
    }

    // Iterate by Unicode scalar value (`char`), matching the TS source's
    // `for (const character of text)` — JS string iteration also yields one
    // full code point per step (never splitting a surrogate pair), so this
    // is the direct Rust equivalent, not an approximation of it.
    let glyph_ids: Vec<u16> = text
        .chars()
        .map(|ch| font.glyph_id_for_code_point(ch as u32))
        .collect();

    let shaped_glyphs = font.substitute_ligatures(&glyph_ids);

    let mut sum_units = 0.0f64;
    for i in 0..shaped_glyphs.len() {
        sum_units += font.advance_width_for_glyph(shaped_glyphs[i]);
        if i + 1 < shaped_glyphs.len() {
            sum_units += font.pair_kerning(shaped_glyphs[i], shaped_glyphs[i + 1]);
        }
    }

    Ok((sum_units * font_size_px) / f64::from(font.units_per_em()))
}

/// Test-only `FontMetrics` mock with made-up but internally-consistent
/// numbers, so `metrics.rs`'s and `wrap.rs`'s own logic (shaping order,
/// greedy line breaking, break rules) can be exercised without needing real
/// TTF/OTF bytes — see `font.rs`'s own tests for coverage of the actual
/// binary parsing, which a hand-rolled mock cannot substitute for.
#[cfg(test)]
pub(crate) mod test_support {
    use super::FontMetrics;
    use std::collections::HashMap;

    pub struct MockFont {
        pub units_per_em: u16,
        pub ascender: i16,
        pub descender: i16,
        pub line_gap: i16,
        /// code point -> glyph id; codepoints absent here resolve to glyph 0
        /// (.notdef), matching real cmap-miss behavior.
        pub cmap: HashMap<u32, u16>,
        /// glyph id -> advance width in font units. Glyph 0 defaults to 0
        /// unless explicitly set.
        pub advances: HashMap<u16, f64>,
        /// contiguous glyph-id sequence -> its ligature replacement glyph.
        pub ligatures: HashMap<Vec<u16>, u16>,
        /// (left glyph, right glyph) -> kerning delta in font units.
        pub kerning: HashMap<(u16, u16), f64>,
    }

    impl Default for MockFont {
        fn default() -> Self {
            MockFont {
                units_per_em: 1000,
                ascender: 800,
                descender: -200,
                line_gap: 0,
                cmap: HashMap::new(),
                advances: HashMap::new(),
                ligatures: HashMap::new(),
                kerning: HashMap::new(),
            }
        }
    }

    impl MockFont {
        /// Convenience for tests: map a single ASCII/BMP char to a glyph id
        /// with a given advance width.
        pub fn with_glyph(mut self, ch: char, glyph_id: u16, advance: f64) -> Self {
            self.cmap.insert(ch as u32, glyph_id);
            self.advances.insert(glyph_id, advance);
            self
        }

        pub fn with_kerning(mut self, a: u16, b: u16, delta: f64) -> Self {
            self.kerning.insert((a, b), delta);
            self
        }

        pub fn with_ligature(mut self, sequence: Vec<u16>, replacement: u16, advance: f64) -> Self {
            self.ligatures.insert(sequence, replacement);
            self.advances.insert(replacement, advance);
            self
        }
    }

    impl FontMetrics for MockFont {
        fn units_per_em(&self) -> u16 {
            self.units_per_em
        }
        fn ascender(&self) -> i16 {
            self.ascender
        }
        fn descender(&self) -> i16 {
            self.descender
        }
        fn line_gap(&self) -> i16 {
            self.line_gap
        }
        fn glyph_id_for_code_point(&self, code_point: u32) -> u16 {
            self.cmap.get(&code_point).copied().unwrap_or(0)
        }
        fn advance_width_for_code_point(&self, code_point: u32) -> f64 {
            self.advance_width_for_glyph(self.glyph_id_for_code_point(code_point))
        }
        fn advance_width_for_glyph(&self, glyph_id: u16) -> f64 {
            self.advances.get(&glyph_id).copied().unwrap_or(0.0)
        }
        fn substitute_ligatures(&self, glyph_ids: &[u16]) -> Vec<u16> {
            if self.ligatures.is_empty() {
                return glyph_ids.to_vec();
            }
            // Longest-sequence-first at each position, mirroring font.rs's
            // "first matching rule wins" GSUB port closely enough for test
            // purposes (this mock has no per-glyph rule ordering to
            // replicate exactly, since callers register whole sequences).
            let mut lens: Vec<usize> = self.ligatures.keys().map(|k| k.len()).collect();
            lens.sort_unstable_by(|a, b| b.cmp(a));
            lens.dedup();

            let mut result = Vec::new();
            let mut i = 0;
            while i < glyph_ids.len() {
                let mut matched = false;
                for &len in &lens {
                    if len == 0 || i + len > glyph_ids.len() {
                        continue;
                    }
                    let candidate = glyph_ids[i..i + len].to_vec();
                    if let Some(&replacement) = self.ligatures.get(&candidate) {
                        result.push(replacement);
                        i += len;
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    result.push(glyph_ids[i]);
                    i += 1;
                }
            }
            result
        }
        fn pair_kerning(&self, glyph_a: u16, glyph_b: u16) -> f64 {
            self.kerning
                .get(&(glyph_a, glyph_b))
                .copied()
                .unwrap_or(0.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MockFont;
    use super::*;

    #[test]
    fn empty_text_is_zero_width_regardless_of_font() {
        let font = MockFont::default().with_glyph('a', 1, 100.0);
        assert_eq!(measure_text_width(&font, "", 24.0).unwrap(), 0.0);
    }

    #[test]
    fn zero_font_size_is_zero_width_for_nonempty_text() {
        let font = MockFont::default().with_glyph('a', 1, 100.0);
        assert_eq!(measure_text_width(&font, "aaa", 0.0).unwrap(), 0.0);
    }

    #[test]
    fn negative_font_size_errors() {
        let font = MockFont::default();
        let err = measure_text_width(&font, "a", -1.0).unwrap_err();
        assert_eq!(err.message(), "字級必須是非負的有限數");
    }

    #[test]
    fn nan_font_size_errors() {
        let font = MockFont::default();
        assert!(measure_text_width(&font, "a", f64::NAN).is_err());
    }

    #[test]
    fn infinite_font_size_errors() {
        let font = MockFont::default();
        assert!(measure_text_width(&font, "a", f64::INFINITY).is_err());
    }

    #[test]
    fn negative_font_size_errors_even_for_empty_text() {
        // Regression for the TS source's exact validation-before-early-return
        // order: an invalid fontSizePx throws even when text === "".
        let font = MockFont::default();
        let err = measure_text_width(&font, "", -1.0).unwrap_err();
        assert_eq!(err.message(), "字級必須是非負的有限數");
    }

    #[test]
    fn sums_glyph_advances_scaled_by_font_size_over_units_per_em() {
        // units_per_em=1000, two glyphs of 100 and 200 units, no kerning/ligature.
        let font = MockFont::default()
            .with_glyph('a', 1, 100.0)
            .with_glyph('b', 2, 200.0);
        // (100+200) units * 20px / 1000 upm = 6px.
        assert_eq!(measure_text_width(&font, "ab", 20.0).unwrap(), 6.0);
    }

    #[test]
    fn applies_pair_kerning_between_adjacent_glyphs() {
        let font = MockFont::default()
            .with_glyph('a', 1, 100.0)
            .with_glyph('b', 2, 200.0)
            .with_kerning(1, 2, 50.0);
        // (100+200+50) units * 10px / 1000 upm = 3.5px.
        assert_eq!(measure_text_width(&font, "ab", 10.0).unwrap(), 3.5);
    }

    #[test]
    fn ligature_substitution_runs_before_summing_so_kerning_never_applies_within_it() {
        let font = MockFont::default()
            .with_glyph('f', 10, 100.0)
            .with_glyph('i', 11, 80.0)
            .with_ligature(vec![10, 11], 99, 150.0)
            .with_kerning(10, 11, 999.0); // must never be applied: glyphs 10,11 never end up adjacent post-ligature
        // Only the ligature glyph's own width counts: 150 units * 10px / 1000 = 1.5px.
        assert_eq!(measure_text_width(&font, "fi", 10.0).unwrap(), 1.5);
    }

    #[test]
    fn uncovered_code_point_falls_back_to_notdef_advance_not_an_error() {
        let font = MockFont::default().with_glyph('\0', 0, 42.0); // glyph 0 = .notdef width 42
        // 'z' is not in the cmap at all -> glyph_id_for_code_point returns 0.
        assert_eq!(measure_text_width(&font, "z", 10.0).unwrap(), 0.42);
    }
}
