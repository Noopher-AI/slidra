# numbered-run

**Relationship solved**: `order`
**Unit count**: 3–4
**One line**: Big numbers lead, descriptions run horizontally beside them — the lightest sequence expression, no lines and no nodes.

**When to use it**: Few steps, one sentence per step, and no need to emphasize "the connection between them."
**When not to use it**: Steps have branches or feedback — that needs `flow` or `chain` connector lines.

## Wireframe

Full SVG: see `numbered-run.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Numbers ×N | `label` (faded large `number` size) | `01`… | 2 chars | 1 |
| Step name | `label` | | 12 chars | 1 |
| Supplement | `label` | optional | 18 chars | 1 |

## Rhythm

Numbers use the `number` size but the color is pushed down to `muted` — it is a rhythm marker, not the point. The step name is the point. Even horizontal spacing; three steps look best, four steps needs a smaller number size.

Write `blueprint.shape` as `numbered-run`.

## Variants

- **Vertical stack**: numbers on the left, descriptions on the right, top to bottom — use when there are more steps or longer descriptions.
- **Numbers as background**: scale numbers up to ~200 at opacity 0.08, text on top.
