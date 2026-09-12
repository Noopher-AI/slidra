## Multi-element addressing (the `element` command family)

`element insert / delete / move / scale / resize / rotate / style set / order / group / align /
distribute` is the command family that needs to handle "one or more target elements" at once (`insert`
and `group`/`align`/`distribute` have their own single-target or minimum-count rules — see
`.dev_docs/spec/cli.md` for the exact requirement per command). This document records the addressing
convention and the design rationale behind it; the normative, per-command behavior (error cases, minimum
target counts, exact multi-target semantics) lives in `.dev_docs/spec/cli.md` — this document does not
duplicate it and should not be read as an alternative source of truth.

### Comma-separated syntax

The "element identifier" positional argument (`<element-ids>`) is always a **comma-separated list with
no whitespace, with no duplicate ids allowed**:

```bash
slidra element move <id> <slide-path> el-abc,el-def --dx 10 --dy -5
slidra element style set <id> <slide-path> el-abc fill '#c43e1c'
slidra element delete <id> <slide-path> el-abc,el-def,el-ghi
slidra element scale <id> <slide-path> el-abc --factor 2
slidra element rotate <id> <slide-path> el-abc,el-def --degrees 45
slidra element order <id> <slide-path> el-abc,el-def front
```

A single element is just a list of length 1 — the syntax is exactly the same (`el-abc` vs.
`el-abc,el-def` differ only in whether there's a comma). This is deliberate: an agent shouldn't need two
different syntaxes to memorize for "one target" versus "multiple targets."

**Why comma-separated instead of a repeated flag:** the CLI's argv convention is "positional argument +
flags for option values." The element id list is conceptually still "the value of one positional
argument," not an option, so comma-separation preserves the existing positional argument count and order
exactly, without needing a "repeatable positional argument" concept in the argv parser.

Failing to find any one id fails the whole command (for a command touching multiple targets, hitting the
first nonexistent id fails the whole command — see "one operation = one undo step" below for why targets
already written are not left half-applied).

### Multi-target semantics per command

| Command | Multi-target semantics |
|---|---|
| `element insert` | No multi-target concept — it always creates a single new element and returns its new id. |
| `element delete` | Each id in the list is deleted independently; if an id is a group, its whole subtree is deleted along with it. If an id in the list happens to be a descendant of another list member, it's treated as already covered — no duplicate processing, no error. |
| `element move` | The same `(dx, dy)` pair is applied to each target's own container `transform` (each target's own `translateX`/`translateY` gets this delta added independently) — no combined bounding-box displacement is computed. |
| `element scale` | The same `factor` is applied to each target, each scaling independently around its own container's local origin (the point its `translate` sits at); groups apply the scale recursively to their descendants. See "Decision: relative deltas, applied independently" below. |
| `element resize` | The same `(width, height, anchor)` triple is applied to each target, but **each target computes its own `(sx, sy)` independently** from its own current bounding box (not a shared scale ratio): each target is scaled to that same `width x height`, with its anchor corner (`nw`/`ne`/`sw`/`se`) staying fixed in place within its own parent coordinate system. Applies recursively to groups (descendant containers' `translateX`/`translateY` each multiplied by that target's own `(sx, sy)`). Targets containing `<text>`, `<circle>`, or `<path>` primitives only accept `sx === sy` (uniform scaling); non-uniform scaling is always rejected with an error suggesting `element scale` instead. |
| `element rotate` | The same `degrees` delta is applied to each target's `rotation`, leaving the rest of its transform components unchanged, independently per target. |
| `element style set` | The same property name/value is applied to every element in the list. |
| `element order` | `front`/`back`: each target in the list moves to the top/bottom within its own parent container; among multiple targets, the list's given order is preserved (for `front`, the last id in the list ends up stacked on top; for `back`, the last id ends up stacked on the bottom). `up`/`down`: processed one at a time in list order, re-querying sibling relationships after each one before processing the next (not a single upfront displacement calculation). Targets in different parent containers move within their own parent container independently, with no effect on each other. |
| `element group` / `align` / `distribute` | Not "move one target at a time" — these read the whole list's combined bounding box (or, for `group`, wrap the whole list) as a single operation. All targets must be in the same container layer; `align`/`group` require at least two targets, `distribute` requires at least three. See `.dev_docs/spec/cli.md` for the exact rule per command. |

**One operation = one undo step:** every element command writes the modified slide file exactly once per
invocation, regardless of how many ids are in the list — it never writes once per id, which would split
one multi-target command into N undo steps. This is a structural guarantee of the Rust command layer
(`crates/slidra/src/element/`), not something each command has to re-implement.

### Decision: relative deltas, applied independently (not "treat the whole selection as one box")

The multi-target semantics of `element move` / `element scale` / `element rotate` are always "the same
relative delta, applied independently to each target's own container transform (or recursively to its
descendants)" — never a combined bounding box across multiple targets (never "treat the whole selection
as one box").

Two reasons, none of which is optional:

1. "Apply the same relative delta independently" lets `move`/`scale`/`rotate` share one mental model (see
   the table above) — an agent only has to learn the rule once, instead of a different one for "single
   target" versus "multiple targets."
2. With a mixed selection (say, one large background rectangle plus one small text label), scaling by a
   shared bounding box would fling the label to a disproportionate position visually. Scaling each target
   independently avoids this surprising behavior.

If an agent needs "these elements as one uniformly-scaled group," `element group` groups them first, then
`element scale` on the resulting group id already behaves as "treat the whole thing as one box" (it
recurses into every descendant container's offset and primitive geometry — see `.dev_docs/spec/cli.md`'s
`element scale` entry for the exact recursive rule).

### Cleaning up dangling effect entries on `element delete` (ADR-0009)

After `element delete` removes an element, it also clears any `<slidra:effect>` (and `<slidra:comment>`)
entries pointing at the removed id, including group descendant ids — silently, with no count reported in
`data` (`element delete`'s success `data` is `{}`; see `crates/slidra/src/element/edit.rs`,
`find_dangling_effect_ranges`). `element group`/`element ungroup` report the same kind of cleanup
explicitly, as the `removedEffects` count in their success `data` — see `.dev_docs/spec/cli.md`. The
effect schema itself (`<slidra:effect target="…" .../>` inside a slide's `<metadata>`) is documented in
`.dev_docs/spec/slidra-format.md`.
