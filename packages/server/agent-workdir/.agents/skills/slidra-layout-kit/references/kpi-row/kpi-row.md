# kpi-row

**Relationship solved**: `membership`
**Unit count**: 3–4
**One line**: A row of large numbers side by side, each with a one-line label — the first row of a dashboard.

**When to use it**: Several equally important metrics to view together. **Every number must be real.**
**When not to use it**: The metrics have causal or sequential relationships — use `flow` or `spine-path` instead.

## Wireframe

Full SVG: see `kpi-row.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Numbers ×N | `node` (`label`, `claim`–`number` size) | | 6 chars | 1 |
| Labels ×N | `label` (`caption`) | what the number represents | 10 chars | 1 |
| Divider | `garnish` | between numbers, optional | — | — |

## Rhythm

Numbers are **baseline-aligned** (not center-aligned) — when digit counts differ, baseline alignment looks correct. Evenly spaced; labels hug the number below.

Write `blueprint.shape` as `kpi-row`.

## Variants

- **Add delta**: a small ↑↓ and percentage change at each number's upper-right.
- **Two rows**: six metrics split into two rows of three columns.
