//! The takeover table: the exact, closed set of `argv[0]` names this binary
//! dispatches itself. Everything else falls back to the Node CLI (see
//! `fallback.rs`) — this is what makes coexistence safe: adding a Rust
//! command is opt-in, one name at a time, never "whatever main.rs happens
//! to parse".
//!
//! `TAKEOVER_TABLE` is keyed on `argv[0]` (D1, plan §7) for most families — a
//! hit routes the rest of argv into that family's own sub-command dispatch
//! (`commands::slide::run`, etc.) — except `effect`, whose entries are the
//! full two-word `"effect <sub>"` form ([E4.T7]; `match_takeover` tries the
//! two-token join first, falling back to the single first token, so
//! `undo`/`redo`/every single-word family still match via the second
//! branch). `REGISTERED_COMMAND_NAMES` is the fuller list of actual
//! registered command names (family plus sub-command, where one exists) —
//! [E4.T4]'s full scope, and what A1's acceptance criterion is checked
//! against, not `TAKEOVER_TABLE` itself.
//!
//! `undo`/`redo` were this crate's first two takeover-table entries (F2);
//! [E4.T4] grew the table to the 11 `argv[0]` names, and [E4.T7] added
//! `effect`'s five two-word entries on top. The exact-contents tripwire
//! tests below (`takeover_table_is_exactly_the_11_argv0_names_plus_effect`,
//! `registered_command_names_is_exactly_the_21_command_names`) are
//! deliberate, same spirit as F2's original
//! `takeover_table_is_exactly_undo_and_redo`: a future ticket adding a
//! command WILL break one of them, forcing a conscious edit here rather
//! than a command silently becoming Rust-dispatched as a side effect of
//! some other change.

pub mod cat;
pub mod convert;
pub mod effect;
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
    "effect add",
    "effect list",
    "effect move",
    "effect remove",
    "effect set",
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

/// Tries to match `argv`'s first one or two tokens against
/// `TAKEOVER_TABLE`. Returns the matched table entry and how many argv
/// tokens it consumed (2 for a two-word command, 1 for a one-word command)
/// — `main.rs`'s dispatch strips that many tokens before handing the rest
/// to the matched command's handler.
pub fn match_takeover(argv: &[&str]) -> Option<(&'static str, usize)> {
    if let (Some(first), Some(second)) = (argv.first(), argv.get(1)) {
        let two_word = format!("{first} {second}");
        if let Some(&name) = TAKEOVER_TABLE.iter().find(|&&entry| entry == two_word) {
            return Some((name, 2));
        }
    }
    if let Some(&first) = argv.first() {
        if let Some(&name) = TAKEOVER_TABLE.iter().find(|&&entry| entry == first) {
            return Some((name, 1));
        }
    }
    None
}

/// Retained for the CLI-boundary tests that only need a yes/no answer about
/// a single already-known command name (as opposed to `match_takeover`'s
/// argv-token-consumption contract).
pub fn is_in_takeover_table(name: &str) -> bool {
    TAKEOVER_TABLE.contains(&name)
}

/// The 26 full registered command names this crate's scope covers —
/// `argv[0]` alone for the 6 single-level commands, `"<family> <sub...>"`
/// for the rest. `undo`/`redo` are commands F2 already registered;
/// [E4.T4] left their entries exactly as they were, and [E4.T7] added the
/// five `effect` sub-commands on top.
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
    "effect add",
    "effect list",
    "effect move",
    "effect remove",
    "effect set",
    "undo",
    "redo",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_table_is_exactly_the_11_argv0_names_plus_effect() {
        assert_eq!(
            TAKEOVER_TABLE,
            [
                "cat",
                "convert",
                "effect add",
                "effect list",
                "effect move",
                "effect remove",
                "effect set",
                "ls",
                "new",
                "open",
                "pack",
                "presentation",
                "redo",
                "slide",
                "template",
                "undo",
            ]
        );
    }

    #[test]
    fn registered_command_names_is_exactly_the_26_command_names() {
        assert_eq!(REGISTERED_COMMAND_NAMES.len(), 26);
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
                "effect add",
                "effect list",
                "effect move",
                "effect remove",
                "effect set",
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

    #[test]
    fn match_takeover_prefers_two_word_match() {
        assert_eq!(
            match_takeover(&["effect", "add", "pid"]),
            Some(("effect add", 2))
        );
    }

    #[test]
    fn match_takeover_falls_back_to_one_word_match() {
        assert_eq!(match_takeover(&["undo", "pid"]), Some(("undo", 1)));
    }

    #[test]
    fn match_takeover_no_match_returns_none() {
        assert_eq!(match_takeover(&["element", "insert"]), None);
    }

    #[test]
    fn match_takeover_single_token_argv_still_matches_one_word_command() {
        assert_eq!(match_takeover(&["redo"]), Some(("redo", 1)));
    }

    #[test]
    fn match_takeover_effect_alone_does_not_match() {
        // "effect" by itself is not a takeover-table entry — only the
        // two-word forms are; an incomplete "effect" argv (no subcommand)
        // must fall through to the Node fallback, not error out of Rust.
        assert_eq!(match_takeover(&["effect"]), None);
    }
}
