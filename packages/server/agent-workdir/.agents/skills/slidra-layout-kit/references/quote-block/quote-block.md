# quote-block

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A quotation occupies the page, source at the bottom — someone else's words become the whole of this page.

**When to use it**: A customer's exact words, user feedback, an authority's judgment. **The quotation must be real.**
**When not to use it**: Your own claim. Setting your own words as a quote looks self-indulgent.

## Wireframe

Full SVG: see `quote-block.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Quotation mark | `garnish` | a large quote mark as bare `<text>` | — | — |
| Quotation | `label` (`claim` or `title` size) | ≤ 3 lines | 20 chars/line | 1–3 |
| Short divider | `garnish` | | — | — |
| Source | `label` (`caption`) | name and role | 20 chars | 1 |

## Rhythm

The quotation is indented (left edge further right than the title), the source aligns with the quotation's left edge. **The quote mark is decoration**, not a text box.

Write `blueprint.shape` as `quote-block`.

## Variants

- **Centered version**: the quotation is horizontally centered, more formal.
- **With portrait**: a round portrait on the left, quotation on the right.
