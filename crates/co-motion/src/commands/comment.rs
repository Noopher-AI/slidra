//! `comment *` family: `comment add` / `comment edit` / `comment delete` /
//! `comment list` (plan section 1.1, phase P8). CLI argv layer only — the
//! pure `<comot:comments>` read/write logic lives at `crate::slide::
//! comments`, mirroring `packages/cli/src/commands/comment.ts`'s split from
//! `packages/core/src/slide/comments.ts` + `slide-ops.ts`.

use crate::commands::CommandTokens;
use crate::result::CommandResult;

/// Empty until phase P8 appends its four commands — see
/// `commands::element::TAKEOVER`'s doc for why this list only grows in
/// lockstep with a working `dispatch` arm, never ahead of it.
pub const TAKEOVER: &[CommandTokens] = &[];

pub fn dispatch(_tokens: CommandTokens, _args: &[String]) -> CommandResult {
    unreachable!("commands::comment::TAKEOVER is empty; nothing can resolve to this dispatch yet")
}
