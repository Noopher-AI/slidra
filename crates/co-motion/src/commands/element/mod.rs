//! `element *` family: CLI argv layer for all 19 `element` subcommands
//! (plan section 1.1). Each subcommand's argv parsing + `CommandResult`
//! assembly lives in its own sibling module, added one at a time as each
//! phase of the ticket's commit sequence lands its slice (plan section
//! 6.5) — this file only owns the family's takeover-table slice and the
//! dispatch that routes a resolved command to its handler.
//!
//! The pure SVG-mutation logic every handler calls into lives at
//! `crate::element` (`crates/co-motion/src/element/`), NOT here — this
//! module is CLI plumbing only, mirroring `packages/cli/src/commands/
//! element/index.ts`'s split from `packages/core/src/element-*.ts`.

use crate::commands::CommandTokens;
use crate::result::CommandResult;

/// This family's slice of the crate-wide takeover table. Empty until the
/// first command-implementing phase appends to it — deliberately not
/// pre-populated with all 19 names up front: an entry here with no working
/// handler behind it is a silently-broken command (plan section 6.5's "做不
/// 完時的交付規則"), so this list only ever grows in lockstep with
/// `dispatch` below, one phase at a time.
pub const TAKEOVER: &[CommandTokens] = &[];

pub fn dispatch(_tokens: CommandTokens, _args: &[String]) -> CommandResult {
    unreachable!("commands::element::TAKEOVER is empty; nothing can resolve to this dispatch yet")
}
