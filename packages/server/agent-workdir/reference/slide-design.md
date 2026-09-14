# SVG Authoring Guide

This document is the basis for the agent to **write one SVG per slide**: the stage skeleton, the type scale table, color roles, element roles, a syntax walkthrough, the animation script, relationship and density rules, and finally acceptance via `slidra validate`. `slidra-plan` uses sections 6 and 7 to write the plan; `slidra-build` and `slidra-new-slide` use sections 0–5 to build pages. When the presentation already has templates or designed pages, **follow what exists — do not overwrite it with this guide**.

The three asset kits each own a piece: color and type-scale tables live in `slidra-style-kit`, background recipes in `slidra-background-kit`, layouts and slots in `slidra-layout-kit`. This guide only writes down the rules they share.

All numbers are based on a **1280×720** canvas (the default of `slidra new`).

**Proportional canvases (16:9)**: first `cat project.json` to read `canvas.width`, compute `k = width ÷ 1280`, and multiply every coordinate, width, radius, and font size by k (1920×1080 is ×1.5); write the `viewBox` as the canvas size.

**Non-proportional canvases** (portrait, square, A4): **`k` does not apply**. These canvases use the layouts drawn specifically for them in the layout kit (51–55); use the slot tables in those files directly for font sizes — portrait content is usually read up close on a phone, so type should be larger than 16:9.

| Canvas | Size | Use |
|---|---|---|
| 16:9 | 1280×720 (or 1920×1080) | Presentations, meetings, screens |
| 4:3 | 1024×768 | Legacy projectors, academic settings |
| 3:4 | 1242×1660 | Illustrated knowledge posts |
| 1:1 | 1080×1080 | Square posts, quote cards |
| 9:16 | 1080×1920 | Stories, short-video covers |
| A4 | 1240×1754 | Printed posters, single documents |

Set the canvas with `slidra presentation canvas set <id> --width <w> --height <h>`, and do so **before creating the first page**.

## 0. How to write one SVG page into the presentation

- New page: `slidra slide add <presentation-id> --svg '<full-page SVG>'`; to insert after page n, add `--at n`. Full-page overwrite: `slidra slide set <presentation-id> slides/00N.svg --svg '<full-page SVG>'`.
- **Quoting rules**: wrap the entire SVG in single quotes; **only double quotes** may be used as attribute quotes inside; the whole block **must not contain any single quote** `'` (the command line can't type one in); write `&` in text as `&amp;`, and `<` as `&lt;`.
- On write, Slidra will: check that the root node is `<svg>`, add or verify the `viewBox`; wrap bare primitives into `<g>`, add ids, and lift `transform` up to the container; reject `<script>`/`<foreignObject>`; convert **text-box declarations** into real text boxes (next section). `<defs>`, gradients, filters, clipPath, and `path` are all allowed.
- On success it returns `data.elementIds` (all element ids in document order). **Assign your own ids** (`el-<semantic>`, unique within a page) so the animation script lines up; `data-slidra-name` is for humans, use it as given.
- The page background color is not written in the SVG; after writing, run `slidra slide style set <presentation-id> slides/00N.svg --background <the role color assigned to this page>`.

### Write gate: run this pass yourself before submitting

`slide add --svg`/`slide set --svg` **validate this page first; if it fails, the whole page is rejected** (the response lists every rule that failed, and nothing is written). What it blocks are things that "can only be fixed by rewriting the whole page" — rather than let it write it in and then rewrite the whole page later, get it right now. **This is not the author pressing reject**; it's that this page hasn't met the bar yet.

Check the following in your head before submitting:

1. **Will text boxes collide**: text-box height = lines × 1.45 × font size, and `y + height` is the bottom. **Estimate the line count yourself** — divide width by font size to estimate how many characters fit on a line; a CJK character is about one font-size wide, a Latin/digit about 0.5×. The next text box's `y` must be greater than the previous one's bottom. (The most common mistake this time: assuming a title is one line when it actually wraps to two, squashing the subtitle.)
2. **Will it go out of bounds**: text box right edge `x + width` ≤ 1200 (×k), bottom ≤ 648 (×k); the two 18-level footer exceptions may reach 700 (×k).
3. **Font size and color**: font size can only be a value from the type-scale table; text color is only text/muted (big numbers and bold labels may be accent, closing pages may be background); shape fills use only color roles, `none`, or `url(#…)`.
4. **One title per page**: only one text box uses the title-level font size.
5. **Text volume**: title length, each bullet's length and count, and total characters per page are all in the table in section 7.
6. **Roles must be self-consistent**: a page whose `relationship` is not `none` needs at least one `node`; a `label` must have an owner, a `spine` is one per page, an `edge` must connect to a node on both ends, and `garnish` carries no meaning (section 3b).
7. **Images must resolve**: write `href` as `../assets/<filename>`; get the filename from the return of `ls <presentation-id> assets` or `asset import`; if the asset doesn't exist, import it first.
8. **When there is a background image**: every text box (except the footer and big text ≥ claim) must sit on a scrim panel (section 4b).

**Not blocked here**, things you can add with a follow-up command after writing: transitions and enter effects, page background color, background image, notes, template registration, `blueprint`. If these are missing, `validate` will report it, but it doesn't affect whether this page writes in.

### Text-box declaration

**All text that will be read** is written with a text-box declaration, so it auto-wraps, can have lists, can be edited in place, and is checked by `validate`:

```xml
<text id="el-bullets" data-slidra-name="Bullets" data-slidra-text-width="1120" x="80" y="176"
      font-size="24" font-weight="400" fill="<text>"
      data-slidra-text-align="left" data-slidra-list="bullet bullet bullet">First item
Second item
Third item</text>
```

- `x`/`y` is the text box's **top-left corner** (not the baseline). Text-box height = lines × 1.45 × font size; use this to place vertically.
- Content is separated by newlines, one bullet per line; `data-slidra-list` has one token per line (`bullet`/`number`/`none`).
- `font-family` may only be a family already embedded in the presentation (`Noto Sans TC` is built in; others import per `reference/fonts.md`); font weight is only 400 and 700; `data-slidra-text-align` ∈ left/center/right.
- Content may only be plain text; `<tspan>` is produced by Slidra itself.
- A bare `<text>` without `data-slidra-text-width` has exactly one use: the watermark big text on a section page. That is decoration, not content — and it must be marked `data-slidra-role="garnish"` to declare it's decorative, or the write is rejected (any unmarked bare `<text>` is treated as "text dropped out of a text box").

## 1. Stage skeleton

Fixed elements shared by every page; **content pages** (section pages, bullet pages, comparison pages, big-number pages) all include them, **cover and closing pages do not include the footer**:

| Element | How to write |
|---|---|
| Footer rule | `<line id="el-footer-rule" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>` |
| Footer presentation name (bottom-left) | Text-box declaration x=80 y=668 w=600 size 18 muted, content `{{ presentation_name }}` |
| Page number (bottom-right) | Text-box declaration x=800 y=668 w=400 size 18 muted right-aligned, content `{{ slide_number }} / {{ slide_total }}` (width must fit the template string itself; wrapping is computed on the literal) |

**Decorative geometry (big circles, glows, color blobs, beams, diagonals, grid lines, light dots) all lives in the background image asset**; the page SVG only holds content elements, scrims, and the footer. Only when the plan's `background: off` do you put the stage big circle `<ellipse id="el-orb" cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>` into a content page's SVG (not on section or big-number pages).

- Content area is x 80–1200, y 72–648; title top is fixed at y=72, left edge fixed at x=80, the whole deck doesn't drift. These bounds come from `design-spec.layout` (`side_margin` / `bottom_margin` / `footer_margin`); `validate` checks overflow against them. All spacing within a page comes from the `layout.gutter` and `layout.spacing` steps.
- Decorative geometry (circles, lines, paths) **may extend beyond the canvas**; this is deliberate bleed. Text boxes may not.
- `{{ … }}` is dynamic text, substituted with real values at display time; what `cat` reads back is the literal.

## 2. Type scale

A presentation uses only one size per role; the same role must not vary in size across different pages. The actual numeric values of the scale come from `type_scale` in `plan/design-spec.md` (supplied by `slidra-style-kit`'s style file); the table below is the **meaning of the roles**:

| Role (type_scale key) | Default | Weight | Color | Used for |
|---|---|---|---|---|
| Cover title (`cover`) | 72 | 700 | text | Cover, ≤ 2 lines, ≤ 15 chars per line |
| Section name (`section`) | 56 | 700 | text | Section pages |
| Big number (`number`) | 140 | 700 | accent | The number on a big-number page |
| Big claim (`claim`) | 48 | 700 | text; closing pages use background | The one-liner on a big-number page, the conclusion on a closing page |
| Page title (`title`) | 40 | 700 | text | Bullet pages, comparison pages |
| Subtitle/column label/card number (`subtitle`) | 28 | 400 (subtitle) / 700 (column label, card number, section number) | muted (subtitle) / text (column label) / accent (number) | Cover subtitle, comparison-page column labels, bullet-page card numbers, big-number-page caption |
| Body (`body`) | 24 | 400 | text | Bullet-page keywords, closing-page next steps |
| Column body (`column`) | 22 | 400; closing sublabel 700 | text; closing sublabel accent | Comparison-page two-column body, closing-page sublabels |
| Label/source/footer (`caption`) | 18 | 400 | muted | Cover date/speaker, data source, footer |

## 3. Color roles

Each presentation uses **only one set** of the seven role colors, from `palette` in `plan/design-spec.md` (chosen by `slidra-style-kit`); if the author specifies colors, follow the author. The `<role>` in the SVG examples must be replaced with that set's color codes before writing.

| Role | Used for |
|---|---|
| background | Page base color; closing-page text color |
| secondary_bg | Section-page base, cards and panels, VS circle |
| primary | Skeleton color bar, left-column top line, closing-page full-bleed background, large areas of the background image |
| accent | Big numbers, short bars and underlines, card numbers, section numbers, closing sublabels and blocks |
| secondary_accent | Comparison-page right-column top line; the background image gives it only lines and small areas |
| text | Primary text |
| muted | Subtitles, sources, footer, section watermark |

- Text color uses only text and muted; exceptions: big numbers and bold labels (card numbers, section numbers, closing sublabels, VS) use accent, and all closing-page text uses background. Body and subtitle in accent fail the contrast check; `validate` will block it.
- Shape and line colors use only primary/accent/secondary_accent/secondary_bg/background; translucency via `opacity`.

## 3b. Element roles: what each element exists for

Coordinates may be adjusted to fit content, but **the role each element plays must not be ambiguous**. Declare `data-slidra-role` on elements, and `validate` can check whether the page's structure holds without regard to coordinates.

| Role | Meaning | Typical elements |
|---|---|---|
| `field` | The region where the relationship happens | Card base, column panel, color band |
| `node` | A single semantic unit | Each card, each column of a comparison, each station of a flow |
| `spine` | This page's reading axis | Section page's skeleton color bar, a timeline's main line |
| `edge` | A necessary connection | Causal arrow, dependency line |
| `label` | Text attached to some owner | A card's bullet words, a node's name |
| `garnish` | Decoration added only **after** the relationship holds | Underlines, small squares, emphasis bars |

- A page whose `relationship` is not `none` must mark at least one `node` (`role.required`). If you declare roles, they must be self-consistent.
- `background` is written by the CLI itself onto the background-image container; the author should not hand-write it.
- Four things `validate` will block: `garnish` may not be a text box (decoration carries no meaning); at most one `spine` per page; if there's an `edge` there must be at least two `node`s; the count of `label`s may not be fewer than the `node`s acting as color blocks.
- The `data-slidra-role` on a text-box declaration is carried onto the normalized element; writing a role not in the table is rejected outright by `slide add --svg`.

## 4. Syntax walkthrough

This page is only to demonstrate syntax: how to declare a text box, how to mark roles, how to place the three footer pieces, and what a scrim sits in front of. **It is not a layout suggestion** — pick a layout from `slidra-layout-kit`.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect id="el-scrim-title" data-slidra-name="Title scrim" data-slidra-role="field" x="80" y="64" width="1120" height="88" fill="<background>" opacity="0.7"/>
<text id="el-title" data-slidra-name="Page title" data-slidra-role="label" data-slidra-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="<text>">The title is this page's claim</text>
<g id="el-unit-1" data-slidra-role="node"><rect x="80" y="176" width="1120" height="72" fill="<secondary_bg>"/></g>
<text id="el-point-1" data-slidra-name="Point 1" data-slidra-role="label" data-slidra-text-width="960" x="200" y="195" font-size="24" fill="<text>">A line of keywords, no period</text>
<line id="el-footer-rule" data-slidra-name="Footer rule" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>
<text id="el-footer-name" data-slidra-name="Footer presentation name" data-slidra-text-width="600" x="80" y="668" font-size="18" fill="<muted>">{{ presentation_name }}</text>
<text id="el-footer-page" data-slidra-name="Page number" data-slidra-text-width="400" x="800" y="668" font-size="18" fill="<muted>" data-slidra-text-align="right">{{ slide_number }} / {{ slide_total }}</text>
</svg>
```

The **syntax facts** to take from this one:

- Every element has an `id` and `data-slidra-name`; semantic elements add `data-slidra-role` (section 3b).
- A scrim is a rect that appears **before** the text it pads; it may simultaneously be that content's `field`.
- The 80/1120/656 above are the values for `side_margin: 80`; change them to match if the anchors differ.

## 4b. Background image: an SVG image you produce, placed at the page's bottom layer

The background image is an independent SVG asset, placed at the **bottom layer** of the page with `slide background set` (container `id="el-background"`, `data-slidra-role="background"`, locked — the author can't drag it, `validate` doesn't check it, no animation added). It raises the page's character a notch but **carries no meaning**: remove it and the page's meaning loses not a single word. When the plan's `plan/outline.md` `background` is `off`, put none in the whole deck.

The recipe comes from `slidra-background-kit` (already chosen at the planning stage, written in the background question's `note`); the recipe file says which `rhythm` it suits and its suggested opacity. A presentation uses **at most two recipes** (one for anchor pages, one for content pages); a recipe of the same color family builds one asset, and all pages reuse the same path. When the page background is `primary` (closing page), lower opacity to about 0.6 so the color blobs become tonal layers of the same family.

### Scrim rules when there is a background image

Even a dark background image lowers small-text contrast, so `validate`'s `structure.scrim` requires: **when a page has a background image, every text box (except the footer) must sit entirely on a "scrim panel"** — a rect that appears earlier in document order, whose fill is `background` or `secondary_bg`, and whose `opacity` is omitted or ≥ 0.6. Big text at font size ≥ `claim` (48) is the exception: the big title, section name, big number, and closing claim don't need a scrim; the recipe guarantees those regions are quiet.

**How to satisfy this is a composition decision for this page, not a lookup:**

- **Pages that already have a `field`** (cards, panels, shared field) — the `field` itself is the scrim, as long as its fill is `background`/`secondary_bg` and opacity ≥ 0.6; the `label` sitting on it passes. **First think which `field` this text belongs to, not first think which scrim to add**.
- **Text that falls outside a `field`** (titles, between-page explanations, sources) — add a scrim rect for it: covering that text box's four edges, placed before it, fill taken from `background` or `secondary_bg` (`primary` when the page base is `primary`), `opacity` 0.65–0.7. Its width and height are set by that text box.
- **Keep scrims in quiet regions**: the recipe guarantees the left half and center (x 80–760, y 72–648) are quiet, with light at the right edge and bottom-right. A scrim extending into a bright region shows a gray patch there — better to make the text box narrower.
- Big text at `claim` level or above and the footer need no scrim; adding an extra panel makes a breathing page feel crowded.

A scrim is a panel, but a breathing page's `rhythm.breathing-cards` only counts rects that are `secondary_bg` and ≥ 200×80 — a scrim using the `background` color, or smaller than that, isn't counted.

### Command order

1. One build per recipe and color family: `slidra asset import <presentation-id> --svg '<recipe SVG, roles replaced with color codes>' --name bg-<recipe>-<family>.svg` (filename allows only alphanumerics, `-`, `_`; an existing same name is rejected). The returned `data.path` is `assets/bg-….svg`.
2. Write the page: `slidra slide add <presentation-id> --svg '<full-page SVG>'` (including the scrim rect).
3. `slidra slide background set <presentation-id> slides/00N.svg --asset <data.path> --opacity <recipe-suggested value>`; to remove it use `--none`.
4. Animation per section 5; the background image is present from the first frame.

## 5. Animation script

**One click = the speaker makes one point, not draws one element.** How many `on-click` a page needs is decided by how many segments this page has to be spoken in (i.e. `blueprint.steps`).

Plan `animation`: `full` (default, reveal step by step), `minimal` (whole page arrives at once, keep only one on-click), `none` (add nothing).

### 5.1 Effects go on groups

First `element group` the elements of the same segment into a group, **then apply one effect to the group id**. The group is the animation's anchor — one anchor per segment, one effect per anchor.

```
slidra effect add <presentation-id> slides/00N.svg <group id> --family enter --effect <effect> --start on-click --duration <seconds>
```

- `element group` clears members' existing effects, so **always group first, then apply animation**.
- When the whole deck is done, apply the transition only once: `slidra slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3 --all` (don't apply it when `animation` is `none`).

### 5.2 What enters the animation (decide by role)

| Role | Enters animation? |
|---|---|
| `node` (together with its `field`/`label`, usually already in the same group) | ✅ one `on-click` per segment |
| `spine` | ✅ with the first segment it strings together (`with-previous`), or as its own first step |
| `edge` | ✅ together with the next node it connects |
| `garnish` | ❌ decoration is added only after the relationship holds; there's no step to speak it (`role.garnish-animated`) |
| `background` (background image), footer rule, presentation name, page number | ❌ present from the first frame |

**The basis for the decision is the role, not what the element is called.** An unmarked role that looks decorative (plain color blocks, lines, circles) is never added.

### 5.3 Intensity

| `animation` | How |
|---|---|
| `full` | one `on-click` per speaking step; the step count equals `blueprint.steps` |
| `minimal` | only one `on-click` on the whole page (the first group), the rest `with-previous` |
| `none` | add no effects, and no transition either |

- **A page's `on-click` steps do not exceed 5**. More than that means the page should be split.
- The only available enter effects are `appear`, `fade`, `fly-up`, `fly-left`, `zoom`. Use `fade` for parallel items, `fly-left`/`fly-up` for directional ones, and `zoom` for a single focus.

## 6. Decide the relationship first, then choose the layout

**Don't ask "which page type is this"; ask "what is the relationship between the content on this page".** The relationship decides what the geometry must carry; a page type is just the known-solution name for certain relationships.

### 6.1 Seven relationships

| Relationship | When it's this | What the geometry must carry |
|---|---|---|
| `membership` | Parallel, belonging, several things in the same group | A shared field or repeated units; **no direction** |
| `order` | Sequence, steps, ranking, time | A readable path with visible direction: straight/turning/rising; start and end must be distinguishable |
| `contrast` | A vs B, before/after, option comparison | A shared baseline plus a divider; the invariants on both sides must align for the difference to read |
| `parent` | One thing governs or breaks down into several | Hierarchy: indent, nesting, size difference; the root must be visible |
| `link` | Dependency, influence, cause and effect, transformation | The necessary connection; source and target must be clear, fewer lines the better |
| `overlap` | Intersection, shared part | An intersecting region; both the shared zone and each side's zone must be readable |
| `none` | A single claim, one number, one conclusion | No relationship to carry — whitespace and size are everything |

**Hard rule**: only use equal columns for three parallel things; three things with a sequence must show direction. Node count only affects spacing and wrapping; it is not a reason to adopt symmetry.

### 6.2 One relationship has many solutions

The same relationship can be carried by different geometries; the full catalog of solutions (grouped by relationship, with slot tables and wireframes) is in `slidra-layout-kit`. **Do not use the same solution on two adjacent pages** (`rhythm.repeated-shape` will catch it). The catalog is a starting point, not a checklist: if you need a solution not in it, compose one yourself and give it a descriptive name in `blueprint.shape`.

### 6.3 Known solutions: six page types

The following six combinations are **known solutions**: only when you use one do you fill in `type` in the plan (`validate` adds a signature-type check for that page type, and the template is registered); a composition you compose yourself keeps only `relationship`.

| `type` | Page type | Relationship | `blueprint.shape` | Signature | Footer |
|---|---|---|---|---|---|
| `cover` | Cover | `none` | `cover-stack` | `cover`-size big title | Omit |
| `section` | Section page | `none` | `claim-field` | `section`-size section name; left-edge primary `spine` color bar | Include |
| `bullets` | Bullet page | `membership` | `card-wall` | `title`-size title + N `node`s | Include |
| `compare` | Comparison page | `contrast` | `split-panel` | `title`-size title + left and right `node` | Include |
| `number` | Big-number page | `none` | `hero-number` | `number`-size figure, **only from the author's outline** | Include |
| `closing` | Closing page | `none` | `claim-field` | `primary` full-bleed base, all text in `background` color, `claim`-size conclusion; a take-away conclusion, not a "thank you" and not the cover again | Omit |

Template names: cover→`Cover`, section→`Section page`, bullets→`Bullet page`, compare→`Comparison page`, number→`Big number page`, closing→`Closing page`.

`order`, `parent`, `link`, `overlap` have no known solution; use a solution from that relationship's group in the layout kit, or compose your own using section 3b's roles — falling back to a bullet page is the same as speaking directed content as parallel content.

## 7. Content density: pages hold only claims and keywords; explanation goes to the notes

A page is for the audience to **look at**, not to **read**; writing bullets as full sentences on the page turns the page into a script.

The left column of the table below is the **writing target**; the right column is the limit `validate` actually enforces. The thresholds are deliberately loose — layouts that don't fit are blocked by overflow rules, and the character-count rules only catch the obviously excessive. **If you're under the limit, don't make the wording unclear just to be shorter.**

| Item | Target (density = presentation) | `validate` limit |
|---|---|---|
| Title (page title, section name) | 15 chars, 1 line | 24 chars |
| Cover title | ≤ 2 lines, 15 chars per line | Same as title |
| Each bullet/card's keywords | 18 chars, **1 line**, no period | 32 chars, 2 lines |
| Bullet count | 3–5 (comparison page: 2–4 per column) | 2–7 (2–6 per column) |
| Total text on a page (all text boxes summed, including card numbers, excluding footer and bare-text watermark; `{{ }}` not counted) | 600 chars | 1000 chars |
| Big-number-page caption, closing-page conclusion | 24 chars | 32 chars |
| Speaker notes | 2–5 sentences, **this is where full sentences go** | Not checked |

- One page makes one point; the title is this page's claim ("Revenue up 23% this quarter"), not a topic label ("Revenue"), unless the author's outline is already topic-titled.
- **Where expansion goes is the notes**: for the author's each bullet, the page targets one line of keywords; the full sentence or two goes into `slide notes set`. State the claim first, then the evidence, then connect to the next page; don't read out colors, positions, or element names.
- The page holds only content the author gave; expansion makes the meaning complete, not invent data, names, or dates on the author's behalf.

## 8. Consistency and taboos

- Same role, same size, same color; title top fixed at y=72; left edge fixed at x=80; a presentation uses only one color set.
- **Decoration carries no meaning**: remove all circles, lines, color blocks, and the background image and the page's meaning must lose not a word; don't draw meaningless connector lines.
- A breathing page (big-number page, section page) relies on whitespace and big type: panels (big `secondary_bg` blocks) no more than 2.
- No strokes on rects (`stroke`), no shadows; thin rings and diagonals are the stroke of an ellipse/line, which is allowed.
- No "thank you" page, no page with only contact info, no repeated cover.
- Too much text: shorten or split the page, not the font size.

## 9. Self-check: run `slidra validate`

The rules and thresholds are written into the CLI; don't calculate in your head: `slidra validate <presentation-id> [slides/00N.svg]`. A non-zero exit code means there are errors; each `data.errors[]` entry has `slide`, `element`, `rule`, `actual`, `limit`, `message`. When `plan/design-spec.md` exists, character thresholds follow its `density`; without a plan file, only geometry and skeleton are checked (the message tail will carry "no plan/ plan file, checking geometry and skeleton only").

**First-page gate**: after finishing the cover and the first content page, run `validate` once each; if there are errors, fix the approach first and only proceed to page 3 onward when you've confirmed 0 errors, not fix each page individually.

**Rules marked ⛔ are blocked on `slide add --svg`/`slide set --svg` write of the whole page** (the self-check list in section 0); the rest can be fixed with follow-up commands after writing.

| rule | What it checks | How to fix |
|---|---|---|
| ⛔ `text.title-length`, `text.bullet-length`, `text.bullet-lines`, `text.bullet-count`, `text.page-total` | Section 7's text-volume limits | Shorten; move sentences into notes; if the count is over, split the page (and use `plan set outline` to add a page to the plan) |
| ⛔ `focus.single-title` | One title role per page | Merge or split the page |
| ⛔ `geometry.right-overflow`, `geometry.bottom-overflow`, `geometry.text-overlap` | Text-box right edge ≤ 1200, bottom edge `y + lines × 1.45 × font size ≤ 648`, same-column text boxes don't overlap (decorative geometry may bleed, not checked) | Shorten the text or reduce the count; leave size and coordinates alone |
| ⛔ `style.font-size`, `style.text-fill`, `style.shape-fill` | Font size is in the section 2 table; text color is only text/muted (big numbers and bold labels may be accent, closing pages may be background); shape fills use only color roles, `none`, or `url(#…)` | Revert to `type_scale`/`palette` values (`element style set`) |
| `structure.background`, `structure.notes`, `structure.template` | Background set, notes non-empty, every page type that appeared has a registered template | Add `slide style set`/`slide notes set`/`template add` |
| ⛔ `structure.scrim` | On a page with a background image, every text box (except footer and big text ≥ claim) sits on a scrim panel (section 4b) | First see if that text can belong to some `field`; if not, add a scrim rect, rewrite the whole page with `slide set --svg`, then re-apply the background image and animation |
| `structure.background-image` | When the plan's `background` is `on`, every page has a background image | Add `slide background set --asset`, or change the plan's `background` to `off` |
| `blueprint.required` | After the plan is `confirmed`, every page must have a written `blueprint` | Fill in the `blueprint` (`shape`/`nodes`/`steps`), write it back with `plan set outline` |
| `blueprint.nodes`, `blueprint.steps` | The drawn node count and on-click step count must match what was written at composition time | If the page is drawn wrong, fix the page; if the composition was planned wrong, `plan set outline --force` to change the blueprint and explain in the report |
| `rhythm.repeated-shape` | Two adjacent pages must not use the same `blueprint.shape` to solve the same `relationship` with the same unit count | Use a different composition (the layout kit's same group has other solutions), or merge the two pages |
| `rhythm.breathing-cards` | A breathing page's panels ≤ 2 | Remove panels |
| ⛔ `role.required` | A page whose `relationship` is not `none` must mark at least one `node` | Add `data-slidra-role="node"` to each semantic unit |
| `role.garnish-animated` | `garnish` must have no enter effect | Remove that effect, or this element is actually a `node`/`label` |
| ⛔ `role.*` | Section 3b's four self-consistency rules | Change the role or add the label |
| `roster.page-count`, `roster.page-type` | Page count and each page's type match `plan/outline.md` (each page type has its signature size) | Fix the pages to the plan; only change the plan if the plan itself is wrong |
| `roster.relationship-variety` | For 4+ pages, the same `relationship` must not exceed half | Go back to the content, find the sections that are really order/contrast/one-number, and change their `relationship` |
| `motion.transition`, `motion.enter` | When `animation` is not `none`, each page has a transition; `full` needs at least one enter effect per page, `minimal` needs at least one on cover/bullet/comparison pages | Add `effect add`/`slide transition set --all` |
| ⛔ `asset.missing` | An image/media referenced by the page doesn't exist in this presentation | Use `ls <presentation-id> assets` to find the real filename; if the asset isn't imported yet, `asset import` first |
| `taboo.thank-you`, `taboo.duplicate-cover`, `taboo.stroke` | Thank-you page, repeated cover, rect stroke | Remove it |

**When the whole deck is done**: `validate` the whole deck to 0 errors, and `template list` lists names like "Cover" and "Bullet page".
