/**
 * Decides whether a shell command string is allowed to reach the shell at
 * all (ADR-0004, second layer).
 *
 * Earlier revisions of this module tried to *recognise danger*: tokenize
 * the string the way a POSIX shell would, and refuse anything that looked
 * like it could chain, pipe, substitute, or redirect. Each round found one
 * more shell construct the tokenizer had not modelled — quoting, then
 * command substitution, then backslash escapes changing where a quoted
 * region actually closes (`co-motion "foo\"bar"; printf PWNED \"` passed
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
 *      `co-motion` — the program being executed, not a prefix match
 *      (`co-motion-something-else` is refused) and not merely present
 *      somewhere in the string (`sh -c 'co-motion ls'` is refused, because
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
 *   5. Anything else — any other ASCII punctuation or operator character,
 *      any control character, an unterminated quote, trailing characters
 *      after a closing quote — is refused.
 *
 * A command an agent cannot express this way is a small cost. A bypass of
 * this allowlist is not.
 */
export function isCoMotionCommand(command: string): boolean {
  const tokens = tokenize(command);
  return tokens !== undefined && tokens.length > 0 && tokens[0] === "co-motion";
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
