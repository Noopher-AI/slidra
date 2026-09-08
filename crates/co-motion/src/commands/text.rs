//! `text *` family: `text set` / `text style set` / `text list set` (plan
//! section 1.1, phase P6). CLI argv layer only — the pure mutation logic
//! lives at `crate::element::text`, mirroring `packages/cli/src/commands/
//! text-set.ts` / `text-style.ts` / `text-list.ts`'s split from
//! `packages/core/src/element-text.ts`.

use crate::commands::CommandTokens;
use crate::result::CommandResult;

/// Empty until phase P6 appends its three commands — see
/// `commands::element::TAKEOVER`'s doc for why this list only grows in
/// lockstep with a working `dispatch` arm, never ahead of it.
pub const TAKEOVER: &[CommandTokens] = &[];

pub fn dispatch(_tokens: CommandTokens, _args: &[String]) -> CommandResult {
    unreachable!("commands::text::TAKEOVER is empty; nothing can resolve to this dispatch yet")
}
