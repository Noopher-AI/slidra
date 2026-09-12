//! `text *` family: `text set` / `text style set` / `text list set` (plan
//! section 1.1, phase P6). CLI argv layer only — the pure mutation logic
//! lives at `crate::element::text`, mirroring `packages/cli/src/commands/
//! text-set.ts` / `text-style.ts` / `text-list.ts`'s split from
//! `packages/core/src/element-text.ts`.

use crate::commands::CommandTokens;
use crate::commands::argv::{
    has_flag, optional_flag, require_flag, require_id_positional, require_positional,
    require_raw_positional, require_trailing_force_flag,
};
use crate::element::text::{self, TextStyleUpdate};
use crate::errors::{SlidraError, SlidraResult};
use crate::fonts;
use crate::result::CommandResult;
use crate::text::list::ListKind;
use crate::workspace::write;

/// Every registered command in this family (P6) — see `commands::element::TAKEOVER`'s
/// doc for why this list only grows in lockstep with a working `dispatch`
/// arm.
pub const TAKEOVER: &[CommandTokens] = &[
    &["text", "set"],
    &["text", "style", "set"],
    &["text", "list", "set"],
];

pub fn dispatch(tokens: CommandTokens, args: &[String]) -> CommandResult {
    match &tokens[1..] {
        ["set"] => set::run(args),
        ["style", "set"] => style_set::run(args),
        ["list", "set"] => list_set::run(args),
        _ => unreachable!("commands::text::TAKEOVER only lists entries dispatch handles"),
    }
}

mod set {
    use super::*;

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        let id = require_id_positional(args, 0, "text set", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "text set", "slide-path")?.to_string();
        let element_id = require_positional(args, 2, "text set", "element-id")?.to_string();
        // `new-text` may legitimately be an empty string (clears the
        // element's text) or start with `--` — taken verbatim, not via
        // `require_positional`.
        let new_text = require_raw_positional(args, 3, "text set", "new-text")?.to_string();
        let force = require_trailing_force_flag(args, 4, "text set")?;

        let slide = write::require_slide(&id, &slide_path)?;
        let fonts = fonts::resolve_presentation_fonts(&id)?;
        let updated =
            text::replace_element_text(&slide.content, &element_id, &new_text, &fonts, force)?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!("updated element {element_id} in {slide_path}"),
            Some(serde_json::json!({})),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

mod style_set {
    use super::*;

    /// `--range <start>:<end>`: exactly `\d+:\d+`, no `regex` crate (plan
    /// decision D4) — hand-scanned digit runs either side of one colon.
    fn parse_range(raw: &str) -> SlidraResult<(usize, usize)> {
        let (left, right) = raw.split_once(':').ok_or_else(|| {
            SlidraError::invalid(format!(
                "--range format error, must be number:number: {raw}"
            ))
        })?;
        let is_digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
        if !is_digits(left) || !is_digits(right) {
            return Err(SlidraError::invalid(format!(
                "--range format error, must be number:number: {raw}"
            )));
        }
        let start: usize = left.parse().map_err(|_| {
            SlidraError::invalid(format!(
                "--range format error, must be number:number: {raw}"
            ))
        })?;
        let end: usize = right.parse().map_err(|_| {
            SlidraError::invalid(format!(
                "--range format error, must be number:number: {raw}"
            ))
        })?;
        if start >= end {
            return Err(SlidraError::invalid("--range start must be less than end"));
        }
        Ok((start, end))
    }

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        let id = require_id_positional(args, 0, "text style set", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "text style set", "slide-path")?.to_string();
        let element_id = require_positional(args, 2, "text style set", "element-id")?.to_string();
        let range_raw = require_flag(args, "--range", "text style set")?;
        let (range_start, range_end) = parse_range(range_raw)?;
        let font_weight = optional_flag(args, "--font-weight")?.map(str::to_string);
        let font_style = optional_flag(args, "--font-style")?.map(str::to_string);
        if font_weight.is_none() && font_style.is_none() {
            return Err(SlidraError::invalid(
                "command text style set requires at least --font-weight or --font-style",
            ));
        }
        let force = has_flag(args, "--force");

        let slide = write::require_slide(&id, &slide_path)?;
        let fonts = fonts::resolve_presentation_fonts(&id)?;
        let update = TextStyleUpdate {
            font_weight,
            font_style,
        };
        let (updated, runs) = text::set_text_run_style(
            &slide.content,
            &element_id,
            range_start,
            range_end,
            &update,
            &fonts,
            force,
        )?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!(
                "set style for characters {range_start}–{range_end} of {element_id} ({runs} runs)"
            ),
            Some(serde_json::json!({ "runs": runs })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

mod list_set {
    use super::*;

    fn parse_kind(raw: &str) -> SlidraResult<ListKind> {
        match raw {
            "bullet" => Ok(ListKind::Bullet),
            "number" => Ok(ListKind::Number),
            "none" => Ok(ListKind::None),
            _ => Err(SlidraError::invalid(format!(
                "--kind must be bullet, number, or none: {raw}"
            ))),
        }
    }

    fn parse_paragraph(raw: &str) -> SlidraResult<usize> {
        if !raw.chars().all(|c| c.is_ascii_digit()) || raw.is_empty() {
            return Err(SlidraError::invalid(format!(
                "--paragraph is not a valid non-negative integer: {raw}"
            )));
        }
        raw.parse().map_err(|_| {
            SlidraError::invalid(format!(
                "--paragraph is not a valid non-negative integer: {raw}"
            ))
        })
    }

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        let id = require_id_positional(args, 0, "text list set", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "text list set", "slide-path")?.to_string();
        let element_id = require_positional(args, 2, "text list set", "element-id")?.to_string();
        let paragraph = parse_paragraph(require_flag(args, "--paragraph", "text list set")?)?;
        let kind = parse_kind(require_flag(args, "--kind", "text list set")?)?;
        let force = has_flag(args, "--force");

        let slide = write::require_slide(&id, &slide_path)?;
        let fonts = fonts::resolve_presentation_fonts(&id)?;
        let (updated, paragraphs) =
            text::set_paragraph_list(&slide.content, &element_id, paragraph, kind, &fonts, force)?;
        // A `none`-to-`none` call is a legal no-op (plan section 4 table D):
        // no write, no undo step.
        if updated != slide.content {
            write::write_presentation_file(&id, &slide_path, &updated)?;
        }

        let kind_str = match kind {
            ListKind::Bullet => "bullet",
            ListKind::Number => "number",
            ListKind::None => "none",
        };
        Ok(CommandResult::success(
            format!("set paragraph {paragraph} of {element_id} to {kind_str}"),
            Some(serde_json::json!({ "paragraphs": paragraphs })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

#[cfg(test)]
mod tests {
    //! End-to-end wiring tests: argv -> core mutation -> `write_presentation_file`
    //! -> undo history — same shape as `commands::element`'s own test module.
    use super::*;
    use crate::history;
    use crate::workspace;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-cmd-text-{label}-{}",
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
    fn text_set_writes_the_slide_and_occupies_one_undo_step() {
        let fixture = Fixture::new("text-set");
        fixture.write_slide(&slide(r#"<text id="a">old</text>"#));

        let result = dispatch(
            &["text", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "new".to_string(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        assert!(fixture.read_slide().contains(">new<"));

        let undo = history::undo(&fixture.id).unwrap();
        assert_eq!(undo.restored_paths, vec!["slides/001.svg".to_string()]);
        assert!(fixture.read_slide().contains(">old<"));
    }

    #[test]
    fn text_set_trailing_force_flag_at_the_wrong_position_is_an_unknown_argument() {
        let fixture = Fixture::new("text-set-bad-force");
        fixture.write_slide(&slide(r#"<text id="a">old</text>"#));

        let result = dispatch(
            &["text", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "new".to_string(),
                "--json".to_string(),
            ],
        );
        assert!(!result.ok);
        assert_eq!(result.message, "command text set unknown argument: --json");
    }

    #[test]
    fn text_style_set_and_text_list_set_via_the_cli_layer() {
        let fixture = Fixture::new("text-style-list");
        fixture.write_slide(&slide(
            r#"<g id="tb" data-slidra-text-width="500"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hello world</tspan></text></g>"#,
        ));

        let styled = dispatch(
            &["text", "style", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "tb".to_string(),
                "--range".to_string(),
                "0:5".to_string(),
                "--font-weight".to_string(),
                "bold".to_string(),
            ],
        );
        assert!(styled.ok, "{}", styled.message);
        assert!(fixture.read_slide().contains(r#"font-weight="bold""#));

        let listed = dispatch(
            &["text", "list", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "tb".to_string(),
                "--paragraph".to_string(),
                "0".to_string(),
                "--kind".to_string(),
                "bullet".to_string(),
            ],
        );
        assert!(listed.ok, "{}", listed.message);
        assert!(fixture.read_slide().contains("data-slidra-list-marker"));
    }

    #[test]
    fn text_list_set_none_to_none_occupies_no_undo_step() {
        let fixture = Fixture::new("text-list-noop");
        let original = slide(
            r#"<g id="tb" data-slidra-text-width="500"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#,
        );
        fixture.write_slide(&original);

        let result = dispatch(
            &["text", "list", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "tb".to_string(),
                "--paragraph".to_string(),
                "0".to_string(),
                "--kind".to_string(),
                "none".to_string(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        assert_eq!(fixture.read_slide(), original);
        // No undo group was ever pushed for this no-op write.
        let undo_err = history::undo(&fixture.id).unwrap_err();
        assert_eq!(undo_err.message(), "no operation to undo");
    }

    #[test]
    fn text_style_set_rejects_a_malformed_range() {
        let fixture = Fixture::new("text-style-bad-range");
        fixture.write_slide(&slide(
            r#"<g id="tb" data-slidra-text-width="500"><text font-family="Noto Sans TC" font-size="16" xml:space="preserve"><tspan x="0" y="0">hi</tspan></text></g>"#,
        ));

        let result = dispatch(
            &["text", "style", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "tb".to_string(),
                "--range".to_string(),
                "abc".to_string(),
                "--font-weight".to_string(),
                "bold".to_string(),
            ],
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "--range format error, must be number:number: abc"
        );
    }
}
