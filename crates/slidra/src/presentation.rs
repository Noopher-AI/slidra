//! `FORMAT_VERSION` and `build_minimal_presentation`,
//! originally ported from `packages/core/src/presentation.ts` ([E4.T12]
//! deletes that TypeScript source; Rust is now the sole implementation).
//!
//! `FORMAT_VERSION` is **1**: there is no migration chain. `open` and
//! `validate_project_json` reject any other value outright, and `new`
//! produces `formatVersion: 1` directly.

pub const FORMAT_VERSION: u32 = 1;

const PRESENTATION_FONT_FAMILY: &str = "Noto Sans TC";
const PRESENTATION_FONT_FILE: &str = "fonts/NotoSansTC-Presentation.ttf";
const PRESENTATION_FONT_LICENSE_FILE: &str = "fonts/LICENSE-NotoSansTC.txt";

/// The project's bundled default font and its license text, embedded at
/// compile time (ADR-0016) — same relative-path convention `text::font`'s
/// `DEFAULT_FONT_BYTES` uses.
const PRESENTATION_FONT_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../assets/fonts/NotoSansTC-Presentation.ttf"
));
const PRESENTATION_FONT_LICENSE_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../assets/fonts/LICENSE-NotoSansTC.txt"
));

/// Builds the file set for a minimal presentation (ADR-0003 container
/// shape): `project.json` with **no slides** (ADR-0018: a new presentation
/// starts empty so the first page is whatever the author or the agent
/// makes first, never an unstyled placeholder) + the embedded presentation
/// font (ADR-0016) + its license text. Returns `(relative_path, bytes)`
/// pairs — `assets/`/`fonts/`/`slides/` themselves are not listed (the
/// caller creates them, or `container::pack_directory` adds empty
/// directory entries for them automatically).
pub fn build_minimal_presentation(name: &str) -> Vec<(String, Vec<u8>)> {
    let project = serde_json::json!({
        "formatVersion": FORMAT_VERSION,
        "name": name,
        "canvas": { "width": 1280, "height": 720 },
        "slides": [],
        "fonts": [
            {
                "file": PRESENTATION_FONT_FILE,
                "family": PRESENTATION_FONT_FAMILY,
                "license": "SIL Open Font License 1.1",
                "licenseFile": PRESENTATION_FONT_LICENSE_FILE,
                "source": "https://fonts.google.com/noto/specimen/Noto+Sans+TC",
            },
        ],
    });
    let mut project_json =
        serde_json::to_string_pretty(&project).expect("Value serialization cannot fail");
    project_json.push('\n');

    vec![
        ("project.json".to_string(), project_json.into_bytes()),
        (
            PRESENTATION_FONT_FILE.to_string(),
            PRESENTATION_FONT_BYTES.to_vec(),
        ),
        (
            PRESENTATION_FONT_LICENSE_FILE.to_string(),
            PRESENTATION_FONT_LICENSE_BYTES.to_vec(),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_formatversion_1_with_no_slides() {
        let files = build_minimal_presentation("test presentation");
        let (_, project_bytes) = files
            .iter()
            .find(|(path, _)| path == "project.json")
            .unwrap();
        let project: serde_json::Value = serde_json::from_slice(project_bytes).unwrap();
        assert_eq!(project["formatVersion"], 1);
        assert_eq!(project["name"], "test presentation");
        assert_eq!(project["slides"], serde_json::json!([]));
        assert_eq!(project["fonts"][0]["family"], "Noto Sans TC");
        assert!(files.iter().all(|(path, _)| !path.starts_with("slides/")));
    }

    #[test]
    fn embeds_the_bundled_font_and_its_license() {
        let files = build_minimal_presentation("X");
        let (_, font_bytes) = files
            .iter()
            .find(|(path, _)| path == "fonts/NotoSansTC-Presentation.ttf")
            .unwrap();
        assert!(!font_bytes.is_empty());
        let (_, license_bytes) = files
            .iter()
            .find(|(path, _)| path == "fonts/LICENSE-NotoSansTC.txt")
            .unwrap();
        assert!(!license_bytes.is_empty());
    }
}
