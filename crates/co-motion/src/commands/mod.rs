//! The takeover table: the exact, closed set of subcommand names this
//! binary executes itself. Everything else falls back to the Node CLI (see
//! `fallback.rs`) — this is what makes coexistence safe: adding a Rust
//! command is opt-in, one name at a time, never "whatever main.rs happens
//! to parse".
//!
//! [E4.T7] grows the table past `undo`/`redo` for the first time, and past
//! single-word command names for the first time too (`effect add` is two
//! argv tokens). `match_takeover` tries the two-token join first, then
//! falls back to the single first token — `undo`/`redo` still match via the
//! second branch. `takeover_table_is_exactly_undo_redo_and_effect` is the
//! same deliberate tripwire the previous ticket's test was: a later ticket
//! (F3/F4/F5) growing this list WILL break the test, forcing a conscious
//! edit here rather than a command silently becoming Rust-dispatched as a
//! side effect of some other change.

pub mod effect;
pub mod redo;
pub mod undo;

pub const TAKEOVER_TABLE: &[&str] = &[
    "undo",
    "redo",
    "effect add",
    "effect list",
    "effect move",
    "effect remove",
    "effect set",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_table_is_exactly_undo_redo_and_effect() {
        assert_eq!(
            TAKEOVER_TABLE,
            [
                "undo",
                "redo",
                "effect add",
                "effect list",
                "effect move",
                "effect remove",
                "effect set",
            ]
        );
    }

    #[test]
    fn ls_is_not_in_the_takeover_table() {
        // `ls` has a renderer and looks trivially portable, which is exactly
        // why plan section 2 calls it out by name as something Execute must
        // NOT move to Rust in this ticket (that's a later ticket's job).
        assert!(!is_in_takeover_table("ls"));
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
