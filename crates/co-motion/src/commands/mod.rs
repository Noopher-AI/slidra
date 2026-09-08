//! The takeover table: the exact, closed set of subcommand names this
//! binary executes itself. Everything else falls back to the Node CLI (see
//! `fallback.rs`) — this is what makes coexistence safe: adding a Rust
//! command is opt-in, one name at a time, never "whatever main.rs happens
//! to parse".
//!
//! This ticket's takeover table is exactly `["undo", "redo"]` (plan section
//! 7, item 1; acceptance criterion A11) — a future ticket (F3) grows this
//! list one command at a time. `takeover_table_is_exactly_undo_and_redo`
//! below is a deliberate tripwire: F3 adding a command WILL break this test,
//! and that's the point — it forces a conscious edit here rather than a
//! command silently becoming Rust-dispatched as a side effect of some other
//! change.

pub mod asset_import;
pub mod chart;
pub mod redo;
pub mod table;
pub mod undo;

pub const TAKEOVER_TABLE: &[&str] = &["undo", "redo"];

pub fn is_in_takeover_table(name: &str) -> bool {
    TAKEOVER_TABLE.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_table_is_exactly_undo_and_redo() {
        assert_eq!(TAKEOVER_TABLE, ["undo", "redo"]);
    }

    #[test]
    fn ls_is_not_in_the_takeover_table() {
        // `ls` has a renderer and looks trivially portable, which is exactly
        // why plan section 2 calls it out by name as something Execute must
        // NOT move to Rust in this ticket (that's F3's job).
        assert!(!is_in_takeover_table("ls"));
    }
}
