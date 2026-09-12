// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `element *` family: CLI argv layer for the `element` subcommands (plan
//! section 1.1). Each subcommand's argv parsing + `CommandResult` assembly
//! lives in its own sibling module — this file only owns the family's
//! takeover-table slice and the dispatch that routes a resolved command to
//! its handler.
//!
//! The pure SVG-mutation logic every handler calls into lives at
//! `crate::element` (`crates/slidra/src/element/`), NOT here — this
//! module is CLI plumbing only, mirroring `packages/cli/src/commands/
//! element/index.ts`'s split from `packages/core/src/element-*.ts`.
//!
//! Registered so far (phases P3-P7 of the ticket's commit sequence): the ten
//! structural commands, `scale`/`resize`/`style set`, `align`/`distribute`,
//! and `copy`/`cut`/`paste`/`duplicate`. See this module's `TAKEOVER` doc
//! for why an entry is never added ahead of a working handler.

pub mod align;
pub mod copy;
pub mod cut;
pub mod delete;
pub mod distribute;
pub mod duplicate;
pub mod group;
pub mod insert;
pub mod lock;
/// Named `move_cmd`, not `move` — `move` is a Rust keyword.
pub mod move_cmd;
pub mod name_set;
pub mod order;
pub mod paste;
pub mod resize;
pub mod rotate;
pub mod scale;
pub mod style_set;
pub mod ungroup;
pub mod unlock;

use crate::commands::CommandTokens;
use crate::result::CommandResult;

/// This family's slice of the crate-wide takeover table. Grows in lockstep
/// with a working `dispatch` arm below, one phase at a time (plan section
/// 6.5) — never ahead of it, so no commit in this ticket's history ever
/// lists a command with no handler behind it.
pub const TAKEOVER: &[CommandTokens] = &[
    &["element", "insert"],
    &["element", "delete"],
    &["element", "move"],
    &["element", "rotate"],
    &["element", "order"],
    &["element", "lock"],
    &["element", "unlock"],
    &["element", "name", "set"],
    &["element", "group"],
    &["element", "ungroup"],
    &["element", "scale"],
    &["element", "resize"],
    &["element", "style", "set"],
    &["element", "align"],
    &["element", "distribute"],
    &["element", "copy"],
    &["element", "cut"],
    &["element", "paste"],
    &["element", "duplicate"],
];

pub fn dispatch(tokens: CommandTokens, args: &[String]) -> CommandResult {
    match &tokens[1..] {
        ["insert"] => insert::run(args),
        ["delete"] => delete::run(args),
        ["move"] => move_cmd::run(args),
        ["rotate"] => rotate::run(args),
        ["order"] => order::run(args),
        ["lock"] => lock::run(args),
        ["unlock"] => unlock::run(args),
        ["name", "set"] => name_set::run(args),
        ["group"] => group::run(args),
        ["ungroup"] => ungroup::run(args),
        ["scale"] => scale::run(args),
        ["resize"] => resize::run(args),
        ["style", "set"] => style_set::run(args),
        ["align"] => align::run(args),
        ["distribute"] => distribute::run(args),
        ["copy"] => copy::run(args),
        ["cut"] => cut::run(args),
        ["paste"] => paste::run(args),
        ["duplicate"] => duplicate::run(args),
        _ => unreachable!("commands::element::TAKEOVER only lists entries dispatch handles"),
    }
}

#[cfg(test)]
mod tests {
    //! End-to-end wiring tests: argv -> core mutation -> `write_presentation_file`
    //! -> undo history, for each of this phase's ten handlers. Lighter than
    //! phase P9's `tests/cli_golden.rs` (which spawns the real compiled
    //! binary and compares against Node) — these run the handler functions
    //! directly in-process against a temp `SLIDRA_HOME`/work dir, proving
    //! the glue between `commands::element::*` and `workspace::write`/
    //! `history` is correct, ahead of that later, heavier layer.
    use super::*;
    use crate::history;
    use crate::workspace;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-cmd-element-{label}-{}",
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
            let guard = workspace::registry::ENV_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
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
    fn insert_writes_the_slide_and_occupies_one_undo_step() {
        let fixture = Fixture::new("insert");
        fixture.write_slide(&slide(""));

        let result = dispatch(
            &["element", "insert"],
            &[
                "rect".to_string(),
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "--x".to_string(),
                "0".to_string(),
                "--y".to_string(),
                "0".to_string(),
                "--width".to_string(),
                "10".to_string(),
                "--height".to_string(),
                "10".to_string(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        assert!(fixture.read_slide().contains("<rect"));

        let undo = history::undo(&fixture.id).unwrap();
        assert_eq!(undo.restored_paths, vec!["slides/001.svg".to_string()]);
        assert_eq!(fixture.read_slide(), slide(""));
    }

    #[test]
    fn move_reports_a_failure_result_for_a_locked_target_without_force() {
        let fixture = Fixture::new("move-locked");
        fixture.write_slide(&slide(
            r#"<g id="a" data-slidra-lock="true"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let result = dispatch(
            &["element", "move"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "--dx".to_string(),
                "1".to_string(),
                "--dy".to_string(),
                "1".to_string(),
            ],
        );
        assert!(!result.ok);
        assert!(result.message.contains("locked layout skeleton"));
        // The rejected command must not have touched the slide file at all.
        assert!(fixture.read_slide().contains(r#"data-slidra-lock="true""#));
        assert!(!fixture.read_slide().contains("translate"));
    }

    #[test]
    fn delete_removes_the_element_from_disk() {
        let fixture = Fixture::new("delete");
        fixture.write_slide(&slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let result = dispatch(
            &["element", "delete"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        assert_eq!(fixture.read_slide(), slide(""));
    }

    #[test]
    fn group_then_ungroup_round_trips_via_the_cli_layer() {
        let fixture = Fixture::new("group-ungroup");
        fixture.write_slide(&slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let grouped = dispatch(
            &["element", "group"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a,b".to_string(),
            ],
        );
        assert!(grouped.ok, "{}", grouped.message);
        let group_id = grouped.data.as_ref().unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            fixture
                .read_slide()
                .contains(&format!(r#"id="{group_id}""#))
        );

        let ungrouped = dispatch(
            &["element", "ungroup"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                group_id.clone(),
            ],
        );
        assert!(ungrouped.ok, "{}", ungrouped.message);
        assert!(!fixture.read_slide().contains(&group_id));
        assert!(fixture.read_slide().contains(r#"id="a""#));
        assert!(fixture.read_slide().contains(r#"id="b""#));
    }

    #[test]
    fn lock_then_name_set_then_unlock_via_the_cli_layer() {
        let fixture = Fixture::new("lock-name-unlock");
        fixture.write_slide(&slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let locked = dispatch(
            &["element", "lock"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
            ],
        );
        assert!(locked.ok, "{}", locked.message);
        assert!(fixture.read_slide().contains(r#"data-slidra-lock="true""#));

        let named = dispatch(
            &["element", "name", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "title".to_string(),
            ],
        );
        assert!(named.ok, "{}", named.message);
        assert!(fixture.read_slide().contains(r#"data-slidra-name="title""#));

        let unlocked = dispatch(
            &["element", "unlock"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
            ],
        );
        assert!(unlocked.ok, "{}", unlocked.message);
        assert!(!fixture.read_slide().contains("data-slidra-lock"));
    }

    #[test]
    fn rotate_and_order_via_the_cli_layer() {
        let fixture = Fixture::new("rotate-order");
        fixture.write_slide(&slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let rotated = dispatch(
            &["element", "rotate"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "--degrees".to_string(),
                "45".to_string(),
            ],
        );
        assert!(rotated.ok, "{}", rotated.message);
        assert!(fixture.read_slide().contains(r#"transform="rotate(45)""#));

        let ordered = dispatch(
            &["element", "order"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "back".to_string(),
            ],
        );
        assert!(ordered.ok, "{}", ordered.message);
    }

    #[test]
    fn scale_resize_and_style_set_via_the_cli_layer() {
        let fixture = Fixture::new("scale-resize-style");
        fixture.write_slide(&slide(
            r#"<g id="a" transform="translate(10 10)"><rect x="0" y="0" width="10" height="10"/></g>"#,
        ));

        let scaled = dispatch(
            &["element", "scale"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "--factor".to_string(),
                "2".to_string(),
            ],
        );
        assert!(scaled.ok, "{}", scaled.message);
        assert!(fixture.read_slide().contains(r#"width="20" height="20""#));

        let resized = dispatch(
            &["element", "resize"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "--width".to_string(),
                "5".to_string(),
                "--height".to_string(),
                "5".to_string(),
            ],
        );
        assert!(resized.ok, "{}", resized.message);
        assert!(fixture.read_slide().contains(r#"width="5" height="5""#));

        let styled = dispatch(
            &["element", "style", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "fill".to_string(),
                "#00ff00".to_string(),
            ],
        );
        assert!(styled.ok, "{}", styled.message);
        assert!(fixture.read_slide().contains(r##"fill="#00ff00""##));

        // Each of the three writes above occupies exactly one undo step.
        for _ in 0..3 {
            history::undo(&fixture.id).unwrap();
        }
        assert!(fixture.read_slide().contains(r#"width="10" height="10""#));
        assert!(!fixture.read_slide().contains("fill"));
    }

    #[test]
    fn style_set_rejects_an_attribute_outside_the_whitelist_via_the_cli_layer() {
        let fixture = Fixture::new("style-set-whitelist");
        fixture.write_slide(&slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let result = dispatch(
            &["element", "style", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "rx".to_string(),
                "5".to_string(),
            ],
        );
        assert!(!result.ok);
        assert_eq!(result.message, "style attribute rx not in style whitelist");
        // Rejected before any write — the slide file is untouched.
        assert!(!fixture.read_slide().contains("rx"));
    }

    #[test]
    fn align_and_distribute_via_the_cli_layer() {
        let fixture = Fixture::new("align-distribute");
        fixture.write_slide(&slide(
            r#"<g id="a"><rect x="0" y="0" width="10" height="10"/></g><g id="b" transform="translate(15 5)"><rect x="0" y="0" width="10" height="10"/></g><g id="c" transform="translate(100 0)"><rect x="0" y="0" width="10" height="10"/></g>"#,
        ));

        let aligned = dispatch(
            &["element", "align"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a,b,c".to_string(),
                "top".to_string(),
            ],
        );
        assert!(aligned.ok, "{}", aligned.message);
        // "top" moves every target's y to the union's top edge (0) — "b"
        // had y=5, so it moves up by 5.
        assert!(
            fixture
                .read_slide()
                .contains(r#"<g id="b" transform="translate(15 0)">"#)
        );

        let distributed = dispatch(
            &["element", "distribute"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a,b,c".to_string(),
                "horizontal".to_string(),
            ],
        );
        assert!(distributed.ok, "{}", distributed.message);

        for _ in 0..2 {
            history::undo(&fixture.id).unwrap();
        }
        assert!(
            fixture
                .read_slide()
                .contains(r#"<g id="b" transform="translate(15 5)">"#)
        );
    }

    #[test]
    fn align_rejects_direction_outside_the_fixed_set_via_the_cli_layer() {
        let fixture = Fixture::new("align-bad-direction");
        fixture.write_slide(&slide(
            r#"<g id="a"><rect x="0" y="0" width="1" height="1"/></g><g id="b"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));
        let result = dispatch(
            &["element", "align"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a,b".to_string(),
                "middle".to_string(),
            ],
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "element align unsupported direction: middle"
        );
    }

    #[test]
    fn unknown_presentation_id_is_not_found() {
        let result = dispatch(
            &["element", "insert"],
            &[
                "rect".to_string(),
                "definitely-not-a-real-id".to_string(),
                "slides/001.svg".to_string(),
                "--x".to_string(),
                "0".to_string(),
                "--y".to_string(),
                "0".to_string(),
                "--width".to_string(),
                "10".to_string(),
                "--height".to_string(),
                "10".to_string(),
            ],
        );
        assert!(!result.ok);
        assert_eq!(
            result.failure_kind,
            Some(crate::result::FailureKind::NotFound)
        );
    }

    #[test]
    fn copy_writes_the_clipboard_file_and_does_not_touch_history_or_the_slide() {
        let fixture = Fixture::new("copy");
        let original = slide(
            r##"<g id="el-a" transform="translate(5 5)"><rect x="0" y="0" width="10" height="10" fill="#ff0000"/></g>"##,
        );
        fixture.write_slide(&original);

        let result = dispatch(
            &["element", "copy"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "el-a".to_string(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        let svg = result.data.as_ref().unwrap()["svg"].as_str().unwrap();
        assert!(svg.contains(r#"data-slidra-clipboard="elements""#), "{svg}");
        assert!(svg.contains(r##"transform="translate(5 5)""##), "{svg}");

        assert_eq!(
            fixture.read_slide(),
            original,
            "copy must not mutate the slide"
        );
        let undo_err = history::undo(&fixture.id).unwrap_err();
        assert_eq!(
            undo_err.message(),
            "no operation to undo",
            "copy must not occupy an undo step"
        );
    }

    #[test]
    fn cut_removes_the_element_and_occupies_one_undo_step() {
        let fixture = Fixture::new("cut");
        fixture.write_slide(&slide(
            r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let result = dispatch(
            &["element", "cut"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "el-a".to_string(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        assert!(!fixture.read_slide().contains("el-a"));

        let undo = history::undo(&fixture.id).unwrap();
        assert_eq!(undo.restored_paths, vec!["slides/001.svg".to_string()]);
        assert!(
            fixture.read_slide().contains("el-a"),
            "undo must restore the cut element"
        );
    }

    #[test]
    fn paste_from_the_internal_clipboard_file_after_a_copy() {
        let fixture = Fixture::new("copy-then-paste");
        fixture.write_slide(&slide(
            r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let copied = dispatch(
            &["element", "copy"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "el-a".to_string(),
            ],
        );
        assert!(copied.ok, "{}", copied.message);

        let pasted = dispatch(
            &["element", "paste"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "--dx".to_string(),
                "10".to_string(),
                "--dy".to_string(),
                "10".to_string(),
            ],
        );
        assert!(pasted.ok, "{}", pasted.message);
        let element_ids = pasted.data.as_ref().unwrap()["elementIds"]
            .as_array()
            .unwrap();
        assert_eq!(element_ids.len(), 1);
        let new_id = element_ids[0].as_str().unwrap();
        assert_ne!(
            new_id, "el-a",
            "paste must regenerate ids, never reuse the source id"
        );
        assert!(fixture.read_slide().contains(&format!(r#"id="{new_id}""#)));
        // Original untouched, new one carries the dx/dy translate.
        assert!(fixture.read_slide().contains(r#"<g id="el-a">"#));
    }

    #[test]
    fn paste_without_svg_file_and_no_prior_copy_reports_the_clipboard_is_empty() {
        let fixture = Fixture::new("paste-empty");
        fixture.write_slide(&slide(""));

        let result = dispatch(
            &["element", "paste"],
            &[fixture.id.clone(), "slides/001.svg".to_string()],
        );
        assert!(!result.ok);
        assert_eq!(result.message, "clipboard is empty");
    }

    #[test]
    fn paste_svg_file_reads_a_local_file_and_never_touches_the_internal_clipboard_file() {
        let fixture = Fixture::new("paste-svg-file");
        fixture.write_slide(&slide(""));

        let svg_file_path = fixture.work.join("external.svg");
        std::fs::write(
            &svg_file_path,
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:slidra="https://slidra.app/ns/2026" viewBox="0 0 1280 720" data-slidra-clipboard="elements" data-slidra-source="slides/999.svg"><g id="el-from-file"><rect x="0" y="0" width="1" height="1"/></g></svg>"#,
        )
        .unwrap();

        let result = dispatch(
            &["element", "paste"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "--svg-file".to_string(),
                svg_file_path.to_string_lossy().into_owned(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        assert!(fixture.read_slide().contains("<rect"));

        // The internal clipboard file was never written by a paste — a
        // second, plain paste (no --svg-file) with nothing ever copied must
        // still report an empty clipboard.
        let second = dispatch(
            &["element", "paste"],
            &[fixture.id.clone(), "slides/001.svg".to_string()],
        );
        assert!(!second.ok);
        assert_eq!(second.message, "clipboard is empty");
    }

    #[test]
    fn paste_svg_file_not_found_reports_the_missing_local_path() {
        let fixture = Fixture::new("paste-svg-file-missing");
        fixture.write_slide(&slide(""));

        let result = dispatch(
            &["element", "paste"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "--svg-file".to_string(),
                "/definitely/does/not/exist.svg".to_string(),
            ],
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "source file not found: /definitely/does/not/exist.svg"
        );
    }

    #[test]
    fn duplicate_creates_a_new_element_without_touching_the_clipboard_file() {
        let fixture = Fixture::new("duplicate");
        fixture.write_slide(&slide(
            r#"<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>"#,
        ));

        let result = dispatch(
            &["element", "duplicate"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "el-a".to_string(),
                "--dx".to_string(),
                "5".to_string(),
                "--dy".to_string(),
                "5".to_string(),
            ],
        );
        assert!(result.ok, "{}", result.message);
        let element_ids = result.data.as_ref().unwrap()["elementIds"]
            .as_array()
            .unwrap();
        assert_eq!(element_ids.len(), 1);
        let new_id = element_ids[0].as_str().unwrap();
        assert_ne!(new_id, "el-a");
        assert!(
            fixture.read_slide().contains("el-a"),
            "the source element must still be there"
        );
        assert!(fixture.read_slide().contains(new_id));

        // Duplicate must not have written the presentation's clipboard file
        // — a subsequent plain paste must still report an empty clipboard.
        let pasted = dispatch(
            &["element", "paste"],
            &[fixture.id.clone(), "slides/001.svg".to_string()],
        );
        assert!(!pasted.ok);
        assert_eq!(pasted.message, "clipboard is empty");
    }
}
