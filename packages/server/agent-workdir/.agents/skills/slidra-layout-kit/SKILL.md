---
name: slidra-layout-kit
description: Pick one of 55 layouts for a page; each ships a wireframe SVG, per-slot character budgets and role markers, and declares which content relationship it solves; also the catalog slidra-build uses when choosing a layout page by page. Use when the author's message starts with /slidra-layout-kit or asks to "lay this out" or "change the layout"
---

# Layout library

A layout answers: **what is the relationship between this page's content, and what geometry should carry it**. Every layout declares which `relationship` it solves, and spells out how many characters each slot holds and which role marker to use.

**The catalog is a starting point, not a whitelist.** You may change column counts, change proportions, mix two, or compose your own — when you compose one, give `blueprint.shape` a descriptive name.

## Input

```
/slidra-layout-kit three parallel points
/slidra-layout-kit image left, text right 3
/slidra-layout-kit                  ← pick yourself from this page's relationship
```

- Free text is the matching basis: column count, image/text relationship, sense of direction, reference targets.
- A trailing page number constrains which page to lay out; when none is given, ask the author which page.
- **This page's `relationship` outranks the author's description**: when the description says "three columns" but the relationship is `order`, pick a solution with direction and explain why in the report; if the author insists, follow them.

## Steps

1. **Read the relationship**: `slidra cat <presentation-id> plan/outline.md`, take this page's `relationship`. Without a plan, judge it from the content yourself (section 6.1 of `reference/slide-design.md`).
2. **Read the style**: `slidra cat <presentation-id> plan/design-spec.md`, take the palette, type scale table and `layout` anchors. Layout coordinates are always derived from the anchors and multiplied by `k`; the illustrative numbers in the files were computed for a 1280×720 with `side_margin: 80`.
3. **See what the previous page used**: when two adjacent pages share a relationship, a different layout is required (`rhythm.repeated-shape`).
4. **Read the index**, pick one, and read only that one file: `references/<name>/<name>.md`.
5. **Fit the slots**: put content into the slot table; over the character budget, shorten or reduce units; when it doesn't fit, reduce units or split the page — don't change font sizes.
6. **Write the page**: write the full-page SVG per the skeleton (`slide add --svg` or `slide set --svg`), marking `data-slidra-role` on every semantic unit. The wireframe's **proportions may be copied** (it is drawn with real font sizes, content filling the safe area y 176–616); do **not** copy the wireframe's colors or text — colors always come from the `design-spec` palette roles, placeholder text like "image" or "node 1" gets replaced with this page's real content, and gray and `#CCCCCC` borders do not go into slides. Background-type decoration (big circles, glows, grid lines) belongs to the background image; layouts don't carry it.
7. **Write back the blueprint**: fill `shape` with this layout's name, `nodes`/`steps` with the actual values.
8. **Check**: `slidra validate <presentation-id> slides/00N.svg` must reach 0 errors.

## The 55 layouts

**Look at the relationship first, then the name.** The index is grouped by relationship — this page's `relationship` decides which group to look in; the author's description only helps you choose within the group.

### `membership` (parallel/belonging)

| # | Name | One line | Unit count |
|---|---|---|---|
| 01 | `card-wall` | Equal-height horizontal cards stacked vertically, the most neutral parallel layout | 3–5 |
| 04 | `shared-field` | Everything in one shared field, separated by dividers | 3–6 |
| 05 | `banded-list` | Single-column horizontal bands, alternating base color | 3–5 |
| 06 | `chip-cluster` | Varying-size tags scattered into a cluster | 5–12 |
| 22 | `image-left` | Full-height image on the left half, text on the right half | 1 + 2–4 |
| 24 | `image-grid` | Grid of equal image cells, each with a one-line caption | 3–6 |
| 26 | `kpi-row` | A row of big numbers side by side, each with one label | 3–4 |
| 30 | `split-thirds` | Three equal-width vertical columns, each holding multiple lines | 3 |
| 49 | `infographic` | Parallel vertical columns, each with one icon and a minimal label | 2–5 |
| 50 | `map` | Geographic outline with marker points and a legend | 2–6 |
| 34 | `image-mosaic` | A hero image plus a mosaic of smaller ones, with hierarchy | 4–7 |
| 40 | `chart-small-multiples` | The same chart type repeated in several cells, shapes comparable | 4–9 |
| 43 | `table-full` | One table filling the content area, for looking things up | 1 table |
| 45 | `spec-sheet` | Image left, spec table right — the standard product-page solution | 1 image + 4–8 |
| 37 | `video-grid` | Several short clips side by side, each with a one-line caption | 2–4 |

### `order` (sequence)

| # | Name | One line | Unit count |
|---|---|---|---|
| 03 | `spine-path` | A main axis strings the nodes together; direction and endpoints are visible | 3–5 |
| 07 | `numbered-run` | Big numbers lead, descriptions run horizontally beside them | 3–4 |
| 08 | `stepped` | Color blocks rising step by step; height is the message | 3–5 |
| 29 | `timeline-vertical` | Vertical main axis, nodes on the axis, descriptions to the right | 4–7 |
| 46 | `cycle` | A closed loop, the arrow returns to the start | 3–6 |
| 47 | `funnel` | Wide at top, narrow at bottom; width is the quantity | 3–5 |

### `contrast` (comparison)

| # | Name | One line | Unit count |
|---|---|---|---|
| 02 | `split-panel` | Equal-width left/right panels sharing a baseline | 2 |
| 17 | `before-after` | Two blocks top and bottom, one dividing line between | 2 |
| 18 | `shared-axis` | A central reference axis, both sides expanding outward | 2 |
| 28 | `matrix-2x2` | Two axes cutting out four quadrants | 4 |
| 33 | `image-pair-compare` | Two images side by side, one dividing line between | 2 |
| 38 | `chart-pair` | Two charts side by side sharing the same scale | 2 |
| 44 | `table-highlight` | Highlight one column in a table and explain why | 1 table + 1 |

### `parent` (governance/decomposition)

| # | Name | One line | Unit count |
|---|---|---|---|
| 12 | `indent-tree` | An indented hierarchical list | 1 + 3–6 |
| 13 | `nested-field` | Small fields nested inside a large field | 1 + 2–4 |
| 14 | `scale-drop` | Sizes shrink level by level; size is hierarchy | 3–4 |
| 48 | `pyramid` | Wide-at-bottom, narrow-at-top hierarchical stacking | 3–5 |

### `link` (dependency/cause)

| # | Name | One line | Unit count |
|---|---|---|---|
| 09 | `chain` | Nodes linked in sequence with arrows, emphasizing causality | 3–5 |
| 10 | `hub` | One in the center, the rest radiating back to it | 1 + 3–6 |
| 11 | `flow` | Source → transformation → result, largest in the middle | 3–5 |

### `overlap` (intersection)

| # | Name | One line | Unit count |
|---|---|---|---|
| 15 | `venn` | Overlapping circles, the intersection marked | 2–3 |
| 16 | `layered` | Offset stacked blocks, the shared zone on top | 2–4 |

### `none` (single claim)

| # | Name | One line | Unit count |
|---|---|---|---|
| 19 | `hero-number` | One big number centered, a one-line explanation below | 1 |
| 20 | `claim-field` | One sentence fills the layout, the rest is whitespace | 1 |
| 21 | `cover-stack` | Title, subtitle, date stacked top-down, flush left | 1 |
| 23 | `image-full-bleed` | One image for the whole page, text on a scrim | 1 |
| 25 | `quote-block` | A quotation occupies the layout, source at the bottom | 1 |
| 27 | `chart-focus` | A chart takes the main space, one conclusion beside it | 1 |
| 31 | `media-stage` | A video or audio at the center of the stage, an explanation above of what to watch | 1 |
| 32 | `image-caption-strip` | A big image with a caption strip below | 1 |
| 35 | `image-overlay-card` | A text card over a full-bleed image | 1 |
| 36 | `video-side-notes` | Video on the left, viewing points on the right | 1 + 2–4 |
| 39 | `chart-annotated` | A chart with callout lines pointing to what to look at | 1 |
| 41 | `audio-waveform` | A waveform strip with per-word highlights | 1 |
| 42 | `audio-quote` | A quotation with a thin playable waveform | 1 |

### Portrait and square canvases

These five are **not 16:9**; each carries its own canvas size. When you pick one, set the canvas first with `presentation canvas set`, and take font sizes directly from the file's slot table without the `k` conversion — that rule only holds for proportional canvases.

| # | Name | Canvas | One line |
|---|---|---|---|
| 51 | `vertical-stack` | 1080×1920 | Claim on top, image in the middle, key points at the bottom; one phone screen |
| 52 | `vertical-list` | 1242×1660 | A vertical numbered list, a scrollable knowledge post |
| 53 | `vertical-cover` | 1080×1920 | A portrait cover: full-bleed image on top, title below |
| 54 | `square-quote` | 1080×1080 | A square quote, the single sheet most likely to be shared |
| 55 | `square-kpi` | 1080×1080 | A square number card |

### Find a layout by material

**Material layouts (22–27, 31–45) all require real material**: `image-*` needs an imported image, `video-*`/`media-stage` need a video (`element insert video --media assets/<filename>`, external platforms use `--embed`), `audio-*` needs an audio file, `chart-*` needs a data set, `table-*`/`spec-sheet` need column content, `quote-block`/`audio-quote` need a real quotation, and the numbers in `kpi-row`/`hero-number` may only come from the author. When the material doesn't exist, use a layout that doesn't need it, and swap it back with `slide set --svg` once the material arrives — gray placeholder boxes and made-up numbers are not a layout.

| What you have | Usable layouts |
|---|---|
| One image | 22 `image-left`, 23 `image-full-bleed`, 32 `image-caption-strip`, 35 `image-overlay-card` |
| Several images | 24 `image-grid` (equal weight), 34 `image-mosaic` (with hierarchy), 33 `image-pair-compare` (two to compare) |
| One video | 31 `media-stage` (just play), 36 `video-side-notes` (play while narrating) |
| Several short clips | 37 `video-grid` |
| One audio file | 41 `audio-waveform` (has highlights to align), 42 `audio-quote` (one quoted line) |
| One data set | 27 `chart-focus`, 39 `chart-annotated` (has key points), 26 `kpi-row` (a few metrics) |
| Two data sets | 38 `chart-pair` |
| Several same-shape data sets | 40 `chart-small-multiples` |
| One table | 43 `table-full`, 44 `table-highlight` (you want to recommend one column) |
| Product image + specs | 45 `spec-sheet` |
| Cycle, funnel, pyramid, geographic distribution | 46 `cycle`, 47 `funnel`, 48 `pyramid`, 50 `map` |

## Report format

First line: "Page N: <layout name> (solves <relationship>) — <one sentence>, <unit count> units, <step count> steps". Then one line per slot: slot name, what was placed, how many characters (flag any over budget). The final line lists two alternate layouts.
