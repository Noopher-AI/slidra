## Multi-element addressing (the `element` command family)

`element insert / delete / move / scale / rotate / style set / order` is the only command family that
needs to handle "one or more target elements" at once. This document records how multiple targets are
represented on the CLI, and the multi-target semantics of each command, so an agent only has to learn
the rule once.

### Comma-separated syntax

Structured input (`CommandHandler`'s `input`, and the future `slidra serve`) is always a real array:

```ts
elementIds: string[] // length >= 1, no duplicate ids allowed
```

At the CLI argv layer, the "element identifier" positional argument becomes a **comma-separated list
with no whitespace**:

```bash
slidra element move <id> <slide-path> el-abc,el-def --dx 10 --dy -5
slidra element style set <id> <slide-path> el-abc fill "#c43e1c"
slidra element delete <id> <slide-path> el-abc,el-def,el-ghi
slidra element scale <id> <slide-path> el-abc --factor 2
slidra element rotate <id> <slide-path> el-abc,el-def --degrees 45
slidra element order <id> <slide-path> el-abc,el-def front
```

A single element is just a list of length 1 — the syntax is exactly the same (`el-abc` vs.
`el-abc,el-def` differ only in whether there's a comma). This is deliberate: an agent shouldn't need two
different syntaxes to memorize for "one target" versus "multiple targets."

**Why comma-separated instead of a repeated `--target` flag:** this CLI's existing argv convention is
"positional argument + flags for option values" (see `requirePositional` in `argv.ts`). The element id
list is conceptually still "the value of one positional argument," not an option. Comma-separation
preserves the existing positional argument count and order exactly, without having to change the
`requirePositional` interface to support a "repeatable positional argument."

Failing to find any one id fails the whole command (`element delete` is "delete all or delete none"; for
every other command, hitting the first nonexistent id fails the whole command, and targets already
written stay in their written state, because each command calls `writePresentationFile` exactly once
against the same `svgContent` — see "one operation = one undo step" below).

### Multi-target semantics per command

| Command | Multi-target semantics |
|---|---|
| `element insert` | No multi-target concept — it always creates a single new element and returns its new id. |
| `element delete` | Each id in the list is deleted independently; if an id is a group, its whole subtree is deleted along with it. If an id in the list happens to be a descendant of another list member, it's treated as already covered — no duplicate processing, no error. |
| `element move` | The same `(dx, dy)` pair is applied to each target's own container `transform` (each target's own `translateX`/`translateY` gets this delta added independently) — no combined bounding-box displacement is computed. |
| `element scale` | The same `factor` is applied to each target, each scaling independently around its own container's local origin (the point its `translate` sits at); groups apply the scale recursively to their descendants. See "Decision: relative deltas, applied independently" below. |
| `element resize` (a new command) | The same `(width, height, anchor)` triple is applied to each target, but **each target computes its own `(sx, sy)` independently** from its own current bounding box (not a shared scale ratio): each target is scaled to that same `width x height`, with its anchor corner (`nw`/`ne`/`sw`/`se`) staying fixed in place within its own parent coordinate system. Applies recursively to groups (descendant containers' `translateX`/`translateY` each multiplied by that target's own `(sx, sy)`). Targets containing `<text>`, `<circle>`, or `<path>` primitives only accept `sx === sy` (uniform scaling); non-uniform scaling is always rejected with an error suggesting `element scale` instead. |
| `element rotate` | The same `degrees` delta is applied to each target's `rotation`, leaving the rest of its transform components unchanged, independently per target. |
| `element style set` | The same property name/value is applied to every element in the list. |
| `element order` | `front`/`back`: each target in the list moves to the top/bottom within its own parent container; among multiple targets, the list's given order is preserved (for `front`, the last id in the list ends up stacked on top; for `back`, the last id ends up stacked on the bottom). `up`/`down`: processed one at a time in list order, re-querying sibling relationships after each one before processing the next (not a single upfront displacement calculation). Targets in different parent containers move within their own parent container independently, with no effect on each other. |

**One operation = one undo step:** this is an existing structural guarantee from `writePresentationFile`
/ `history.ts` (one dispatch call means one call to `writePresentationFile`) — no new logic needed.
`element-edit.ts` applies all target changes to the same `svgContent` in sequence and returns the
complete result once at the end; the seven wrapper functions in `workspace.ts` each call
`writePresentationFile` exactly once. It does not call it once per id in the list, which would split one
multi-target command into N undo steps.

### Decision: relative deltas, applied independently (not "treat the whole selection as one box")

The multi-target semantics of `element move` / `element scale` / `element rotate` are always "the same
relative delta, applied independently to each target's own container transform (or recursively to its
descendants)" — never a combined bounding box across multiple targets (never "treat the whole selection
as one box").

Three reasons, none of which is optional:

1. `geometry/bbox.ts#primitiveBounds` currently throws directly for `<text>` (font metrics are ready but
   not wired back in). Doing "treat the whole selection as one box" would require closing that gap
   first, which is a separate, larger piece of engineering than this command family — it doesn't belong
   at the edit-command layer.
2. "Apply the same relative delta independently" lets move/scale/rotate share one mental model (see the
   table above) — an agent only has to learn the rule once.
3. With a mixed selection (say, one large background rectangle plus one small text label), scaling by a
   shared bounding box would fling the label to a disproportionate position visually. Scaling each target
   independently avoids this surprising behavior.

**Known and accepted tradeoff:** "select a group of elements and scale them together as one box" (the
multi-select-scale intuition from PowerPoint/Figma) isn't achievable in this round. If an agent really
needs "these elements as one uniformly-scaled group," it must first group them with a future group
command, then run `element scale` on the group — `element scale` on a single group target already
behaves as "treat the whole thing as one box" (recursive scaling), so that path already works.

`element scale`'s recursive rule for groups: the group's own container `transform` doesn't change (it's
where the scale anchor sits, and it stays put); each direct child node's `translateX`/`translateY`
(extracted via `decomposeMatrix`) is multiplied by `factor`, `rotation` stays unchanged, and the result is
re-serialized with `formatTransform`; if a child is itself a group, recursion continues with the same
`factor` (it doesn't compound with depth); if a child is a leaf node, the scaling rule for its own kind
is applied to its native attributes.

### Cleaning up dangling effect entries (ADR-0009, a minimal schema specific to `element delete`)

After `element delete` removes an element, it also clears any effect entries pointing at the deleted id
(including group descendant ids). No existing command currently writes to the effect list — this is a
minimal placeholder schema, custom to this feature, that exists purely so the acceptance criterion
"clear dangling effect entries on delete" has something to test against:

```xml
<metadata>
  <slidra:effects xmlns:slidra="https://slidra.app/ns/2026">
    <slidra:effect target="el-abc" .../>
  </slidra:effects>
</metadata>
```

`element delete` removes any `<slidra:effect>` node whose `target` matches a deleted id. If a future
feature lands an "add effect" command and chooses a different schema, that feature's decision takes
precedence; this schema isn't a hard constraint, just a minimal viable placeholder.
