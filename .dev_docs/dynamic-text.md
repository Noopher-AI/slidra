## Dynamic text

Any text element's content can include `{{ variable_name }}` directly; at display time it's replaced
with a value computed live. This is a lookup-based substitution only, **not a template engine** — no
conditionals, loops, filters, or escape syntax (ADR-0007: slide content is untrusted input, and
substitution happens outside the sandbox — it's a lookup, not execution).

### Supported variables

| Variable | Value |
|---|---|
| `slide_number` | This slide's current index (1-based) in `project.json`'s `slides` array, recomputed every time it's displayed — always correct after the slide order changes, with no "renumber" action needed |
| `slide_total` | The current total number of slides |
| `presentation_name` | The deck's name (`project.json`'s `name`) |

### Behavior

- Whitespace around the variable name is allowed: both `{{ slide_number }}` and `{{  slide_number  }}` work.
- An unknown variable name (not one of the three above): **kept as literal text, no error thrown**.
- An unmatched `{{` (no corresponding `}}`): **kept as literal text, no error thrown**. This isn't a
  format error — it's "no variable here."
- A single text element can contain multiple variables, and the same variable can appear more than once;
  each occurrence is substituted independently.
- Inside a text box (multi-line `<tspan>`s wrapped by a `data-slidra-text-width` container), each line is
  scanned and substituted independently, and this never triggers rewrapping; if the substituted text is
  longer or shorter than the original placeholder and causes visual misalignment, that's a deliberately
  accepted cost — it is not corrected automatically.

### Known and deliberately accepted cost

Substitution happens only on the **display path** (the moment `slidra serve` reads slide content to
show the frontend) — it is never written back into the `.svg` file itself. Opening this `.slidra` file
with other software (or just `cat`-ing the file) shows the literal `{{ slide_number }}`, not the
substituted number. This is a deliberate tradeoff: `{{ }}` is part of the slide file's content, not a
render snapshot; the `cat` command still returns the exact same original bytes (the byte-exact contract
is unchanged).
