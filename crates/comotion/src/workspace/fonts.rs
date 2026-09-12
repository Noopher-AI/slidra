//! A presentation's embedded font book, ported from
//! `packages/core/src/fonts.ts`'s `resolvePresentationFonts` — the half of
//! that file the write path needs. `measurePresentationText`'s
//! single-family lookup and its process-lifetime parse cache are out of
//! scope here: nothing in this ticket's 26 commands calls either (this
//! crate is a one-shot CLI process, not the long-lived server the TS cache
//! optimizes for), both belong to F4/NOOP-280's text-box measurement port
//! if it turns out to need them.

use crate::errors::CoMotionResult;
use crate::text::font::{DEFAULT_FONT_BYTES, DEFAULT_FONT_FAMILY, ParsedFont, parse_font};
use crate::workspace::{self, virtual_fs};
use std::collections::HashMap;

/// Resolves every font presentation `id` embeds, keyed by `family` — what
/// the table write path (`table::edit`) needs to pick the right font for
/// whichever `font-family` a cell's `<text>` declares, and to hand
/// `wrap_text` a `FontMetrics` it can measure against directly. The build's
/// own default family is always in the book (so a `<text>` that declares no
/// font-family is still measurable in a presentation that embeds nothing);
/// a presentation declaring that same family keeps ITS bytes — its own
/// entry is inserted second and wins, matching the TS original's
/// `Map`-overwrite order.
pub fn resolve_presentation_fonts(id: &str) -> CoMotionResult<HashMap<String, ParsedFont>> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let project = workspace::project::read_project_json(&work_dir)?;

    let mut book = HashMap::new();
    book.insert(
        DEFAULT_FONT_FAMILY.to_string(),
        parse_font(DEFAULT_FONT_BYTES).expect("bundled default font must parse"),
    );

    if let Some(fonts) = project.raw.get("fonts").and_then(|value| value.as_array()) {
        for entry in fonts {
            // Shape already guaranteed by `read_project_json`'s
            // `validate_fonts` (family/file are always present strings).
            let family = entry
                .get("family")
                .and_then(|v| v.as_str())
                .expect("validated by read_project_json");
            let file = entry
                .get("file")
                .and_then(|v| v.as_str())
                .expect("validated by read_project_json");
            let bytes = virtual_fs::read_virtual_file_bytes(&work_dir, file)?;
            let font = parse_font(&bytes)?;
            book.insert(family.to_string(), font);
        }
    }
    Ok(book)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "comotion-test-fonts-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn register(home: &Path, test_id: &str, work_dir: &Path) {
        let work_dir_json =
            serde_json::to_string(&work_dir.to_string_lossy().into_owned()).unwrap();
        let id_json = serde_json::to_string(test_id).unwrap();
        let json = format!(r#"{{{id_json}:{{"workDir":{work_dir_json}}}}}"#);
        std::fs::write(home.join("projects.json"), json).unwrap();
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, test_id: &str) -> Self {
            let guard = workspace::registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            register(&home, test_id, &work);
            unsafe {
                std::env::set_var("COMOTION_HOME", &home);
            }
            Fixture {
                home,
                work,
                _guard: guard,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("COMOTION_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    #[test]
    fn no_fonts_field_still_resolves_the_default_family() {
        let fixture = Fixture::new("no-fonts", "pid-fonts-1");
        std::fs::write(
            fixture.work.join("project.json"),
            r#"{"formatVersion":1,"name":"T","canvas":{"width":1,"height":1},"slides":[]}"#,
        )
        .unwrap();

        let book = resolve_presentation_fonts("pid-fonts-1").unwrap();
        assert!(book.contains_key(DEFAULT_FONT_FAMILY));
        assert_eq!(book.len(), 1);

        drop(fixture);
    }

    #[test]
    fn declared_font_family_is_added_to_the_book() {
        let fixture = Fixture::new("declared-font", "pid-fonts-2");
        std::fs::create_dir_all(fixture.work.join("fonts")).unwrap();
        std::fs::write(fixture.work.join("fonts/custom.ttf"), DEFAULT_FONT_BYTES).unwrap();
        std::fs::write(
            fixture.work.join("project.json"),
            r#"{"formatVersion":1,"name":"T","canvas":{"width":1,"height":1},"slides":[],"fonts":[{"file":"fonts/custom.ttf","family":"Custom Family","license":"OFL","licenseFile":"fonts/OFL.txt","source":"local"}]}"#,
        )
        .unwrap();

        let book = resolve_presentation_fonts("pid-fonts-2").unwrap();
        assert!(book.contains_key(DEFAULT_FONT_FAMILY));
        assert!(book.contains_key("Custom Family"));
        assert_eq!(book.len(), 2);

        drop(fixture);
    }
}
