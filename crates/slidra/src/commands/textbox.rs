//! `textbox *` family: `textbox add` / `textbox width` / `textbox align`.
//! CLI argv layer only — the pure mutation logic lives at
//! `crate::element::text`, mirroring the original CLI's own split between
//! its argv layer and its core mutation logic.

use crate::commands::CommandTokens;
use crate::result::CommandResult;

pub const TAKEOVER: &[CommandTokens] = &[
    &["textbox", "add"],
    &["textbox", "width"],
    &["textbox", "align"],
];

pub fn dispatch(tokens: CommandTokens, args: &[String]) -> CommandResult {
    match &tokens[1..] {
        ["add"] => add::run(args),
        ["width"] => width::run(args),
        ["align"] => align::run(args),
        _ => unreachable!("commands::textbox::TAKEOVER only lists entries dispatch handles"),
    }
}

/// `--font-family` defaults to the one font this project bundles: every
/// presentation has it, so a text box created with no `--font-family`
/// never fails to resolve. `--font-size` defaults to 24 user units — no
/// ADR names a default; this matches the original CLI's own judgement call.
const DEFAULT_FONT_FAMILY: &str = "Noto Sans TC";
const DEFAULT_FONT_SIZE: f64 = 24.0;

fn parse_align(
    raw: &str,
    command: &str,
) -> crate::errors::SlidraResult<crate::slide::format::TextAlign> {
    use crate::errors::SlidraError;
    use crate::slide::format::TextAlign;
    match raw {
        "left" => Ok(TextAlign::Left),
        "center" => Ok(TextAlign::Center),
        "right" => Ok(TextAlign::Right),
        _ => Err(SlidraError::invalid(format!(
            "command {command}\'s align must be left, center or right: {raw}"
        ))),
    }
}

mod add {
    use super::*;
    use crate::commands::argv::{
        optional_flag, optional_number_flag, require_id_positional, require_number_flag,
        require_positional,
    };
    use crate::element::text::{self, AddTextBoxInput};
    use crate::errors::SlidraResult;
    use crate::fonts;
    use crate::id::generate_element_id;
    use crate::workspace::write;

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        let id = require_id_positional(args, 0, "textbox add", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "textbox add", "slide-path")?.to_string();
        let x = require_number_flag(args, "--x", "textbox add")?;
        let y = require_number_flag(args, "--y", "textbox add")?;
        let width = require_number_flag(args, "--width", "textbox add")?;
        let text_value =
            crate::commands::argv::require_flag(args, "--text", "textbox add")?.to_string();
        let font_size =
            optional_number_flag(args, "--font-size", "textbox add")?.unwrap_or(DEFAULT_FONT_SIZE);
        let font_family = optional_flag(args, "--font-family")?
            .unwrap_or(DEFAULT_FONT_FAMILY)
            .to_string();
        let font_weight = optional_number_flag(args, "--font-weight", "textbox add")?;
        let fill = optional_flag(args, "--fill")?.map(str::to_string);
        let align = match optional_flag(args, "--align")? {
            None => crate::slide::format::TextAlign::Left,
            Some(raw) => parse_align(raw, "textbox add")?,
        };

        let slide = write::require_slide(&id, &slide_path)?;
        let fonts = fonts::resolve_presentation_fonts(&id)?;
        let element_id = generate_element_id();
        let input = AddTextBoxInput {
            x,
            y,
            width,
            text: &text_value,
            font_size,
            font_family: &font_family,
            font_weight,
            fill: fill.as_deref(),
            align,
        };
        let (updated, lines) = text::add_text_box(&slide.content, &element_id, &input, &fonts)?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!("created text box {element_id} in {slide_path} ({lines} lines)"),
            Some(serde_json::json!({ "elementId": element_id, "lines": lines })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

mod width {
    use super::*;
    use crate::commands::argv::{
        require_id_positional, require_positional, require_trailing_force_flag,
    };
    use crate::element::text;
    use crate::errors::{SlidraError, SlidraResult};
    use crate::fonts;
    use crate::workspace::write;

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        let id = require_id_positional(args, 0, "textbox width", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "textbox width", "slide-path")?.to_string();
        let element_id = require_positional(args, 2, "textbox width", "element-id")?.to_string();
        let width_raw = require_positional(args, 3, "textbox width", "width")?;
        let width: f64 = width_raw
            .parse()
            .ok()
            .filter(|w: &f64| w.is_finite())
            .ok_or_else(|| {
                SlidraError::invalid(format!(
                    "command textbox width\'s width is not a valid number: {width_raw}"
                ))
            })?;
        let force = require_trailing_force_flag(args, 4, "textbox width")?;

        let slide = write::require_slide(&id, &slide_path)?;
        let fonts = fonts::resolve_presentation_fonts(&id)?;
        let (updated, lines) =
            text::resize_text_box(&slide.content, &element_id, width, &fonts, force)?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!("adjusted text box width of {element_id} (rewrapped to {lines} lines)"),
            Some(serde_json::json!({ "lines": lines })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

mod align {
    use super::*;
    use crate::commands::argv::{
        require_id_positional, require_positional, require_trailing_force_flag,
    };
    use crate::element::text;
    use crate::errors::SlidraResult;
    use crate::fonts;
    use crate::workspace::write;

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        let id = require_id_positional(args, 0, "textbox align", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "textbox align", "slide-path")?.to_string();
        let element_id = require_positional(args, 2, "textbox align", "element-id")?.to_string();
        let align_raw = require_positional(args, 3, "textbox align", "align")?;
        let align = parse_align(align_raw, "textbox align")?;
        let force = require_trailing_force_flag(args, 4, "textbox align")?;

        let slide = write::require_slide(&id, &slide_path)?;
        let fonts = fonts::resolve_presentation_fonts(&id)?;
        let (updated, lines) =
            text::realign_text_box(&slide.content, &element_id, align, &fonts, force)?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!("set text box alignment of {element_id} to {align_raw}"),
            Some(serde_json::json!({ "lines": lines })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

#[cfg(test)]
mod tests {
    //! End-to-end wiring tests: argv -> core mutation -> `write_presentation_file`
    //! -> undo history — same shape as `commands::element`/`commands::text`'s
    //! own test modules.
    use super::*;
    use crate::history;
    use crate::workspace;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-cmd-textbox-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        id: String,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let guard = workspace::registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            let id = format!("pid-{label}");
            let work_dir_json =
                serde_json::to_string(&work.to_string_lossy().into_owned()).unwrap();
            let id_json = serde_json::to_string(&id).unwrap();
            std::fs::write(
                home.join("projects.json"),
                format!(r#"{{{id_json}:{{"workDir":{work_dir_json}}}}}"#),
            )
            .unwrap();
            std::fs::write(
                work.join("project.json"),
                r#"{"formatVersion":1,"name":"P","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"]}"#,
            )
            .unwrap();
            std::fs::create_dir_all(work.join("slides")).unwrap();
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            Fixture {
                home,
                work,
                id,
                _guard: guard,
            }
        }

        fn write_slide(&self, content: &str) {
            std::fs::write(self.work.join("slides/001.svg"), content).unwrap();
        }

        fn read_slide(&self) -> String {
            std::fs::read_to_string(self.work.join("slides/001.svg")).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    fn slide(children: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">{children}</svg>"#
        )
    }

    #[test]
    fn textbox_width_rejects_a_non_numeric_positional() {
        let result = width::run(&[
            "whatever-id".to_string(),
            "slides/001.svg".to_string(),
            "el-a".to_string(),
            "abc".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command textbox width\'s width is not a valid number: abc"
        );
    }

    #[test]
    fn textbox_add_width_and_align_via_the_cli_layer() {
        let fixture = Fixture::new("add-width-align");
        fixture.write_slide(&slide(""));

        let added = dispatch(
            &["textbox", "add"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "--x".to_string(),
                "10".to_string(),
                "--y".to_string(),
                "20".to_string(),
                "--width".to_string(),
                "300".to_string(),
                "--text".to_string(),
                "hello".to_string(),
            ],
        );
        assert!(added.ok, "{}", added.message);
        let element_id = added.data.as_ref().unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            fixture
                .read_slide()
                .contains(&format!(r#"id="{element_id}""#))
        );
        // Default font-family/font-size were resolved without needing the
        // caller to pass them.
        assert!(
            fixture
                .read_slide()
                .contains(r#"font-family="Noto Sans TC""#)
        );
        assert!(fixture.read_slide().contains(r#"font-size="24""#));

        let widened = dispatch(
            &["textbox", "width"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                element_id.clone(),
                "150".to_string(),
            ],
        );
        assert!(widened.ok, "{}", widened.message);
        assert!(
            fixture
                .read_slide()
                .contains(r#"data-slidra-text-width="150""#)
        );

        let aligned = dispatch(
            &["textbox", "align"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                element_id.clone(),
                "center".to_string(),
            ],
        );
        assert!(aligned.ok, "{}", aligned.message);
        assert!(
            fixture
                .read_slide()
                .contains(r#"data-slidra-text-align="center""#)
        );

        // Each of the three writes above occupies exactly one undo step.
        for _ in 0..3 {
            history::undo(&fixture.id).unwrap();
        }
        assert_eq!(fixture.read_slide(), slide(""));
    }

    #[test]
    fn textbox_align_rejects_a_value_outside_the_fixed_set() {
        let fixture = Fixture::new("align-bad-value");
        fixture.write_slide(&slide(
            r#"<g id="tb" data-slidra-text-width="300"><text font-family="Noto Sans TC" font-size="24" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#,
        ));

        let result = dispatch(
            &["textbox", "align"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "tb".to_string(),
                "top".to_string(),
            ],
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command textbox align\'s align must be left, center or right: top"
        );
    }

    #[test]
    fn textbox_add_missing_font_family_errors() {
        let fixture = Fixture::new("add-missing-font");
        fixture.write_slide(&slide(""));

        let result = dispatch(
            &["textbox", "add"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "--x".to_string(),
                "0".to_string(),
                "--y".to_string(),
                "0".to_string(),
                "--width".to_string(),
                "100".to_string(),
                "--text".to_string(),
                "hi".to_string(),
                "--font-family".to_string(),
                "Comic Sans MS".to_string(),
            ],
        );
        assert!(!result.ok);
        assert!(result.message.contains("presentation does not embed font"));
    }
}
