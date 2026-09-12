# Every element is framed in a `<g transform>`

> **⚠️ Amended for charts: a chart container is not "one or more graphics primitives" but "one data element `<slidra:chart>` plus one rendered `<svg>`" — the first exception shape this ADR has had.**
>
> ```xml
> <g id="el-chart" data-slidra-type="chart" transform="translate(691.2 115.2)">
>   <slidra:chart xmlns:slidra="https://slidra.app/ns/2026"
>                type="bar" stacked="false" axes="single" palette="brand"
>                legend="bottom" grid="true" labels="true"
>                x-title="Week" y-title="ms" width="486.4" height="475.2">
>     <slidra:series name="TTFB (ms)" values="840,760,610,520,430,380" axis="left"/>
>     <slidra:categories values="W1,W2,W3,W4,W5,W6"/>
>   </slidra:chart>
>   <svg xmlns="http://www.w3.org/2000/svg" width="486.4" height="475.2" viewBox="0 0 486.4 475.2">…</svg>
> </g>
> ```
>
> - `data-slidra-type="chart"` (appended to `CONTAINER_ATTRIBUTES`) marks a container as using this exception shape;
>   `checkSlideCompliance` (in `packages/core/src/slide/format.ts`) replaces this ADR's original partition rule —
>   "a container must be entirely `<g>` or entirely valid graphics primitives" — with "must contain exactly one
>   `<slidra:chart>` plus one `<svg>`" whenever it sees this marker; a bare `<svg>` anywhere else is still an
>   `unknown-tag` and is unaffected.
> - `<slidra:chart>` is data, and `<svg>` is the rendered result — the same relationship as ADR-0009's
>   `<slidra:effects>` (data) and the visual effect at playback (derived): **the rendered result is only ever
>   produced by `renderChartSvg` in `packages/core/src/chart/render.ts`, redrawn on every `chart` command; no GUI
>   or other command ever touches it directly** — this is a new structural guard that follows directly from this
>   ADR's existing invariant that position is only written in one place (see Consequences below):
>   `element style set` always errors on a chart container, for the same reason as "`transform`/`x`/`y`/`width`/
>   `height` must not be written via the style command" below — the only correct path for writing
>   `<slidra:chart>` or the embedded `<svg>` is the `chart` command family; bypassing it desynchronizes the two.
>   `element scale`/`element resize` are an explicit exception carved into this path: they don't touch the
>   container's transform scale at all, but instead multiply `<slidra:chart>`'s `width`/`height` by the ratio and
>   **redraw** it (`scaleChartElement` in `chart/edit.ts`), so the data element and the rendered result stay in
>   sync and text doesn't get stretched out of shape.
> - `<slidra:chart>` contributes nothing to `getBBox()`/`primitiveBounds`; only the embedded `<svg>` contributes a
>   bounding box (treated the same as `rect`/`image`: `x`/`y` default to 0, `width`/`height` are required) — so a
>   chart can be moved, grouped, targeted by the effect list, and scaled/resized like any other element (uniformly
>   or non-uniformly — see above: it's always redrawn at the new size either way).
> - The embedded `<svg>` is the same bytes as "a chart SVG opened on its own": it carries `xmlns`/`width`/`height`/
>   `viewBox`, and no `x`/`y` (position is only ever written on the container's `transform`, entirely consistent
>   with this ADR's existing rule — it's just that "a graphics primitive" is joined by a new shape: "a whole
>   rendered result that is itself a valid standalone SVG document").
>
> **What hasn't changed**: a container still has exactly one level, position and rotation are still only written
> on the container's `transform`, and the principle that "the slide format is therefore stricter, and non-compliant
> SVG cannot be operated on by editing commands" is unchanged — only the compliance test for a chart container is
> now "two specific child elements" rather than "one or more graphics primitives."
>
> **This ADR also gets an additional container variant for tables.** Everything below is otherwise unchanged — this
> only adds the `data-slidra-type="table"` container shape, described at the end in "Table containers."

Editing requires four things: move, scale, rotate, group. Existing slide SVGs used bare graphics primitives — `<text x y font-size>`, `<rect x y width height>` — with each shape kind expressing position its own way, and **nowhere to write "how many degrees this is rotated,"** because nobody had needed that before.

So the canonical form for an element becomes: a `<g>` container wrapping one or more graphics primitives, with **position and rotation always written on the container's `transform`**, while size still uses each primitive's native attributes.

```xml
<g id="el-title" data-slidra-name="Title" transform="translate(640 330) rotate(-15)">
  <text text-anchor="middle" font-size="86">Sample Deck</text>
</g>
```

The decisive reason is that **this is the only mechanism that solves all four requirements at once, entirely with native SVG.** Moving is changing two numbers in `translate`; rotating is one angle in `rotate`; grouping is a `<g>` wrapping a `<g>` — moving a twelve-element group only touches the outermost container, without changing a single byte underneath. And `<g>` and `transform` have been core SVG 1.1 syntax since the beginning; any browser, vector tool, or image viewer renders it correctly, **rotation included**. ADR-0001's static compatibility isn't just preserved here — it's the main reason this option was chosen.

## Considered Options

- **Explicit bounding boxes** (each element carries `data-slidra-box="x y w h"` and a rotation angle, and the primitive is drawn to fit the box): easiest to compute scaling and alignment from, and closest to the PowerPoint mental model. But it stores the same fact twice — once in the box, once in the primitive's native attributes — and the two must always agree; when they don't, nothing errors, the visuals just drift. Worse, rotation would become a custom attribute that other software ignores entirely, so a title rotated 15 degrees inside the app would render upright in any external preview tool. That directly violates ADR-0001.
- **No container, commands modify native attributes directly**: cleanest SVG, lowest token cost, no conversion needed for existing demo content. But rotation has nowhere to go, moving a group means rewriting every child element's coordinates, and every shape kind needs its own move logic. Its "renders correctly when opened elsewhere" comes at the cost of giving up capability.

## Consequences

- **Every element gets an extra wrapping tag.** ADR-0004 states plainly that "SVG file size directly equals the token cost of every conversation turn," so this is a real cost, not fussiness. What it buys is four capabilities and one unified vocabulary for operating on them.
- **Absolute position must be computed.** Containers can nest, so "where this element actually is on screen" is a chain of multiplications. Alignment commands must therefore compute each element's bounding box first; that math lives in the shared core library, used by both the CLI and the frontend — the two sides must produce identical results, or something will visibly jump the instant the mouse is released.
- **`transform`, `x`, `y`, `width`, `height` must not be written via the style command** (see ADR-0014). Position is written in exactly one place, and that invariant needs a structural guard, not discipline.
- **The slide format is therefore stricter**: non-compliant SVG cannot be operated on by editing commands — a command errors and points out what's wrong. A separate, user-initiated conversion command normalizes SVG into a compliant slide. Nothing is auto-fixed silently — that would be silently rewriting the user's file.
- **Any `path` can be brought in almost for free**: moving, scaling, and rotating all come from the container; the only thing that can't be done is editing its nodes. People don't hand-edit Bézier curves — to change the shape, ask an agent to redraw it.
- Any existing demo content or hand-written slide needs to run through the conversion command once.

## Table containers

Tables are the second exception (after charts) to this ADR's "one container wraps one or more graphics primitives" rule: a `data-slidra-type="table"` container wraps an optional `<slidra:source>` (a data-binding declaration) plus multiple `<g data-slidra-cell="r,c">` elements:

```xml
<g id="el-tbl1" data-slidra-type="table"
   data-slidra-cols="200 300 240" data-slidra-rows="44 40 40"
   data-slidra-header="1" data-slidra-theme="dark"
   transform="translate(120 160)">
  <slidra:source xmlns:slidra="https://slidra.app/ns/2026" src="assets/data/sales.csv"/>
  <g data-slidra-cell="0,0" transform="translate(0 0)">
    <rect x="0" y="0" width="200" height="44" fill="#ffffff" fill-opacity="0.06"/>
    <text x="12" y="30" font-size="16" font-weight="700" fill="#a9b0b8" xml:space="preserve">
      <tspan x="12" y="30">Metric</tspan>
    </text>
  </g>
  …
</g>
```

Fixed rules:

- **A cell container never has an `id`** — cells are always addressed via `data-slidra-cell="r,c"` (0-based, row, column); a table cell is therefore never an independently selectable element, and `element move`/`element style set` and the like always act on the whole table container, never descending into a single cell.
- A cell's position is written on its own `transform="translate(x y)"`; its graphics primitives (`<rect>`/`<text>`) never carry a `transform` — consistent with this ADR's core rule.
- `data-slidra-cols`/`data-slidra-rows` are computed by the core library and written back; users cannot set row height directly (column width can be set via `table col width`; with `--keep-total`, the neighboring column absorbs the difference and the table's total width stays the same — this is what the GUI's column-border drag uses under the hood).
- A table's bounding box is `(0,0)` to `(Σcols, Σrows)` transformed by the container's `transform`, not the union of its child primitives (the table branch of the bounding-box geometry code) — because cells have no `id` and aren't independently measurable "elements."
- A table can be **grouped** like any other element (cell addressing is relative to the table container's own id, unaffected by what level the container sits at); `element ungroup` always errors on a table container, since a table isn't a group and its cells aren't independently selectable members.
- `element scale`/`element resize` on a table **only changes the container transform's `scale()`**; column widths, row heights, and cell content aren't touched at all — a table scales as a whole, like an image (text included, same as PowerPoint), and any subsequent `table` command preserves that scale as-is. Since text scales with the container, only uniform scaling is accepted: `element resize` errors when `sx ≠ sy` (same rule as text boxes), and the GUI always takes the uniform-scale path for tables. This is an explicit exception to this ADR's "size uses each primitive's native attributes" rule, because a table's size was never on a primitive to begin with — it's in `data-slidra-cols`/`data-slidra-rows`, values the core library computes from content, and that can't be overridden by a scale factor.
- When data binding doesn't specify `--template-row`, the default template row is **the first non-header row containing a `{{ column-name }}` placeholder**; only falls back to the last row when no row has a placeholder at all.
- Data binding's expansion (CSV → concrete cells) only happens via the `table bind`/`table refresh` commands, never at display time — consistent with the chart posture of "the GUI never touches the rendered result directly"; here it's "display never mutates file content."
