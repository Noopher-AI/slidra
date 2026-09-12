# A slide is self-contained

> A slide being self-contained is a **decision**, unaffected by formalizing the spec; the full attribute table, namespace, and container-specific exception structures for the `slidra:*` elements inside a slide's `<metadata>` (`<slidra:effects>`/`<slidra:notes>`/`<slidra:comments>`/`<slidra:transition>`) live in
> [`docs/spec/slidra-format.md`](../spec/slidra-format.md).

Everything a single slide needs — graphics, element identifiers, display names, its list of effects — is written into that slide's own SVG. `project.json` retains only what only makes sense across slides: `formatVersion`, `name`, `canvas`, and the `slides` order array.

What drives this decision is the action of **swapping two pages**. If the effect list lived in `project.json`, or if step numbers ran continuously across slides, reordering pages would mean editing a second file, or renumbering an entire stretch of steps. With a slide that's self-contained, swapping two pages is just swapping two strings in the `slides` array — not a single byte of either slide itself needs to change.

This is the same reasoning ADR-0003 used to reject putting shared styles in `project.json` (opening a single slide on its own would be missing colors, violating ADR-0001), extended verbatim to motion data: opening a single slide on its own shouldn't be missing its animation either.

## Consequences

- The effect list lives in that slide SVG's own `<metadata>`, not in `project.json`.
- Step numbering is scoped to a single page. Page 3's step 1 has nothing to do with page 5's step 1.
- "How many steps in the whole deck" doesn't exist in any single file — it's derived by the runtime scanning every slide. Progress indicators are computed, not stored — storing them would make them a cache, and caches drift out of sync.
- A slide can be copied into another presentation without losing its motion. That isn't a goal of this decision, but a side effect of it.
- Trade-off: an effect that only makes sense across slides (say, a transition sequence spanning the whole deck) has nowhere to live under this structure. If that's genuinely needed, that will be a new decision, not a reason to move the list back into `project.json`.
- Author comments pinned to the presentation (on an element, or on a whole page) also live in that slide SVG's `<metadata>`, as a `<slidra:comment>` list under `<slidra:comments>` — same location, same reasoning as `<slidra:effects>`. Comments travel with a page when it's duplicated (`slide duplicate`), with `target` re-pointed at the new element ids; `element delete` cleans up any comments pointing at a deleted element.
- Page enter/exit transitions likewise live in that slide SVG's `<metadata>`, as `<slidra:transition>`, replacing what used to be a single presentation-level transition living in `project.json` (the retired `transition` field) — a field that was never actually played, just stored. Now each page's own enter/exit effect and duration are what actually drive the transition animation between pages during playback. When pages are swapped or duplicated, the enter/exit settings travel with the slide itself, with no separate cross-file lookup table to move or remap.
