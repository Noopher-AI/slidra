// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Per-command categorisation for the deck server's door ([S11.F2], #397
//! "An allow-list per caller kind, checked before dispatch... The agent's
//! list is expressed by category"). This module owns only the
//! classification and the door's own command-name resolution; the
//! allow-lists themselves (which categories each caller kind may reach)
//! live in `server::allowlist`.
//!
//! Every family that dispatches through the newer, multi-token mechanism
//! (`element`/`text`/`textbox`/`comment`/`deck`) carries its own
//! `CATEGORIES` table, in the same order as its `TAKEOVER` table — mirrors
//! how the category values were reviewed command-by-command against that
//! family's own handler file. Every command dispatched through the legacy,
//! single/two-token mechanism (everything in `REGISTERED_COMMAND_NAMES`,
//! plus the two internal `history` commands) is categorised in this
//! module's own `CATEGORIES`, since those handlers are spread across many
//! unrelated files with no shared parent module of their own.
//!
//! `deck_id_arg` is always relative to the FULL command name's own token
//! count (e.g. for `presentation canvas set`, position 0 is the first
//! token AFTER all three name tokens) — not to whatever prefix the CLI's
//! own two-mechanism dispatch happens to strip internally. The door never
//! reuses that internal slicing: it resolves the full name itself (see
//! `resolve_full_command` below) and rewrites argv at
//! `tokens.len() + deck_id_arg` (AC8).

use crate::commands::{comment, deck, element, text, textbox};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    /// Scoped to this workbench's own deck: `deck_id_arg` is the argv
    /// position, counted from the first token AFTER the full command
    /// name, that carries the workbench/presentation id — always
    /// overwritten by the door with the credential-bound id (AC8), never
    /// trusted from the caller. `mutates` distinguishes a write from a
    /// read for the viewer's own (computed, not hand-listed) allow-list.
    DeckScoped { deck_id_arg: usize, mutates: bool },
    /// Names, or can name, a deck other than this workbench's own (a raw
    /// filesystem path standing in for an arbitrary deck, or an
    /// unconstrained id-or-path dual mode).
    CrossDeck,
    /// Changes what deck exists, or writes to a caller-chosen destination
    /// outside this workbench's own deck storage — `new`/`open` (raw
    /// path, nothing to resolve through the registry at all) and
    /// `pack`/`extract` (an arbitrary output path/directory, the primary
    /// hazard, is a SECOND argument the door has no slot to rewrite).
    Lifecycle,
}

/// This module's own slice of the crate-wide category table: every
/// legacy-mechanism command (`commands::REGISTERED_COMMAND_NAMES`, 61
/// names) plus the two internal `history` commands (`commands::
/// CORE_TAKEOVER`'s other two entries — `undo`/`redo` are also in
/// `REGISTERED_COMMAND_NAMES` and are NOT duplicated here). 63 entries.
pub const CATEGORIES: &[(&str, Category)] = &[
    ("new", Category::Lifecycle),
    ("open", Category::Lifecycle),
    ("pack", Category::Lifecycle),
    ("extract", Category::Lifecycle),
    (
        "ls",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "cat",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "convert",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "presentation canvas set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide add",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide delete",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide duplicate",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide move",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide notes set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide style set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide transition set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide render",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "slide set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "slide background set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "template add",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "template list",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "template rename",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "template delete",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "plan set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "plan list",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "plan delete",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "validate",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "effect add",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "effect list",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "effect move",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "effect remove",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "effect set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "undo",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "redo",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart create",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart type set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart data set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart axis set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart legend set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart option set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart palette set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chart stack set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table create",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table bind",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table refresh",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table header set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table theme set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table merge",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table cell set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table cell style set",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table cell copy",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: false,
        },
    ),
    (
        "table cell cut",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table cell paste",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table row insert",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table row delete",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table col insert",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table col delete",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "table col width",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "asset import",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "font import",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "chat-history",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "history begin-group",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
    (
        "history end-group",
        Category::DeckScoped {
            deck_id_arg: 0,
            mutates: true,
        },
    ),
];

/// Chains this module's own table with every family's — the ONLY place
/// that walks all five family tables plus this one, so a new family
/// automatically enters `category_of`/`resolve_full_command` the moment it
/// is added here.
fn all_entries() -> impl Iterator<Item = &'static (&'static str, Category)> {
    CATEGORIES
        .iter()
        .chain(element::CATEGORIES)
        .chain(text::CATEGORIES)
        .chain(textbox::CATEGORIES)
        .chain(comment::CATEGORIES)
        .chain(deck::CATEGORIES)
}

/// Looks up a full command name's category. `None` means "not in the 94-
/// name universe at all" — the door treats that identically to "no
/// category assigned", refusing the agent (AC7) rather than guessing.
pub fn category_of(name: &str) -> Option<Category> {
    all_entries().find(|(n, _)| *n == name).map(|(_, c)| *c)
}

/// Resolves argv's longest-prefix full command name across the ENTIRE
/// dispatchable universe (94 names — the same 92 `cli_golden.rs` counts as
/// public CLI commands, plus the two internal `history` ones), returning
/// the matched name and how many leading argv tokens it consumes. This is
/// `commands::resolve_takeover`/`match_takeover`'s own longest-prefix
/// algorithm, generalised to the full universe: the door must classify a
/// command (and know where its id argument sits) before `cli::
/// run_argv_to` ever re-parses the same argv its own, unrelated way.
///
/// Unambiguous by construction: every name in the table above is the
/// FULL, deepest registered command name (never a bare family root like
/// `"chart"` or `"effect"` on their own), so no two distinct entries can
/// both be a literal prefix of the same argv — the longer one, if it
/// matches at all, is the only one that ever will.
pub fn resolve_full_command(argv: &[&str]) -> Option<(&'static str, usize)> {
    let mut best: Option<(&'static str, usize)> = None;
    for (name, _) in all_entries() {
        let token_count = name.split(' ').count();
        if argv.len() < token_count {
            continue;
        }
        let matches = name.split(' ').zip(argv.iter()).all(|(a, b)| a == *b);
        if !matches {
            continue;
        }
        if best.is_none_or(|(_, len)| token_count > len) {
            best = Some((name, token_count));
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{self, comment, deck, element, text, textbox};

    /// The completeness guard (AC7's "a command with no category is
    /// refused"): every name the CLI can actually dispatch — derived
    /// straight from the same tables `commands::mod`'s own dispatch code
    /// walks, not a hand-maintained duplicate of them — has a category.
    /// Adding a 95th command to any of those tables without adding a
    /// matching `CATEGORIES` entry breaks this test, because `all_names`
    /// below is built from the dispatch tables themselves.
    #[test]
    fn every_dispatchable_command_has_a_category() {
        let mut all_names: Vec<String> = commands::REGISTERED_COMMAND_NAMES
            .iter()
            .map(|s| s.to_string())
            .collect();
        all_names.push("history begin-group".to_string());
        all_names.push("history end-group".to_string());
        for tokens in element::TAKEOVER
            .iter()
            .chain(text::TAKEOVER)
            .chain(textbox::TAKEOVER)
            .chain(comment::TAKEOVER)
            .chain(deck::TAKEOVER)
        {
            all_names.push(tokens.join(" "));
        }
        assert_eq!(
            all_names.len(),
            94,
            "the dispatchable universe drifted from 94"
        );
        for name in &all_names {
            assert!(category_of(name).is_some(), "no category for {name:?}");
        }
    }

    #[test]
    fn category_table_itself_has_exactly_94_entries_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        let mut count = 0;
        for (name, _) in all_entries() {
            assert!(seen.insert(*name), "duplicate category entry: {name:?}");
            count += 1;
        }
        assert_eq!(count, 94);
    }

    /// Proves the completeness guard above is not vacuous: a name that is
    /// deliberately absent from every `CATEGORIES` table returns `None`,
    /// not a silently-permissive default — this is exactly the shape a
    /// future command added to dispatch but never categorised would take,
    /// and it is what would turn red in `every_dispatchable_command_has_a_category`
    /// if it ever happened for real.
    #[test]
    fn an_uncategorised_name_resolves_to_no_category() {
        assert_eq!(category_of("bogus-command-not-in-any-table"), None);
    }

    #[test]
    fn resolve_full_command_matches_the_longest_registered_name() {
        assert_eq!(
            resolve_full_command(&["chart", "data", "set", "pid", "--series", "a"]),
            Some(("chart data set", 3))
        );
        assert_eq!(
            resolve_full_command(&["presentation", "canvas", "set", "pid"]),
            Some(("presentation canvas set", 3))
        );
        assert_eq!(resolve_full_command(&["cat", "pid"]), Some(("cat", 1)));
    }

    #[test]
    fn resolve_full_command_no_match_returns_none() {
        assert_eq!(resolve_full_command(&["element", "frobnicate"]), None);
        assert_eq!(resolve_full_command(&[]), None);
    }
}
