//! `FORMAT_VERSION`, `SLIDE_FILE_NAME`, and `build_minimal_presentation`,
//! originally ported from `packages/core/src/presentation.ts` ([E4.T12]
//! deletes that TypeScript source; Rust is now the sole implementation).
//!
//! `FORMAT_VERSION` is **4**: Rust's `open` performs the 1→2→3→4 migration,
//! and `new` produces `formatVersion: 4` directly, so the crate's own idea
//! of "current" format version is 4.

use crate::id::generate_opaque_id;

pub const FORMAT_VERSION: u32 = 4;

pub const SLIDE_FILE_NAME: &str = "slides/001.svg";

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

fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Builds the file set for a minimal presentation (ADR-0003 container
/// shape): `project.json` + a single title slide + the embedded
/// presentation font (ADR-0016) + its license text. Returns
/// `(relative_path, bytes)` pairs — `assets/`/`fonts/` themselves are not
/// listed (the caller creates them, or `container::pack_directory` adds
/// empty directory entries for them automatically).
pub fn build_minimal_presentation(name: &str) -> Vec<(String, Vec<u8>)> {
    let project = serde_json::json!({
        "formatVersion": FORMAT_VERSION,
        "name": name,
        "canvas": { "width": 1280, "height": 720 },
        "slides": [SLIDE_FILE_NAME],
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

    let title_element_id = format!("el-{}", generate_opaque_id());
    let slide_svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\">\n  <text id=\"{title_element_id}\" data-comot-name=\"標題\" x=\"640\" y=\"360\" text-anchor=\"middle\" font-family=\"{PRESENTATION_FONT_FAMILY}\" font-size=\"48\">{}</text>\n</svg>\n",
        escape_xml_text(name)
    );

    vec![
        ("project.json".to_string(), project_json.into_bytes()),
        (SLIDE_FILE_NAME.to_string(), slide_svg.into_bytes()),
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
    fn produces_formatversion_4_directly() {
        let files = build_minimal_presentation("測試簡報");
        let (_, project_bytes) = files
            .iter()
            .find(|(path, _)| path == "project.json")
            .unwrap();
        let project: serde_json::Value = serde_json::from_slice(project_bytes).unwrap();
        assert_eq!(project["formatVersion"], 4);
        assert_eq!(project["slides"], serde_json::json!(["slides/001.svg"]));
        assert_eq!(project["fonts"][0]["family"], "Noto Sans TC");
    }

    #[test]
    fn escapes_the_presentation_name_in_the_slide_svg() {
        let files = build_minimal_presentation("A & <B>");
        let (_, svg_bytes) = files
            .iter()
            .find(|(path, _)| path == SLIDE_FILE_NAME)
            .unwrap();
        let svg = String::from_utf8(svg_bytes.clone()).unwrap();
        assert!(svg.contains("A &amp; &lt;B&gt;"));
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

    #[test]
    fn each_call_mints_a_fresh_title_element_id() {
        let files1 = build_minimal_presentation("X");
        let files2 = build_minimal_presentation("X");
        let svg1 = String::from_utf8(
            files1
                .into_iter()
                .find(|(p, _)| p == SLIDE_FILE_NAME)
                .unwrap()
                .1,
        )
        .unwrap();
        let svg2 = String::from_utf8(
            files2
                .into_iter()
                .find(|(p, _)| p == SLIDE_FILE_NAME)
                .unwrap()
                .1,
        )
        .unwrap();
        assert_ne!(svg1, svg2);
    }
}
