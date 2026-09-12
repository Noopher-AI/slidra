// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns a command Slidra refused into one sentence telling the agent what
 * to use instead.
 *
 * Under the policy in `protected-paths.ts` there is now only one reason a
 * command is ever refused: it reached for the presentation's real files.
 * So every hint here says the same thing in the end — go through the CLI —
 * and the program only decides which command to name.
 *
 * Why say anything at all: a refusal reaches the agent as "the user
 * rejected this", which it reads as a human saying no, so it stops or
 * tries another spelling of the same forbidden thing. Being told which
 * command to use instead, it simply carries on.
 *
 * **This module decides nothing.** It never allows and never refuses; by
 * the time anything here runs, the decision is made. That is why the crude
 * `split(/\s+/)` below is fine: a wrong guess costs unhelpful advice, not
 * safety. Do not import it from code that decides whether something runs.
 */

const CLI_ONLY_ADVICE =
  "This presentation's files can only be read or written through `slidra` commands — a direct file edit does not enter the undo snapshot history, the view will not update, and it is not guaranteed to survive the next repack. The command list is in `reference/commands.md`.";

/** Program basenames whose intent is "read this file". */
const READ_PROGRAMS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl", "xxd", "od"]);
/** Program basenames whose intent is "list this directory". */
const LIST_PROGRAMS = new Set(["ls", "tree", "find", "dir", "du", "stat"]);

/**
 * One sentence of advice for `command`. Always returns something: every
 * refusal now means the same thing, and the agent needs to hear it.
 */
export function hintForBlockedCommand(command: string, presentationId: string): string {
  const program = command.trim().split(/\s+/)[0]?.split("/").pop();
  if (program !== undefined && READ_PROGRAMS.has(program)) {
    return `Use \`slidra cat ${presentationId} <virtual-path>\` instead (a virtual path is a relative path like \`project.json\` or \`slides/001.svg\`).`;
  }
  if (program !== undefined && LIST_PROGRAMS.has(program)) {
    return `Use \`slidra ls ${presentationId}\` instead (you may append a virtual path).`;
  }
  return CLI_ONLY_ADVICE;
}
