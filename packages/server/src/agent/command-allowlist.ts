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
 * far enough to matter here: whitespace splits words, single/double quotes
 * shield their contents — including whitespace and any character below —
 * from being treated as syntax) and requires two things structurally:
 *   1. the first token is the literal word `co-motion`, exactly — the
 *      *program being executed*, not a prefix match and not an argument;
 *   2. no character that could start a second command (`;`, `|`, `&`,
 *      backtick, `$`, `<`, `>`, `(`, `)`, `{`, `}`, a newline) appears
 *      outside quotes anywhere in the string.
 *
 * An unrecognised shape — an unterminated quote, an operator character
 * outside quotes, anything the tokenizer cannot make sense of — refuses by
 * default rather than trying to special-case it. This is deliberately not
 * an exhaustive denylist of "dangerous characters" checked against the raw
 * string: quoting has to be understood structurally, or legitimate
 * arguments containing spaces (e.g. Traditional Chinese slide text passed
 * to `co-motion text set`) could never be expressed at all.
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
 * A minimal POSIX-flavoured tokenizer: splits on unquoted whitespace,
 * treats single/double-quoted regions as literal text (no escape handling —
 * not needed for anything this module's caller uses), and returns undefined
 * the moment it sees an unquoted operator character or an unterminated
 * quote, rather than guessing at what the caller meant.
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
