/**
 * Decides whether a shell command string is structurally guaranteed to run
 * the `co-motion` program, and only that program (ADR-0004, second layer).
 *
 * `command.startsWith("co-motion")` is not this rule — it also matches
 * `co-motion-something-else` (a different program), `co-motion ls; rm -rf ~`
 * (a chained second command), `co-motion ls | sh` (a pipe), and anything
 * where `co-motion` is merely an argument to some other program
 * (`sh -c 'co-motion ls'`). None of those may be allowed.
 *
 * Instead this tokenizes the whole string the way a POSIX shell would (only
 * far enough to matter here: whitespace splits words; single quotes shield
 * their contents — including whitespace and any character below — from
 * being treated as syntax, with no exception. Double quotes shield most
 * syntax the same way, but POSIX still runs `$(...)` and backtick command
 * substitution and `$VAR`/`${VAR}` expansion *inside* double quotes — a
 * double-quoted argument is not literal text, so this tokenizer must not
 * treat it as such either) and requires two things structurally:
 *   1. the first token is the literal word `co-motion`, exactly — the
 *      *program being executed*, not a prefix match and not an argument;
 *   2. no character that could start a second command or run a nested one
 *      (`;`, `|`, `&`, backtick, `$`, `<`, `>`, `(`, `)`, `{`, `}`, a
 *      newline) appears outside single quotes anywhere in the string —
 *      inside double quotes this still excludes backtick and `$` (command
 *      substitution / variable expansion), even though the shell-operator
 *      characters proper (`;`, `|`, `&`, ...) are genuinely inert there.
 *
 * An unrecognised shape — an unterminated quote, an operator character
 * outside quotes, `$`/backtick inside double quotes, anything the tokenizer
 * cannot make sense of — refuses by default rather than trying to
 * special-case it. This is deliberately not an exhaustive denylist of
 * "dangerous characters" checked against the raw string: quoting has to be
 * understood structurally, or legitimate arguments containing spaces (e.g.
 * Traditional Chinese slide text passed to `co-motion text set`) could
 * never be expressed at all.
 */
export function isCoMotionCommand(command: string): boolean {
  const tokens = tokenize(command);
  return tokens !== undefined && tokens.length > 0 && tokens[0] === "co-motion";
}

/**
 * Characters that, appearing outside a quoted region, could introduce a
 * second command (chaining, piping, substitution, redirection, grouping).
 * Encountering any of these is a definite "cannot allow this", not a
 * boundary to be lenient about — so `tokenize` returns undefined rather
 * than trying to interpret past it.
 */
const OPERATOR_CHARS = new Set([";", "|", "&", "`", "$", "<", ">", "(", ")", "{", "}", "\n", "\r"]);

/**
 * Characters that must still be rejected even inside a double-quoted
 * region, because POSIX double quotes do not make them literal: `$` starts
 * both `$VAR`/`${VAR}` expansion and `$(...)` command substitution, and a
 * backtick starts the legacy form of command substitution. Single quotes
 * are unaffected — those genuinely are literal in POSIX and are not run
 * through this check.
 */
const DOUBLE_QUOTE_UNSAFE_CHARS = new Set(["$", "`"]);

/**
 * A minimal POSIX-flavoured tokenizer: splits on unquoted whitespace,
 * treats single-quoted regions as fully literal text, treats double-quoted
 * regions as literal *except* for `$`/backtick (still rejected — see
 * `DOUBLE_QUOTE_UNSAFE_CHARS`), and returns undefined the moment it sees an
 * unquoted operator character, a `$`/backtick inside double quotes, or an
 * unterminated quote, rather than guessing at what the caller meant. No
 * escape handling — not needed for anything this module's caller uses.
 */
function tokenize(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else if (quote === '"' && DOUBLE_QUOTE_UNSAFE_CHARS.has(ch)) {
        // Command substitution / variable expansion inside double quotes
        // is real shell syntax, not literal text (see module docstring) —
        // refuse rather than allow it through as a quoted argument.
        return undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    if (OPERATOR_CHARS.has(ch)) {
      return undefined;
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    // Unterminated quote: not a well-formed single command.
    return undefined;
  }
  if (inToken) tokens.push(current);
  return tokens;
}
