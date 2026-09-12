/**
 * Recognises a `slidra` invocation written in a shape that is provably
 * free of shell syntax.
 *
 * **Its role changed with ADR-0019.** This used to be the gate: a command
 * that did not match was refused. It is now the fast path — a command that
 * matches is the CLI and is allowed outright, and one that does not is
 * judged by `protected-paths.ts` instead (refused only if it names the
 * presentation's real files). Everything below is unchanged and must stay
 * that way: it is still what lets a `slidra` command be allowed without
 * looking at what its arguments contain.
 *
 * Earlier revisions of this module tried to *recognise danger*: tokenize
 * the string the way a POSIX shell would, and refuse anything that looked
 * like it could chain, pipe, substitute, or redirect. Each round found one
 * more shell construct the tokenizer had not modelled — quoting, then
 * command substitution, then backslash escapes changing where a quoted
 * region actually closes (`slidra "foo\"bar"; printf PWNED \"` passed
 * the old tokenizer while bash treats the `;` as unquoted). That is not a
 * sequence of bugs to patch; it is proof that matching a POSIX shell's
 * grammar exactly is not a winnable game. The shell's grammar is large and
 * has corners nobody in this codebase has thought of yet.
 *
 * So this module no longer tries to recognise what is dangerous. Instead
 * it accepts only a narrow, provably safe *shape* and refuses everything
 * else — including inputs that would probably have been fine. Safety here
 * is a property of which characters are allowed to appear, not of this
 * code's ability to model shell semantics. Do NOT "improve" this back into
 * a shell parser: if a new construct needs to be allowed, it must be added
 * as a new character or quoting rule to the grammar below, re-justified
 * from scratch against POSIX quoting rules — not patched in as one more
 * special case.
 *
 * The accepted shape:
 *   1. The command is a sequence of arguments separated by plain spaces or
 *      tabs. The first argument must be exactly the literal word
 *      `slidra` — the program being executed, not a prefix match
 *      (`slidra-something-else` is refused) and not merely present
 *      somewhere in the string (`sh -c 'slidra ls'` is refused, because
 *      its first argument is `sh`).
 *   2. Every argument is *either*:
 *        - a bare token made only of ASCII letters, digits, and
 *          `_ . / : = , @ + -`, plus any non-ASCII codepoint (U+0080 and
 *          above, which carries no meaning to the shell — so unquoted
 *          Traditional Chinese text is accepted as-is); or
 *        - a single-quoted string: `'` ... `'` with any characters except
 *          `'` in between. POSIX single quotes have no escapes and no
 *          substitutions of any kind, so their contents are unconditionally
 *          literal — there is no shell construct to fail to model here.
 *      An argument may not mix the two forms (no `foo'bar'`), and nothing
 *      may follow a closing `'` except whitespace or end of string.
 *   3. Double quotes are refused wherever they appear. POSIX still expands
 *      `$(...)`, backticks, and `$VAR`/`${VAR}` *inside* double quotes, so
 *      a double-quoted argument is never literal text — there is no way to
 *      treat it as safe without re-parsing its contents, which is exactly
 *      the losing game this module has stopped playing. Nothing an agent
 *      needs to express requires double quotes; single quotes cover every
 *      literal string, including ones containing `$` or a backtick.
 *   4. A backslash is refused wherever it appears, including inside single
 *      quotes. This is what actually closed the bug described above:
 *      backslash escapes are what made an earlier tokenizer disagree with
 *      bash about where a quoted region ends. Refusing `\` outright,
 *      unconditionally, removes the entire question of escape handling
 *      instead of trying to get it right.
 *   5. A single trailing `2>&1` — the one redirection the grammar accepts.
 *      This is not a patched-in special case of the kind the paragraph
 *      above warns against: it is a fixed four-character literal, stripped
 *      off the end of the string *before* tokenizing, and it carries no
 *      caller content at all. Justified from scratch: `2>&1` at the end of
 *      a command sends stderr where stdout already goes and can start no
 *      new command, name no new program, and expand nothing. Whatever
 *      remains after stripping it still has to pass rules 1–4 unchanged,
 *      so `slidra cat X 'abc 2>&1` (unterminated quote) and
 *      `slidra cat X$(id) 2>&1` are still refused. Only one occurrence
 *      is stripped — `slidra ls X 2>&1 2>&1` is refused. It is allowed
 *      because agents append it by reflex to see stderr, and a refusal
 *      reaches them as an opaque "the user rejected this", which they read
 *      as a human saying no and stop on.
 *   6. Anything else — any other ASCII punctuation or operator character,
 *      any control character, an unterminated quote, trailing characters
 *      after a closing quote — is refused.
 *
 * A command an agent cannot express this way is a small cost. A bypass of
 * this allowlist is not.
 */
export function isSlidraCommand(command: string): boolean {
  const tokens = tokenize(stripTrailingStderrRedirect(command));
  return tokens !== undefined && tokens.length > 0 && tokens[0] === "slidra";
}

/**
 * Removes one trailing `2>&1` (rule 5), which must be preceded by
 * whitespace so it is a redirection of its own and not the tail of some
 * larger token. Everything before it is returned untouched for `tokenize`
 * to judge on its own terms — this function never decides anything is
 * allowed, it only takes the redirection out of the tokenizer's way.
 */
function stripTrailingStderrRedirect(command: string): string {
  const match = /[ \t]2>&1[ \t]*$/.exec(command);
  return match === null ? command : command.slice(0, match.index);
}

/** ASCII punctuation permitted in a bare (unquoted) token, besides letters/digits. */
const BARE_ASCII_PUNCTUATION = new Set(["_", ".", "/", ":", "=", ",", "@", "+", "-"]);

/**
 * True for characters allowed in a bare token: ASCII letters, digits, the
 * fixed punctuation set above, and any non-ASCII codepoint (U+0080+, which
 * carries no meaning to a POSIX shell). Everything else — including every
 * shell operator character, `"`, and `\` — is excluded, so a bare token
 * can never itself smuggle shell syntax.
 */
function isBareChar(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  if (code >= 0x80) return true;
  return /[A-Za-z0-9]/.test(ch) || BARE_ASCII_PUNCTUATION.has(ch);
}

/**
 * Splits `command` into arguments under the grammar documented above, or
 * returns undefined the moment anything falls outside it. Iterates by
 * Unicode codepoint (via `Array.from`) so multi-byte characters — the
 * common case here, Traditional Chinese text — are never split apart.
 */
function tokenize(command: string): string[] | undefined {
  const chars = Array.from(command);
  const tokens: string[] = [];
  let i = 0;
  const n = chars.length;

  while (i < n) {
    const ch = chars[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    if (ch === "'") {
      let j = i + 1;
      let content = "";
      let closed = false;
      while (j < n) {
        if (chars[j] === "'") {
          closed = true;
          break;
        }
        if (chars[j] === "\\") {
          // Backslash rejected unconditionally, even inside single quotes
          // (see module docstring point 4).
          return undefined;
        }
        content += chars[j];
        j++;
      }
      if (!closed) return undefined; // unterminated quote
      tokens.push(content);
      i = j + 1;
      if (i < n && chars[i] !== " " && chars[i] !== "\t") return undefined; // e.g. 'foo'bar
      continue;
    }

    if (!isBareChar(ch)) {
      // Covers `"`, `\`, and every shell operator character — none of them
      // may start (or appear anywhere within) a bare token.
      return undefined;
    }
    let token = "";
    while (i < n && isBareChar(chars[i])) {
      token += chars[i];
      i++;
    }
    if (i < n && chars[i] !== " " && chars[i] !== "\t") return undefined; // e.g. foo'bar
    tokens.push(token);
  }

  return tokens;
}
