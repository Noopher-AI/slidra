# chart-focus

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A chart occupies the main space with one conclusion beside it — the chart is the evidence, the conclusion is the claim.

**When to use it**: You have a data set and what you want to say is what it shows.
**When not to use it**: The data itself is the point and there is no conclusion — that is just pasting a table on a slide.

## Wireframe

Full SVG: see `chart-focus.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Chart | `node` (chart element) | | — | — |
| Conclusion | `label` (`subtitle`–`claim`) | **the real claim of this page** | 18 chars | 1–2 |
| Note | `label` | | 30 chars | 2–3 |
| Source | `label` (`caption`) | | 20 chars | 1 |

## Rhythm

The chart takes ~60% width, the conclusion column 30%, one `gutter` between. The conclusion's font size must be clearly larger than the chart's axis labels — **otherwise the reader reads the chart first and draws their own conclusion, defeating the page's purpose**.

Write `blueprint.shape` as `chart-focus`.

## Variants

- **Chart on top, conclusion below**: chart at full width, conclusion in a full-width row below — suits wide time-series charts.
- **Dual charts**: two small charts side by side, conclusion below.
