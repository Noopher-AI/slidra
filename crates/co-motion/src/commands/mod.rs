//! The takeover table: the exact, closed set of subcommand names this
//! binary executes itself. Everything else falls back to the Node CLI (see
//! `fallback.rs`) — this is what makes coexistence safe: adding a Rust
//! command is opt-in, one name at a time, never "whatever main.rs happens
//! to parse".
//!
//! This is the TOP-LEVEL command word only (`argv[0]`) — `chart`/`table`
//! each cover many multi-word subcommands (`chart data set`, `table cell
//! style set`, ...) whose own dispatch happens one level down, in
//! `argv::chart`/`argv::table`'s `parse`. NOOP-281/F5 grows this table from
//! `["undo", "redo"]` to include `chart`/`table`/`asset` (26 commands
//! across those three top-level words — see `argv::chart`/`argv::table`/
//! `argv::asset` for the exact per-command list).
//!
//! `takeover_table_is_exactly_the_declared_set` below is a deliberate
//! tripwire (renamed from `takeover_table_is_exactly_undo_and_redo` by this
//! same commit that first grew the table past two entries): a future
//! ticket adding another top-level command WILL break this test, and
//! that's the point — it forces a conscious edit here rather than a
//! command silently becoming Rust-dispatched as a side effect of some
//! other change.

pub mod asset_import;
pub mod chart;
pub mod redo;
pub mod table;
pub mod undo;

pub const TAKEOVER_TABLE: &[&str] = &["undo", "redo", "chart", "table", "asset"];

pub fn is_in_takeover_table(name: &str) -> bool {
    TAKEOVER_TABLE.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_table_is_exactly_the_declared_set() {
        assert_eq!(TAKEOVER_TABLE, ["undo", "redo", "chart", "table", "asset"]);
    }

    #[test]
    fn ls_is_not_in_the_takeover_table() {
        // `ls` has a renderer and looks trivially portable — a later
        // ticket's job, not this one's.
        assert!(!is_in_takeover_table("ls"));
    }
}
