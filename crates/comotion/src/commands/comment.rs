//! `comment *` family: `comment add` / `comment edit` / `comment delete` /
//! `comment list` (plan section 1.1, phase P8). CLI argv layer only — the
//! pure `<comot:comments>` read/write logic lives at `crate::slide::
//! comments`, mirroring `packages/cli/src/commands/comment.ts`'s split from
//! `packages/core/src/slide/comments.ts` + `slide-ops.ts`.
//!
//! `comment *`'s own "slides only, no templates" listedness check
//! (`require_listed_slide` below) is narrower than every `element`/`text`/
//! `textbox` command's `workspace::write::require_slide` (which accepts
//! templates too) — a distinct, local rule, not a parameterization of that
//! one, mirroring `slide-ops.ts`'s own local `requireSlidePath` being a
//! separate function from `workspace.ts`'s `assertSlidePathListed` (see
//! that module's own doc comment, which names this exact split).

use crate::commands::CommandTokens;
use crate::commands::argv::{
    optional_flag, require_id_positional, require_positional, require_raw_positional,
};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::id::generate_opaque_id;
use crate::result::CommandResult;
use crate::slide::comments::{self, SlideComment};
use crate::slide::format::{SlideElement, assert_slide_compliant, parse_slide};
use crate::workspace::{self, project, virtual_fs};
use std::path::PathBuf;

pub const TAKEOVER: &[CommandTokens] = &[
    &["comment", "add"],
    &["comment", "edit"],
    &["comment", "delete"],
    &["comment", "list"],
];

pub fn dispatch(tokens: CommandTokens, args: &[String]) -> CommandResult {
    match &tokens[1..] {
        ["add"] => add::run(args),
        ["edit"] => edit::run(args),
        ["delete"] => delete::run(args),
        ["list"] => list::run(args),
        _ => unreachable!("commands::comment::TAKEOVER only lists entries dispatch handles"),
    }
}

/// Confirms `slide_path` is one of the presentation's declared SLIDES —
/// templates never qualify (comments only ever make sense on a real,
/// insertable slide) — without reading the file itself. Returns the
/// resolved work dir so the caller can decide exactly when to read.
fn require_listed_slide(id: &str, slide_path: &str) -> CoMotionResult<PathBuf> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let proj = project::read_project_json(&work_dir)?;
    if !proj.slides.iter().any(|s| s == slide_path) {
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    }
    Ok(work_dir)
}

fn find_element_by_id<'a>(elements: &'a [SlideElement], id: &str) -> Option<&'a SlideElement> {
    for element in elements {
        if element.id == id {
            return Some(element);
        }
        if let Some(found) = find_element_by_id(&element.children, id) {
            return Some(found);
        }
    }
    None
}

/// Ports `Date.prototype.toISOString()`'s format — `YYYY-MM-DDTHH:mm:ss.sssZ`
/// — via Howard Hinnant's `civil_from_days` integer-arithmetic Gregorian
/// conversion (no `chrono`, plan decision D4).
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719468;
    let era = z.div_euclid(146097);
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn format_iso8601(epoch_millis: u128) -> String {
    let total_secs = epoch_millis / 1000;
    let millis = (epoch_millis % 1000) as u32;
    let days = (total_secs / 86400) as i64;
    let secs_of_day = (total_secs % 86400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn now_iso8601() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format_iso8601(millis)
}

fn comment_json(c: &SlideComment, slide_path: &str) -> serde_json::Value {
    serde_json::json!({
        "id": c.id,
        "target": c.target,
        "author": c.author,
        "created": c.created,
        "text": c.text,
        "slidePath": slide_path,
    })
}

mod add {
    use super::*;
    use crate::workspace::write;

    fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
        let id = require_id_positional(args, 0, "comment add", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "comment add", "slide-path")?.to_string();
        let target = require_positional(args, 2, "comment add", "target")?.to_string();
        // `text` may legitimately be an empty string at the argv layer
        // (rejected downstream, once trimmed) — checked for absence only.
        let text = require_raw_positional(args, 3, "comment add", "text")?.to_string();
        let author = optional_flag(args, "--author")?
            .unwrap_or("agent")
            .to_string();

        let work_dir = require_listed_slide(&id, &slide_path)?;
        if author.trim().is_empty() {
            return Err(CoMotionError::invalid("author 不可為空"));
        }
        if text.trim().is_empty() {
            return Err(CoMotionError::invalid("留言內容不可為空"));
        }
        let content = virtual_fs::read_virtual_file(&work_dir, &slide_path)?;
        assert_slide_compliant(&content, &slide_path)?;
        if target != "page" {
            let model = parse_slide(&content, Some(&slide_path))?;
            if find_element_by_id(&model.elements, &target).is_none() {
                return Err(CoMotionError::invalid(format!(
                    "投影片 {slide_path} 裡沒有元素 {target}"
                )));
            }
        }

        let comment_id = format!("c-{}", generate_opaque_id());
        let comment = SlideComment {
            id: comment_id.clone(),
            target,
            author,
            created: now_iso8601(),
            text,
        };
        let updated = comments::add_slide_comment(&content, &comment)?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!("已在 {slide_path} 新增留言 {comment_id}"),
            Some(serde_json::json!({ "commentId": comment_id })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

mod edit {
    use super::*;
    use crate::workspace::write;

    fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
        let id = require_id_positional(args, 0, "comment edit", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "comment edit", "slide-path")?.to_string();
        let comment_id = require_positional(args, 2, "comment edit", "comment-id")?.to_string();
        let text = require_raw_positional(args, 3, "comment edit", "text")?.to_string();

        let work_dir = require_listed_slide(&id, &slide_path)?;
        if text.trim().is_empty() {
            return Err(CoMotionError::invalid("留言內容不可為空"));
        }
        let content = virtual_fs::read_virtual_file(&work_dir, &slide_path)?;
        let updated = comments::edit_slide_comment(&content, &comment_id, &text)?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!("已更新留言 {comment_id}"),
            Some(serde_json::json!({})),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

mod delete {
    use super::*;
    use crate::workspace::write;

    fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
        let id = require_id_positional(args, 0, "comment delete", "presentation-id")?.to_string();
        let slide_path = require_positional(args, 1, "comment delete", "slide-path")?.to_string();
        let comment_id = require_positional(args, 2, "comment delete", "comment-id")?.to_string();

        let work_dir = require_listed_slide(&id, &slide_path)?;
        let content = virtual_fs::read_virtual_file(&work_dir, &slide_path)?;
        let updated = comments::delete_slide_comment(&content, &comment_id)?;
        write::write_presentation_file(&id, &slide_path, &updated)?;

        Ok(CommandResult::success(
            format!("已刪除留言 {comment_id}"),
            Some(serde_json::json!({})),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

mod list {
    use super::*;

    fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
        let id = require_id_positional(args, 0, "comment list", "presentation-id")?.to_string();
        // `slide-path` is optional here — omitted means "every slide,
        // deck-wide" — so it is read raw (`args.get`), never through
        // `require_positional`/`require_raw_positional` (both of which
        // treat a wholly absent value as a hard error).
        let slide_path = args.get(1).cloned();

        let mut all_comments = Vec::new();
        match &slide_path {
            Some(slide_path) => {
                let work_dir = require_listed_slide(&id, slide_path)?;
                let content = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
                for c in comments::read_slide_comments(&content)? {
                    all_comments.push(comment_json(&c, slide_path));
                }
            }
            None => {
                let work_dir = workspace::resolve_work_dir(&id)?;
                let proj = project::read_project_json(&work_dir)?;
                for slide in &proj.slides {
                    let content = virtual_fs::read_virtual_file(&work_dir, slide)?;
                    for c in comments::read_slide_comments(&content)? {
                        all_comments.push(comment_json(&c, slide));
                    }
                }
            }
        }

        Ok(CommandResult::success(
            format!("共 {} 則留言", all_comments.len()),
            Some(serde_json::json!({ "comments": all_comments })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod end_to_end {
        //! CLI-layer wiring tests: argv -> core mutation ->
        //! `write_presentation_file` -> undo history — same shape as
        //! `commands::element`/`commands::text`'s own test modules.
        use super::*;
        use crate::history;
        use std::path::PathBuf;

        fn temp_dir(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "comotion-test-cmd-comment-{label}-{}",
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
                    r#"{"formatVersion":1,"name":"P","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"templates":["templates/001.svg"]}"#,
                )
                .unwrap();
                std::fs::create_dir_all(work.join("slides")).unwrap();
                std::fs::create_dir_all(work.join("templates")).unwrap();
                unsafe {
                    std::env::set_var("COMOTION_HOME", &home);
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

            fn write_template(&self, content: &str) {
                std::fs::write(self.work.join("templates/001.svg"), content).unwrap();
            }

            fn read_slide(&self) -> String {
                std::fs::read_to_string(self.work.join("slides/001.svg")).unwrap()
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

        fn slide(children: &str) -> String {
            format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">{children}</svg>"#
            )
        }

        #[test]
        fn add_edit_delete_round_trip_via_the_cli_layer() {
            let fixture = Fixture::new("add-edit-delete");
            fixture.write_slide(&slide(
                r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
            ));

            let added = dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "el-a".to_string(),
                    "first draft".to_string(),
                ],
            );
            assert!(added.ok, "{}", added.message);
            let comment_id = added.data.as_ref().unwrap()["commentId"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(fixture.read_slide().contains("first draft"));

            let edited = dispatch(
                &["comment", "edit"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    comment_id.clone(),
                    "revised".to_string(),
                ],
            );
            assert!(edited.ok, "{}", edited.message);
            assert!(fixture.read_slide().contains("revised"));
            assert!(!fixture.read_slide().contains("first draft"));

            let deleted = dispatch(
                &["comment", "delete"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    comment_id.clone(),
                ],
            );
            assert!(deleted.ok, "{}", deleted.message);
            assert!(!fixture.read_slide().contains("revised"));
            assert!(
                fixture.read_slide().contains("<comot:comments"),
                "the empty list container must survive"
            );

            // Each of the three writes above occupies exactly one undo step.
            for _ in 0..3 {
                history::undo(&fixture.id).unwrap();
            }
            assert_eq!(
                fixture.read_slide(),
                slide(r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#)
            );
        }

        #[test]
        fn add_target_page_needs_no_element_lookup() {
            let fixture = Fixture::new("add-page");
            fixture.write_slide(&slide(""));

            let result = dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "page".to_string(),
                    "overall feedback".to_string(),
                ],
            );
            assert!(result.ok, "{}", result.message);
            assert!(fixture.read_slide().contains(r#"target="page""#));
        }

        #[test]
        fn add_rejects_a_dangling_target_and_empty_author_or_text() {
            let fixture = Fixture::new("add-validation");
            fixture.write_slide(&slide(
                r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
            ));

            let missing_target = dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "el-nope".to_string(),
                    "hi".to_string(),
                ],
            );
            assert!(!missing_target.ok);
            assert_eq!(
                missing_target.message,
                "投影片 slides/001.svg 裡沒有元素 el-nope"
            );

            let empty_text = dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "el-a".to_string(),
                    "   ".to_string(),
                ],
            );
            assert!(!empty_text.ok);
            assert_eq!(empty_text.message, "留言內容不可為空");

            let empty_author = dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "el-a".to_string(),
                    "hi".to_string(),
                    "--author".to_string(),
                    "  ".to_string(),
                ],
            );
            assert!(!empty_author.ok);
            assert_eq!(empty_author.message, "author 不可為空");
        }

        #[test]
        fn comment_commands_reject_a_template_path_slides_only() {
            let fixture = Fixture::new("template-rejected");
            fixture.write_template(&slide(
                r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
            ));

            let result = dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "templates/001.svg".to_string(),
                    "page".to_string(),
                    "hi".to_string(),
                ],
            );
            assert!(!result.ok);
            assert_eq!(result.message, "不是投影片：templates/001.svg");
        }

        #[test]
        fn edit_or_delete_an_unknown_comment_id_is_not_found() {
            let fixture = Fixture::new("not-found");
            fixture.write_slide(&slide(""));

            let edited = dispatch(
                &["comment", "edit"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "c-nope".to_string(),
                    "x".to_string(),
                ],
            );
            assert!(!edited.ok);
            assert_eq!(
                edited.failure_kind,
                Some(crate::result::FailureKind::NotFound)
            );

            let deleted = dispatch(
                &["comment", "delete"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "c-nope".to_string(),
                ],
            );
            assert!(!deleted.ok);
            assert_eq!(
                deleted.failure_kind,
                Some(crate::result::FailureKind::NotFound)
            );
        }

        #[test]
        fn list_with_no_slide_path_covers_every_slide_in_project_order() {
            let fixture = Fixture::new("list-all");
            // Second slide via a second project entry: reuse the same
            // fixture's project.json by rewriting it with two slides.
            std::fs::write(
                fixture.work.join("project.json"),
                r#"{"formatVersion":1,"name":"P","canvas":{"width":1280,"height":720},"slides":["slides/001.svg","slides/002.svg"]}"#,
            )
            .unwrap();
            fixture.write_slide(&slide(""));
            std::fs::write(fixture.work.join("slides/002.svg"), slide("")).unwrap();

            dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "page".to_string(),
                    "on slide one".to_string(),
                ],
            );
            dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/002.svg".to_string(),
                    "page".to_string(),
                    "on slide two".to_string(),
                ],
            );

            let listed = dispatch(&["comment", "list"], &[fixture.id.clone()]);
            assert!(listed.ok, "{}", listed.message);
            let comments = listed.data.as_ref().unwrap()["comments"]
                .as_array()
                .unwrap();
            assert_eq!(comments.len(), 2);
            assert_eq!(comments[0]["slidePath"], "slides/001.svg");
            assert_eq!(comments[1]["slidePath"], "slides/002.svg");
        }

        #[test]
        fn list_with_a_slide_path_covers_only_that_slide() {
            let fixture = Fixture::new("list-one");
            std::fs::write(
                fixture.work.join("project.json"),
                r#"{"formatVersion":1,"name":"P","canvas":{"width":1280,"height":720},"slides":["slides/001.svg","slides/002.svg"]}"#,
            )
            .unwrap();
            fixture.write_slide(&slide(""));
            std::fs::write(fixture.work.join("slides/002.svg"), slide("")).unwrap();

            dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "page".to_string(),
                    "on slide one".to_string(),
                ],
            );
            dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/002.svg".to_string(),
                    "page".to_string(),
                    "on slide two".to_string(),
                ],
            );

            let listed = dispatch(
                &["comment", "list"],
                &[fixture.id.clone(), "slides/002.svg".to_string()],
            );
            assert!(listed.ok, "{}", listed.message);
            let comments = listed.data.as_ref().unwrap()["comments"]
                .as_array()
                .unwrap();
            assert_eq!(comments.len(), 1);
            assert_eq!(comments[0]["text"], "on slide two");
        }

        #[test]
        fn list_never_occupies_an_undo_step() {
            let fixture = Fixture::new("list-no-undo");
            fixture.write_slide(&slide(""));
            let added = dispatch(
                &["comment", "add"],
                &[
                    fixture.id.clone(),
                    "slides/001.svg".to_string(),
                    "page".to_string(),
                    "hi".to_string(),
                ],
            );
            assert!(added.ok, "{}", added.message);

            let listed = dispatch(&["comment", "list"], &[fixture.id.clone()]);
            assert!(listed.ok, "{}", listed.message);

            // `add` occupies the only undo step; `list` must not have
            // pushed a second one on top of it.
            history::undo(&fixture.id).unwrap();
            let undo_err = history::undo(&fixture.id).unwrap_err();
            assert_eq!(undo_err.message(), "沒有可復原的操作");
        }
    }

    #[test]
    fn format_iso8601_matches_a_known_epoch_instant() {
        // 2024-01-01T00:00:00.000Z = 1704067200000 ms since epoch (verified
        // against a real JS `new Date(1704067200000).toISOString()`).
        assert_eq!(
            format_iso8601(1_704_067_200_000),
            "2024-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn format_iso8601_carries_milliseconds_and_a_leap_day() {
        // 2024-02-29T12:34:56.789Z = 1709210096789 ms since epoch.
        assert_eq!(
            format_iso8601(1_709_210_096_789),
            "2024-02-29T12:34:56.789Z"
        );
    }

    #[test]
    fn format_iso8601_at_the_unix_epoch_itself() {
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00.000Z");
    }
}
