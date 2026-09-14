// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { SlidraError } from "./errors.js";
import { runJsonCommand } from "./command.js";

/**
 * `beginHistoryGroup`/`endHistoryGroup` — [E6.T6]: undo history moved
 * inside the deck file itself (three side tables next to `content`,
 * `crates/slidra/src/history.rs`'s module doc), so `packages/server` no
 * longer reads/writes `stack.json`'s `openGroup` field directly. These two
 * functions are now thin wrappers over the Rust binary's own internal
 * `slidra history begin-group`/`slidra history end-group` commands
 * (`crates/slidra/src/commands/history_group.rs`, `docs/spec/cli.md`'s
 * "## Internal commands" — not part of the agent-facing command surface),
 * which themselves wrap `crate::history::begin_history_group`/
 * `end_history_group`.
 *
 * `crates/slidra/src/history.rs`'s own comment documents the exact
 * co-existence this preserves: the Rust binary's own commands append onto
 * whatever group this module leaves open, and close it themselves only
 * when there is none — the two sides are still reading and writing the
 * *same* deck's open-group row, not two independent stores. The one-
 * history-group-per-turn contract `agent/session.ts` relies on is
 * unchanged; only the storage these two calls go through has moved.
 */

/**
 * Opens a group that spans multiple commands (an agent's turn) so they undo
 * together as one step. Returns `true` when this call is the one that
 * opened the group — the caller owns it and MUST call `endHistoryGroup` in
 * a `finally` block. Returns `false` when a group was already open — the
 * caller has joined it and MUST NOT close it.
 */
export async function beginHistoryGroup(id: string): Promise<boolean> {
  const result = await runJsonCommand<{ opened: boolean }>(["history", "begin-group", id]);
  if (!result.ok) {
    throw new SlidraError(result.message);
  }
  return result.data?.opened ?? false;
}

/**
 * Closes the group opened by `beginHistoryGroup` and pushes it onto the
 * undo stack as one step. An empty group (no command in it ever wrote
 * anything) is discarded rather than pushed.
 */
export async function endHistoryGroup(id: string): Promise<void> {
  const result = await runJsonCommand(["history", "end-group", id]);
  if (!result.ok) {
    throw new SlidraError(result.message);
  }
}
