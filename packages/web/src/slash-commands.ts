// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * [E3.T3] #232/#236: pure logic for the chat input's `/` slash-command
 * menu. Deliberately no React import here — `ChatPanel.tsx` owns the UI
 * state and wiring; this module is testable with plain unit assertions
 * (see slash-commands.test.ts), the same split `chat-stream.ts` already
 * uses for turn bookkeeping vs. rendering.
 */

/** The shape both `GET /api/agent/commands` and the `agent-commands` SSE event send. */
export interface SlashCommandOption {
  /** Never includes the leading "/" — callers add it for display. */
  name: string;
  description: string;
}

const SLASH_TRIGGER = /^\/(\S*)$/;

/**
 * Whether `draft` currently matches the `/` trigger — the whole string must
 * start with "/" and contain no whitespace after it (a completed command
 * with its trailing space, or a command plus typed arguments, no longer
 * matches). Returns the captured query (possibly empty, for a bare "/") or
 * `null` when the trigger condition does not hold.
 */
export function slashQuery(draft: string): string | null {
  const match = SLASH_TRIGGER.exec(draft);
  return match ? match[1] : null;
}

/** Prefix match on `name`, case-insensitive — no fuzzy matching (explicitly out of scope). */
export function filterCommands(commands: readonly SlashCommandOption[], query: string): SlashCommandOption[] {
  const lowerQuery = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(lowerQuery));
}

/** Moves the selected index by `delta`, wrapping around both ends. `itemCount` of 0 always yields 0. */
export function moveSelection(currentIndex: number, itemCount: number, delta: 1 | -1): number {
  if (itemCount === 0) return 0;
  return (currentIndex + delta + itemCount) % itemCount;
}

/** The draft text after completing `name` — a trailing space so the trigger regex above stops matching and typing continues naturally. */
export function completeDraft(name: string): string {
  return `/${name} `;
}
