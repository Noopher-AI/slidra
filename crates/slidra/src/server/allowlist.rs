// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Per-caller-kind allow-lists (#397 "An allow-list per caller kind,
//! checked before dispatch"; Plan §7.4/§7.6). Editor's is a fixed list of
//! the commands the editor's panels actually use (mirrors
//! `packages/server/src/command-endpoint.ts`'s `COMMAND_WHITELIST` — this
//! is a deliberate, hand-copied Rust constant, not an import: this crate
//! has no dependency edge to `packages/server`, and the two lists are
//! each other's cross-check, not one canonical source feeding the other).
//! Agent's and viewer's are COMPUTED from `commands::category`, never
//! hand-listed, so neither goes stale as commands are added (Plan §7.4:
//! "用算的不用手列").
//!
//! Every one of the 68 editor names, and every category-based check
//! here, is a full command name in `commands::category`'s own sense (the
//! same strings `resolve_full_command` resolves to) — never a bare
//! family root.
//!
//! No hint/degrade parameter exists on `is_allowed` on purpose (#397
//! architecture: "downgrade hints may only narrow the allowed set, never
//! widen it" — spec #395's credential model has no such hint yet at all;
//! the signature below simply has no slot for one to be threaded through
//! that could widen anything, which is the simplest way to guarantee it
//! for however long that stays true).

use crate::commands::category::Category;
use crate::server::credential::CallerKind;

/// `packages/server/src/command-endpoint.ts`'s `COMMAND_WHITELIST`
/// (68 entries, hand-copied — see this module's own doc comment for why
/// that is deliberate, not a TODO to dedupe).
const EDITOR_ALLOWLIST: &[&str] = &[
    "element move",
    "element scale",
    "element rotate",
    "textbox width",
    "text set",
    "slide add",
    "slide delete",
    "slide duplicate",
    "slide move",
    "slide notes set",
    "element copy",
    "element cut",
    "element paste",
    "element insert",
    "textbox add",
    "element align",
    "element distribute",
    "element order",
    "element style set",
    "slide transition set",
    "template add",
    "template list",
    "template rename",
    "template delete",
    "plan list",
    "plan delete",
    "element resize",
    "element delete",
    "element duplicate",
    "element group",
    "element ungroup",
    "element name set",
    "effect add",
    "effect remove",
    "effect move",
    "effect set",
    "comment add",
    "comment edit",
    "comment delete",
    "table cell copy",
    "table cell cut",
    "table cell paste",
    "table create",
    "table cell set",
    "table cell style set",
    "table merge",
    "table col width",
    "table col insert",
    "table col delete",
    "table row insert",
    "table row delete",
    "table theme set",
    "table header set",
    "table bind",
    "table refresh",
    "table set",
    "chart create",
    "chart data set",
    "chart type set",
    "chart palette set",
    "chart axis set",
    "chart stack set",
    "chart legend set",
    "chart option set",
    "textbox align",
    "slide style set",
    "presentation canvas set",
    "slide background set",
    "undo",
    "redo",
];

/// Checked before dispatch, for every caller kind including the agent
/// (AC6): `category` is `None` for a command outside the 94-name universe
/// entirely (unrecognised) as well as for one this door genuinely never
/// categorised — both cases are refused identically, never let through.
pub fn is_allowed(kind: CallerKind, command_name: &str, category: Option<Category>) -> bool {
    match kind {
        CallerKind::Editor => EDITOR_ALLOWLIST.contains(&command_name),
        // AC7: no category -> refused, not merely "not explicitly
        // allowed" — `Category::CrossDeck`/`Category::Lifecycle` are
        // also refused, only `DeckScoped` passes.
        CallerKind::Agent => matches!(category, Some(Category::DeckScoped { .. })),
        // Computed, never hand-listed (Plan §7.4): every DeckScoped
        // command that does not mutate.
        CallerKind::Viewer => matches!(category, Some(Category::DeckScoped { mutates: false, .. })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_allowlist_has_exactly_70_entries_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for name in EDITOR_ALLOWLIST {
            assert!(
                seen.insert(*name),
                "duplicate editor allowlist entry: {name:?}"
            );
        }
        assert_eq!(EDITOR_ALLOWLIST.len(), 70);
    }

    #[test]
    fn every_editor_allowlist_entry_is_a_real_categorised_command() {
        for name in EDITOR_ALLOWLIST {
            assert!(
                crate::commands::category::category_of(name).is_some(),
                "editor allowlist entry {name:?} is not a real command name"
            );
        }
    }

    #[test]
    fn agent_may_reach_every_deck_scoped_command_and_nothing_else() {
        assert!(is_allowed(
            CallerKind::Agent,
            "element move",
            Some(Category::DeckScoped {
                deck_id_arg: 0,
                mutates: true
            })
        ));
        assert!(is_allowed(
            CallerKind::Agent,
            "cat",
            Some(Category::DeckScoped {
                deck_id_arg: 0,
                mutates: false
            })
        ));
        assert!(!is_allowed(
            CallerKind::Agent,
            "open",
            Some(Category::Lifecycle)
        ));
        assert!(!is_allowed(
            CallerKind::Agent,
            "deck list",
            Some(Category::CrossDeck)
        ));
        assert!(!is_allowed(CallerKind::Agent, "bogus", None));
    }

    #[test]
    fn viewer_may_only_reach_non_mutating_deck_scoped_commands() {
        assert!(is_allowed(
            CallerKind::Viewer,
            "cat",
            Some(Category::DeckScoped {
                deck_id_arg: 0,
                mutates: false
            })
        ));
        assert!(!is_allowed(
            CallerKind::Viewer,
            "element move",
            Some(Category::DeckScoped {
                deck_id_arg: 0,
                mutates: true
            })
        ));
        assert!(!is_allowed(
            CallerKind::Viewer,
            "open",
            Some(Category::Lifecycle)
        ));
    }

    #[test]
    fn editor_is_confined_to_the_hand_listed_commands() {
        assert!(is_allowed(
            CallerKind::Editor,
            "element move",
            Some(Category::DeckScoped {
                deck_id_arg: 0,
                mutates: true
            })
        ));
        assert!(is_allowed(
            CallerKind::Editor,
            "undo",
            Some(Category::DeckScoped {
                deck_id_arg: 0,
                mutates: true
            })
        ));
    }
}
