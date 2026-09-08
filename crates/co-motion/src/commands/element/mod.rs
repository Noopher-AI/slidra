//! `element *` family: CLI argv layer for the `element` subcommands (plan
//! section 1.1). Each subcommand's argv parsing + `CommandResult` assembly
//! lives in its own sibling module — this file only owns the family's
//! takeover-table slice and the dispatch that routes a resolved command to
//! its handler.
//!
//! The pure SVG-mutation logic every handler calls into lives at
//! `crate::element` (`crates/co-motion/src/element/`), NOT here — this
//! module is CLI plumbing only, mirroring `packages/cli/src/commands/
//! element/index.ts`'s split from `packages/core/src/element-*.ts`.
//!
//! Registered so far (phase P3 of the ticket's commit sequence): the ten
//! structural commands. `scale`/`resize`/`style set` (P4), `align`/
//! `distribute` (P5), `copy`/`cut`/`paste`/`duplicate` (P7) are not yet
//! registered — see this module's `TAKEOVER` doc for why an entry is never
//! added ahead of a working handler.

pub mod delete;
pub mod group;
pub mod insert;
pub mod lock;
/// Named `move_cmd`, not `move` — `move` is a Rust keyword.
pub mod move_cmd;
pub mod name_set;
pub mod order;
pub mod rotate;
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
        _ => unreachable!("commands::element::TAKEOVER only lists entries dispatch handles"),
    }
}

#[cfg(test)]
mod tests {
    //! End-to-end wiring tests: argv -> core mutation -> `write_presentation_file`
    //! -> undo history, for each of this phase's ten handlers. Lighter than
    //! phase P9's `tests/cli_golden.rs` (which spawns the real compiled
    //! binary and compares against Node) — these run the handler functions
    //! directly in-process against a temp `CO_MOTION_HOME`/work dir, proving
    //! the glue between `commands::element::*` and `workspace::write`/
    //! `history` is correct, ahead of that later, heavier layer.
    use super::*;
    use crate::history;
    use crate::workspace;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-cmd-element-{label}-{}",
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
                std::env::set_var("CO_MOTION_HOME", &home);
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
                std::env::remove_var("CO_MOTION_HOME");
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
            r#"<g id="a" data-comot-lock="true"><rect x="0" y="0" width="1" height="1"/></g>"#,
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
        assert!(result.message.contains("鎖定的版面骨架"));
        // The rejected command must not have touched the slide file at all.
        assert!(fixture.read_slide().contains(r#"data-comot-lock="true""#));
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
        assert!(fixture.read_slide().contains(r#"data-comot-lock="true""#));

        let named = dispatch(
            &["element", "name", "set"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
                "標題".to_string(),
            ],
        );
        assert!(named.ok, "{}", named.message);
        assert!(fixture.read_slide().contains(r#"data-comot-name="標題""#));

        let unlocked = dispatch(
            &["element", "unlock"],
            &[
                fixture.id.clone(),
                "slides/001.svg".to_string(),
                "a".to_string(),
            ],
        );
        assert!(unlocked.ok, "{}", unlocked.message);
        assert!(!fixture.read_slide().contains("data-comot-lock"));
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
}
