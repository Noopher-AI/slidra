//! The takeover table: the exact, closed set of `argv[0]` names this binary
//! dispatches itself. Everything else falls back to the Node CLI (see
//! `fallback.rs`) — this is what makes coexistence safe: adding a Rust
//! command is opt-in, one name at a time, never "whatever main.rs happens
//! to parse".
//!
//! `TAKEOVER_TABLE` is keyed on `argv[0]` (D1, plan §7): a hit routes the
//! rest of argv into that family's own sub-command dispatch
//! (`commands::slide::run`, etc.). `REGISTERED_COMMAND_NAMES` is the fuller,
//! 21-entry list of actual registered command names (family plus
//! sub-command, where one exists) — [E4.T4]'s full scope, and what A1's
//! acceptance criterion is checked against, not `TAKEOVER_TABLE` itself.
//!
//! `undo`/`redo` were this crate's first two takeover-table entries (F2);
//! [E4.T4] grows the table to the 11 `argv[0]` names below.
//! `registered_command_names_is_exactly_the_21_command_names` below is a
//! deliberate tripwire, same spirit as F2's original
//! `takeover_table_is_exactly_undo_and_redo` (renamed/widened here rather
//! than kept as a second, now-redundant check — see this ticket's existing-
//! test inventory): a future ticket adding a command WILL break this test,
//! forcing a conscious edit here rather than a command silently becoming
//! Rust-dispatched as a side effect of some other change.

pub mod cat;
pub mod convert;
pub mod ls;
pub mod new;
pub mod open;
pub mod pack;
pub mod presentation;
pub mod redo;
pub mod slide;
pub mod template;
pub mod undo;

pub const TAKEOVER_TABLE: &[&str] = &[
    "cat",
    "convert",
    "ls",
    "new",
    "open",
    "pack",
    "presentation",
    "redo",
    "slide",
    "template",
    "undo",
];

pub fn is_in_takeover_table(name: &str) -> bool {
    TAKEOVER_TABLE.contains(&name)
}

/// The 21 full registered command names this ticket's scope covers —
/// `argv[0]` alone for a 6 single-level commands, `"<family> <sub...>"` for
/// the rest. `undo`/`redo` are commands F2 already registered; this ticket
/// leaves their entries exactly as they were.
pub const REGISTERED_COMMAND_NAMES: &[&str] = &[
    "new",
    "open",
    "pack",
    "ls",
    "cat",
    "convert",
    "presentation canvas set",
    "slide add",
    "slide delete",
    "slide duplicate",
    "slide move",
    "slide notes set",
    "slide style set",
    "slide transition set",
    "slide render",
    "template add",
    "template list",
    "template rename",
    "template delete",
    "undo",
    "redo",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_table_is_exactly_the_11_argv0_names() {
        assert_eq!(
            TAKEOVER_TABLE,
            [
                "cat",
                "convert",
                "ls",
                "new",
                "open",
                "pack",
                "presentation",
                "redo",
                "slide",
                "template",
                "undo"
            ]
        );
    }

    #[test]
    fn registered_command_names_is_exactly_the_21_command_names() {
        assert_eq!(REGISTERED_COMMAND_NAMES.len(), 21);
        assert_eq!(
            REGISTERED_COMMAND_NAMES,
            [
                "new",
                "open",
                "pack",
                "ls",
                "cat",
                "convert",
                "presentation canvas set",
                "slide add",
                "slide delete",
                "slide duplicate",
                "slide move",
                "slide notes set",
                "slide style set",
                "slide transition set",
                "slide render",
                "template add",
                "template list",
                "template rename",
                "template delete",
                "undo",
                "redo",
            ]
        );
    }

    #[test]
    fn ls_is_now_in_the_takeover_table() {
        // Was `!is_in_takeover_table("ls")` before this ticket (F2's own
        // tripwire, explicitly named by the F2 plan as something that WOULD
        // break once `ls` moved to Rust — that ticket is this one).
        assert!(is_in_takeover_table("ls"));
    }

    #[test]
    fn every_takeover_table_entry_is_a_prefix_of_some_registered_command() {
        for &family in TAKEOVER_TABLE {
            assert!(
                REGISTERED_COMMAND_NAMES
                    .iter()
                    .any(|&full| full == family || full.starts_with(&format!("{family} "))),
                "argv[0] {family:?} has no matching entry in REGISTERED_COMMAND_NAMES"
            );
        }
    }
}
