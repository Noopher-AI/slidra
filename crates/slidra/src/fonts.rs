// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Resolves every font a presentation embeds, keyed by font-family (plan
//! section 3.2). This is what the text write path (`textbox add`/`text
//! set`/`text style set`/`text list set`/`element style set`) needs to pick
//! the right font for whichever `font-family` a `<text>` node declares, and
//! to hand `wrap_text` a `FontMetrics` it can measure against.
//!
//! Deliberately NOT ported: the TS original's two module-level caches
//! (`fontCache`, keyed by `"<id>\0<family>"`, and the lazily-parsed
//! `defaultFont` singleton). Both exist there because `packages/server`'s
//! `serve` is one long-lived Node process handling many requests against
//! the same presentation — caching avoids re-parsing the same font bytes on
//! every measurement call. This binary is a short-lived CLI process that
//! resolves a presentation's fonts at most once per invocation (each
//! command calls this at most once, and there is only ever one command per
//! process), so there is no second call within a process for a cache to
//! ever hit — adding one here would be dead complexity, not an optimization.
//!
//! `crate::text::font::ParsedFont` does not implement `Clone` (plan section
//! 3.1's API list), so the book is `HashMap<String, Box<dyn FontMetrics>>`
//! (plan's own sketch) rather than a map of owned `ParsedFont` values.

use crate::errors::SlidraResult;
use crate::text::{DEFAULT_FONT_BYTES, DEFAULT_FONT_FAMILY, FontMetrics, parse_font};
use crate::workspace::{self, project, virtual_fs};
use std::collections::HashMap;

/// Resolves presentation `id`'s full font book: the build's own bundled
/// default font under `DEFAULT_FONT_FAMILY`, plus every entry in its
/// `project.json`'s optional `fonts` array, keyed by each entry's
/// `family`. A presentation that declares its own entry for
/// `DEFAULT_FONT_FAMILY` overwrites the bundled default with its own
/// bytes — inserted second, so it wins (mirrors the TS original's own
/// `Map` construction order, plan section 3.2's rule that a presentation
/// declaring its own entry for an existing family name wins over the
/// bundled default).
///
/// `project.json`'s `fonts` field, when present, was already structurally
/// validated by `read_project_json` (required string fields, no duplicate
/// `family`, no path traversal) — this function trusts that and does not
/// re-validate the shape.
pub fn resolve_presentation_fonts(id: &str) -> SlidraResult<HashMap<String, Box<dyn FontMetrics>>> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let project = project::read_project_json(&work_dir)?;

    let mut book: HashMap<String, Box<dyn FontMetrics>> = HashMap::new();
    book.insert(
        DEFAULT_FONT_FAMILY.to_string(),
        Box::new(parse_font(DEFAULT_FONT_BYTES).expect("bundled default font must parse")),
    );

    if let Some(entries) = project.raw.get("fonts").and_then(|value| value.as_array()) {
        for entry in entries {
            // Shape already validated by `read_project_json` (`validate_fonts`).
            let obj = entry.as_object().expect("validated shape");
            let family = obj
                .get("family")
                .and_then(|v| v.as_str())
                .expect("validated shape")
                .to_string();
            let file = obj
                .get("file")
                .and_then(|v| v.as_str())
                .expect("validated shape");
            let bytes = virtual_fs::read_virtual_file_bytes(&work_dir, file)?;
            let font = parse_font(&bytes)?;
            book.insert(family, Box::new(font));
        }
    }

    Ok(book)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        home: PathBuf,
        deck: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, test_id: &str, files: &[(&str, &[u8])]) -> Self {
            let guard = crate::workbench::runtime::ENV_LOCK.lock().unwrap();
            let home = std::env::temp_dir().join(format!(
                "slidra-test-fonts-{label}-home-{}",
                crate::id::random_hex_suffix()
            ));
            std::fs::create_dir_all(&home).unwrap();
            let deck = crate::deck::build_test_deck(label, files);
            crate::workbench::runtime::register_for_test(&home, test_id, &deck);
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            Fixture {
                home,
                deck,
                _guard: guard,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_file(&self.deck).ok();
        }
    }

    #[test]
    fn no_fonts_field_still_resolves_the_bundled_default() {
        let fixture = Fixture::new(
            "no-fonts",
            "pid-no-fonts",
            &[(
                "project.json",
                br#"{"formatVersion":5,"name":"P","canvas":{"width":1,"height":1},"slides":[]}"#,
            )],
        );
        let book = resolve_presentation_fonts("pid-no-fonts").unwrap();
        assert!(book.contains_key(DEFAULT_FONT_FAMILY));
        assert_eq!(book.len(), 1);
        drop(fixture);
    }

    #[test]
    fn declared_font_family_overwrites_the_bundled_default() {
        let project_json = format!(
            r#"{{"formatVersion":5,"name":"P","canvas":{{"width":1,"height":1}},"slides":[],
            "fonts":[{{"file":"assets/fonts/custom.ttf","family":"{DEFAULT_FONT_FAMILY}","license":"OFL","licenseFile":"assets/fonts/custom.ttf","source":"test"}}]}}"#
        );
        let fixture = Fixture::new(
            "override-default",
            "pid-override",
            &[
                ("assets/fonts/custom.ttf", DEFAULT_FONT_BYTES),
                ("project.json", project_json.as_bytes()),
            ],
        );
        let book = resolve_presentation_fonts("pid-override").unwrap();
        // Both the bundled default and the declared override key the SAME
        // family — exactly one entry, proving the second insert won rather
        // than the two silently coexisting under different keys.
        assert_eq!(book.len(), 1);
        assert!(book.contains_key(DEFAULT_FONT_FAMILY));
        drop(fixture);
    }

    #[test]
    fn missing_font_file_is_an_error_not_a_silent_skip() {
        let fixture = Fixture::new(
            "missing-file",
            "pid-missing-font",
            &[(
                "project.json",
                br#"{"formatVersion":5,"name":"P","canvas":{"width":1,"height":1},"slides":[],
                "fonts":[{"file":"assets/fonts/nope.ttf","family":"Nope","license":"OFL","licenseFile":"assets/fonts/nope.ttf","source":"test"}]}"#,
            )],
        );
        // `Box<dyn FontMetrics>` isn't `Debug` (plan section 3.1's trait has
        // no such bound), so `Result::unwrap_err` (which needs the Ok side
        // to be `Debug`) can't be used here — match instead.
        let result = resolve_presentation_fonts("pid-missing-font");
        match result {
            Err(err) => {
                assert!(err.message().contains("nope.ttf") || err.message().contains("read"))
            }
            Ok(_) => panic!("expected a missing font file to error"),
        }
        drop(fixture);
    }
}
