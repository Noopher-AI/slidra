//! The takeover table: the exact, closed set of `argv[0]` names this binary
//! dispatches itself. `serve`/`export` are the two names `main.rs` execs
//! Node for instead (`node_entry.rs` — a normative entry point per spec,
//! not a fallback); everything else that matches neither is rejected by
//! `main.rs` as "未知的命令" — there is no longer a second engine to defer
//! to.
//!
//! Two matching mechanisms coexist here, one per generation of families:
//!
//! - The legacy `TAKEOVER_TABLE: &[&str]` (F2/[E4.T4]/[E4.T7]/NOOP-281 F5)
//!   is keyed on `argv[0]` (D1, plan §7) for most families — a hit routes
//!   the rest of argv into that family's own sub-command dispatch
//!   (`commands::slide::run`, `argv::chart`/`argv::table`'s `parse`, etc.)
//!   — except `effect`, whose entries are the full two-word `"effect <sub>"`
//!   form ([E4.T7]; `match_takeover` tries the two-token join first, falling
//!   back to the single first token, so `chart`/`table`/`asset`/every other
//!   single-word family still match via the second branch).
//! - [E4.T5] adds a second mechanism for `undo`/`redo`/`element`/`text`/
//!   `textbox`/`comment`: each family owns a `CommandTokens = &'static
//!   [&'static str]` table of full multi-token command names (`element
//!   move`, `text style set`, ...), and `resolve_takeover` matches the
//!   LONGEST registered sequence that is a literal prefix of argv (plan
//!   section 1.4, decision D2) — not a family-prefix match — specifically
//!   so that an unregistered subcommand of a known family (e.g. `element
//!   frobnicate`) matches NOTHING and falls all the way through to
//!   `main.rs`'s final "未知的命令：<argv[0]>" branch. A family-prefix
//!   match would instead require Rust to reproduce every family's own
//!   "unknown subcommand" error text (`未知的子命令：<family> <sub>`)
//!   itself, which is exactly the extra error-surface this design avoids.
//!
//! `main.rs`'s `dispatch` tries the [E4.T5] mechanism (`resolve_takeover`)
//! first, then falls back to the legacy one (`match_takeover`) — the two
//! tables' first-token sets are disjoint (`undo`/`redo`/`element`/`text`/
//! `textbox`/`comment` vs. everything else), so there is no ordering
//! ambiguity between them. `undo`/`redo` are listed in both tables (they
//! predate the family split and fit either shape); the [E4.T5] mechanism
//! resolves them first in practice, so the legacy arms for them are inert
//! but kept for `match_takeover`'s own unit tests and to avoid special-
//! casing `TAKEOVER_TABLE`'s contents.
//!
//! `REGISTERED_COMMAND_NAMES` is the fuller list of actual registered
//! command names (family plus sub-command, where one exists) across BOTH
//! mechanisms — [E4.T4]'s full scope, [E4.T7]'s five `effect` sub-commands,
//! NOOP-281/F5's 26 `chart`/`table`/`asset` commands, and (once each phase
//! below lands) [E4.T5]'s 29 `element`/`text`/`textbox`/`comment` commands —
//! and what A1's acceptance criterion is checked against, not either
//! takeover table itself.
//!
//! The exact-contents tripwire tests below are deliberate, same spirit as
//! F2's original `takeover_table_is_exactly_undo_and_redo`: a future ticket
//! adding a command WILL break one of them, forcing a conscious edit here
//! rather than a command silently becoming Rust-dispatched as a side effect
//! of some other change.

pub mod argv;
pub mod asset_import;
pub mod cat;
pub mod chart;
pub mod comment;
pub mod convert;
pub mod effect;
pub mod element;
pub mod font;
pub mod ls;
pub mod new;
pub mod open;
pub mod pack;
pub mod plan;
pub mod presentation;
pub mod redo;
pub mod slide;
pub mod table;
pub mod template;
pub mod text;
pub mod textbox;
pub mod undo;
pub mod validate;

use crate::result::CommandResult;

/// One command's full name, tokenized — e.g. `&["element", "move"]` or
/// `&["text", "style", "set"]`. Always non-empty.
pub type CommandTokens = &'static [&'static str];

/// `undo`/`redo` are the only single-token, family-less entries under the
/// [E4.T5] mechanism — kept directly here rather than given their own
/// one-command "family module" (that would just be `element`/`text`/
/// `textbox`/`comment`'s pattern with an extra layer of indirection for two
/// commands that predate this ticket's family concept entirely).
const CORE_TAKEOVER: &[CommandTokens] = &[&["undo"], &["redo"]];

/// Every [E4.T5]-mechanism family's token-sequence list, in the fixed order
/// the combined table is defined in. A `const fn`/array (not a `Vec`) so
/// `resolve_takeover` allocates nothing on the hot path.
fn takeover_families() -> [&'static [CommandTokens]; 5] {
    [
        CORE_TAKEOVER,
        element::TAKEOVER,
        text::TAKEOVER,
        textbox::TAKEOVER,
        comment::TAKEOVER,
    ]
}

/// Flattens every [E4.T5]-mechanism family's table into one list — used
/// only by tests (the A1/exact-membership assertion) and nowhere on the
/// dispatch hot path, which walks `takeover_families()` directly to avoid
/// allocating a `Vec` per CLI invocation.
#[cfg(test)]
fn flattened_takeover_table() -> Vec<CommandTokens> {
    takeover_families().into_iter().flatten().copied().collect()
}

/// Resolves argv's [E4.T5]-mechanism command-name prefix, if any (`undo`/
/// `redo`/`element`/`text`/`textbox`/`comment`). Walks every family's table
/// and returns the LONGEST token sequence that is a literal prefix of
/// `argv` (ties cannot occur: no two registered commands share a full token
/// sequence, and no registered command is itself a prefix of another in
/// this ticket's table — plan section 1.4). `None` means "no entry in this
/// mechanism matches" — callers must still try the legacy `match_takeover`
/// before falling back to Node.
pub fn resolve_takeover(argv: &[&str]) -> Option<CommandTokens> {
    let mut best: Option<CommandTokens> = None;
    for candidate in takeover_families().into_iter().flatten().copied() {
        if argv.len() < candidate.len() {
            continue;
        }
        if argv[..candidate.len()] != *candidate {
            continue;
        }
        if best.is_none_or(|current| candidate.len() > current.len()) {
            best = Some(candidate);
        }
    }
    best
}

/// Dispatches a resolved [E4.T5]-mechanism takeover-table command to its
/// family's handler. `tokens` must be a value `resolve_takeover` actually
/// returned — the `unreachable!` below is guarded by that invariant, not a
/// runtime check.
pub fn dispatch(tokens: CommandTokens, args: &[String]) -> CommandResult {
    match tokens[0] {
        "undo" => undo::run(args),
        "redo" => redo::run(args),
        "element" => element::dispatch(tokens, args),
        "text" => text::dispatch(tokens, args),
        "textbox" => textbox::dispatch(tokens, args),
        "comment" => comment::dispatch(tokens, args),
        _ => unreachable!("resolve_takeover only ever returns entries from this table"),
    }
}

/// The legacy (pre-[E4.T5]) takeover table: `argv[0]` for most entries, the
/// full two-word `"effect <sub>"` form for `effect`. Every pre-existing
/// family stays here unchanged; see this module's doc comment for why
/// `undo`/`redo` also appear in the [E4.T5] `CORE_TAKEOVER` table above.
pub const TAKEOVER_TABLE: &[&str] = &[
    "asset",
    "cat",
    "chart",
    "convert",
    "effect add",
    "effect list",
    "effect move",
    "effect remove",
    "effect set",
    "font",
    "ls",
    "new",
    "open",
    "pack",
    "plan",
    "presentation",
    "redo",
    "slide",
    "table",
    "template",
    "undo",
    "validate",
];

/// Tries to match `argv`'s first one or two tokens against
/// `TAKEOVER_TABLE` (the legacy mechanism). Returns the matched table entry
/// and how many argv tokens it consumed (2 for a two-word command, 1 for a
/// one-word command) — `main.rs`'s dispatch strips that many tokens before
/// handing the rest to the matched command's handler.
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
/// a single already-known legacy-mechanism command name (as opposed to
/// `match_takeover`'s argv-token-consumption contract).
pub fn is_in_takeover_table(name: &str) -> bool {
    TAKEOVER_TABLE.contains(&name)
}

/// The 58 full registered command names this crate's scope covers —
/// `argv[0]` alone for the single-level commands, `"<family> <sub...>"` for
/// the rest. `undo`/`redo` are commands F2 already registered; [E4.T4] left
/// their entries exactly as they were, [E4.T7] added the five `effect`
/// sub-commands, and NOOP-281/F5 added the 26 `chart`/`table`/`asset`
/// commands.
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
    "slide set",
    "slide background set",
    "template add",
    "template list",
    "template rename",
    "template delete",
    "plan set",
    "plan list",
    "plan delete",
    "validate",
    "effect add",
    "effect list",
    "effect move",
    "effect remove",
    "effect set",
    "undo",
    "redo",
    "chart create",
    "chart type set",
    "chart data set",
    "chart axis set",
    "chart legend set",
    "chart option set",
    "chart palette set",
    "chart stack set",
    "table create",
    "table set",
    "table bind",
    "table refresh",
    "table header set",
    "table theme set",
    "table merge",
    "table cell set",
    "table cell style set",
    "table cell copy",
    "table cell cut",
    "table cell paste",
    "table row insert",
    "table row delete",
    "table col insert",
    "table col delete",
    "table col width",
    "asset import",
    "font import",
];

#[cfg(test)]
mod tests {
    use super::*;

    // `takeover_table_is_exactly_undo_and_redo`, the tripwire this module's
    // previous revision carried, is removed rather than updated in place —
    // see the `test: prune` commit's message for why. Its replacement is
    // below, now that P9 has landed every family's commands: asserting the
    // FULL 29-command membership before that point would just have
    // re-derived `CORE_TAKEOVER` — not a stronger assertion, a vacuous one.

    #[test]
    fn takeover_table_is_exactly_the_29_registered_commands_no_more_no_fewer() {
        // Round-1 review (NOOP-283/NOOP-292) debt item 2, deferred to P9 by
        // Dev-Leader's ruling on NOOP-309: the weaker
        // `flattened_table_has_no_duplicate_command` test below proves no
        // command is registered twice, but never proves the table is
        // exactly this ticket's 29 — it would pass equally well with 5
        // commands registered, or 40. This is the exhaustive version:
        // exact set equality, hand-written independently of
        // `commands::element`/`text`/`textbox`/`comment`'s own `TAKEOVER`
        // constants (re-deriving from them would just check the table
        // against itself).
        let expected: std::collections::HashSet<CommandTokens> = [
            &["element", "insert"][..],
            &["element", "delete"][..],
            &["element", "move"][..],
            &["element", "scale"][..],
            &["element", "resize"][..],
            &["element", "rotate"][..],
            &["element", "style", "set"][..],
            &["element", "order"][..],
            &["element", "group"][..],
            &["element", "ungroup"][..],
            &["element", "align"][..],
            &["element", "distribute"][..],
            &["element", "name", "set"][..],
            &["element", "copy"][..],
            &["element", "cut"][..],
            &["element", "paste"][..],
            &["element", "duplicate"][..],
            &["element", "lock"][..],
            &["element", "unlock"][..],
            &["text", "set"][..],
            &["text", "style", "set"][..],
            &["text", "list", "set"][..],
            &["textbox", "add"][..],
            &["textbox", "width"][..],
            &["textbox", "align"][..],
            &["comment", "add"][..],
            &["comment", "edit"][..],
            &["comment", "delete"][..],
            &["comment", "list"][..],
        ]
        .into_iter()
        .collect();
        assert_eq!(expected.len(), 29, "this test's own list drifted from 29");

        // Scoped to this ticket's four families, not `flattened_takeover_table()`
        // as a whole — that also carries `CORE_TAKEOVER`'s pre-existing
        // `undo`/`redo` (a prior ticket's entries, already covered by
        // `undo_and_redo_still_resolve_as_single_token_commands` above),
        // which are no more "this ticket's 29 commands" than a sixth
        // family would be.
        let actual: std::collections::HashSet<CommandTokens> = element::TAKEOVER
            .iter()
            .chain(text::TAKEOVER)
            .chain(textbox::TAKEOVER)
            .chain(comment::TAKEOVER)
            .copied()
            .collect();

        let missing: Vec<_> = expected.difference(&actual).collect();
        let extra: Vec<_> = actual.difference(&expected).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "takeover table diverges from the exact 29-command set — missing={missing:?} extra={extra:?}"
        );
    }

    #[test]
    fn takeover_table_is_exactly_the_declared_set() {
        assert_eq!(
            TAKEOVER_TABLE,
            [
                "asset",
                "cat",
                "chart",
                "convert",
                "effect add",
                "effect list",
                "effect move",
                "effect remove",
                "effect set",
                "font",
                "ls",
                "new",
                "open",
                "pack",
                "plan",
                "presentation",
                "redo",
                "slide",
                "table",
                "template",
                "undo",
                "validate",
            ]
        );
    }

    #[test]
    fn registered_command_names_is_exactly_the_declared_set() {
        assert_eq!(REGISTERED_COMMAND_NAMES.len(), 59);
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
                "slide set",
                "slide background set",
                "template add",
                "template list",
                "template rename",
                "template delete",
                "plan set",
                "plan list",
                "plan delete",
                "validate",
                "effect add",
                "effect list",
                "effect move",
                "effect remove",
                "effect set",
                "undo",
                "redo",
                "chart create",
                "chart type set",
                "chart data set",
                "chart axis set",
                "chart legend set",
                "chart option set",
                "chart palette set",
                "chart stack set",
                "table create",
                "table set",
                "table bind",
                "table refresh",
                "table header set",
                "table theme set",
                "table merge",
                "table cell set",
                "table cell style set",
                "table cell copy",
                "table cell cut",
                "table cell paste",
                "table row insert",
                "table row delete",
                "table col insert",
                "table col delete",
                "table col width",
                "asset import",
                "font import",
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

    #[test]
    fn match_takeover_single_word_family_matches_one_word_command() {
        // `chart`/`table`/`asset` are single-word `TAKEOVER_TABLE` entries
        // (unlike `effect`'s two-word entries) — confirm the one-word
        // fallback branch still matches them.
        assert_eq!(
            match_takeover(&["chart", "create", "pid"]),
            Some(("chart", 1))
        );
        assert_eq!(
            match_takeover(&["table", "create", "pid"]),
            Some(("table", 1))
        );
        assert_eq!(
            match_takeover(&["asset", "import", "pid"]),
            Some(("asset", 1))
        );
    }

    #[test]
    fn ls_is_not_in_the_takeover_table() {
        // `ls` is dispatched through the legacy `TAKEOVER_TABLE` mechanism
        // (F3, above) — it never was and still is not one of the [E4.T5]
        // family mechanism's own entries, which is what `resolve_takeover`
        // reports on.
        assert!(resolve_takeover(&["ls"]).is_none());
    }

    #[test]
    fn unregistered_subcommand_of_a_known_family_falls_through_entirely() {
        // `element frobnicate` must match NOTHING (not even a partial
        // "element ..." match) so the fallback path hands the whole argv to
        // Node untouched — see this module's doc comment on why a
        // family-prefix match is wrong.
        assert!(resolve_takeover(&["element", "frobnicate"]).is_none());
    }

    #[test]
    fn undo_and_redo_still_resolve_as_single_token_commands() {
        assert_eq!(resolve_takeover(&["undo", "some-id"]), Some(&["undo"][..]));
        assert_eq!(resolve_takeover(&["redo", "some-id"]), Some(&["redo"][..]));
    }

    #[test]
    fn empty_argv_never_matches() {
        assert!(resolve_takeover(&[]).is_none());
    }

    #[test]
    fn flattened_table_has_no_duplicate_command() {
        let table = flattened_takeover_table();
        let mut seen = std::collections::HashSet::new();
        for tokens in table {
            assert!(seen.insert(tokens), "duplicate takeover entry: {tokens:?}");
        }
    }
}
