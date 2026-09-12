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
  "這份簡報的檔案只能透過 `slidra` 命令讀寫——直接改檔的修改不會進復原快照、畫面不會更新，重新打包時也不保證留得住。命令清單在 `reference/commands.md`。";

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
    return `請改用 \`slidra cat ${presentationId} <虛擬路徑>\`（虛擬路徑就是 \`project.json\`、\`slides/001.svg\` 這種相對路徑）。`;
  }
  if (program !== undefined && LIST_PROGRAMS.has(program)) {
    return `請改用 \`slidra ls ${presentationId}\`（可在後面加一段虛擬路徑）。`;
  }
  return CLI_ONLY_ADVICE;
}
