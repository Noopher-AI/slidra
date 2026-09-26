# The `.slidra` Format

**Format version:** 5
**Status:** Stable
**Namespace:** `https://slidra.app/ns/2026`
**Companion documents:** [`playback.md`](playback.md) (how a deck plays) · [`rfcs/0001-sqlite-container-format.md`](rfcs/0001-sqlite-container-format.md) (why the container is SQLite)
**Schemas:** [`schema/project.schema.json`](schema/project.schema.json) (§2) · [`schema/metadata.schema.json`](schema/metadata.schema.json) (§4–§12)
**Conformance suite:** [`../conformance/`](../conformance/) — decks with the verdict a conforming reader must reach

A `.slidra` file is a self-contained presentation: slides, their animations, speaker notes, media and fonts, in one file. Slides are plain SVG — the slide file *is* the rendered artifact, not an intermediate format.

The JSON Schemas under [`schema/`](schema/) are normative for the shapes they describe. Where this text and a schema disagree, that is a bug in one of them; report it. A schema cannot express every rule (a listed slide must exist in the container, an effect's target must name an element on its slide), so the prose also states rules the schemas leave out.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to be read as in RFC 2119. A *reader* is any program that opens a deck (a viewer, a converter); a *writer* is any program that creates or changes one.

---

## 1. Container

### 1.1 SQLite (formatVersion 5)

A `.slidra` file is a SQLite 3 database. Its presentation content lives in one table:

```sql
CREATE TABLE content (
    id   INTEGER PRIMARY KEY,
    path TEXT    NOT NULL UNIQUE,
    kind INTEGER NOT NULL,   -- 0 = file, 1 = directory
    data BLOB                -- NULL for a directory row
)
```

Every virtual path — `project.json`, `slides/001.svg`, `assets/photo.png`, an empty `assets/data/` directory — is one row. A directory is an explicit row (`kind = 1`, `data` NULL), not a prefix derived from the files under it.

Header fields:

| Field | Value |
|---|---|
| `PRAGMA application_id` | `0x536C6472` (ASCII `Sldr`) |
| `PRAGMA user_version` | `5`, equal to `project.json`'s `formatVersion` |
| Text encoding | UTF-8 |
| Journal mode | `DELETE` (writers MUST NOT leave a deck in WAL mode) |

A reader MUST identify the container by its first bytes (`SQLite format 3\0`), never by the file extension. A reader SHOULD reject a SQLite file whose `application_id` is neither `0x536C6472` nor `0`, and MUST reject one whose non-zero `user_version` disagrees with `formatVersion`.

The database MAY contain other tables (a writer's undo history, a conversation log, …). They are not part of the presentation: readers MUST ignore every table other than `content`, and writers MUST preserve tables they do not understand.

### 1.2 Legacy ZIP (formatVersion 1–4)

Before version 5, a `.slidra` file was a ZIP archive (`PK\x03\x04`) holding the same entries as files. Readers MAY support it read-only; writers MUST NOT produce it. A writer that opens one converts it once to the SQLite container at `formatVersion` 5, atomically (build the new file beside the old one, then rename).

### 1.3 Entries

| Entry | Kind | Required | Description |
|---|---|---|---|
| `project.json` | file | yes | Presentation metadata (§2) |
| `slides/` | directory | yes (may be empty) | Slide SVGs (§3) |
| `assets/` | directory | yes (may be empty) | Images, video, audio, data (§13) |
| `fonts/` | directory | yes (may be empty) | Embedded fonts and their licences (§8) |
| `templates/` | directory | no | Template slides (§15) |
| `assets/data/` | directory | no | CSV files bound to tables (§12) |
| `plan/` | directory | no | Authoring notes (e.g. `outline.md`); not rendered |

### 1.4 Path rules

Every entry path is relative, `/`-separated, and MUST NOT be empty, start with `/`, contain a `\` or a NUL, or contain an empty, `.` or `..` segment. A reader MUST refuse a deck carrying a path that breaks these rules. Nothing in a deck is ever extracted to a real directory as part of reading it.

---

## 2. `project.json`

UTF-8 JSON, the deck's root metadata. Machine-readable: [`schema/project.schema.json`](schema/project.schema.json) (JSON Schema 2020-12).

```jsonc
{
  "formatVersion": 5,
  "name": "My Presentation",
  "canvas": { "width": 1280, "height": 720 },
  "slides": ["slides/001.svg", "slides/002.svg"],
  "fonts": [
    {
      "file": "fonts/NotoSansTC-Presentation.ttf",
      "family": "Noto Sans TC",
      "license": "SIL Open Font License 1.1",
      "licenseFile": "fonts/LICENSE-NotoSansTC.txt",
      "source": "https://fonts.google.com/noto/specimen/Noto+Sans+TC"
    }
  ],
  "templates": [{ "file": "templates/001.svg", "name": "Title Slide" }],
  "author": "Alice Chen",
  "created": "2026-09-01T09:00:00Z",
  "modified": "2026-09-20T17:45:00+08:00",
  "description": "Quarterly review for the platform team.",
  "keywords": ["review", "Q3"],
  "cover": "slides/001.svg"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `formatVersion` | integer | yes | `5` in a SQLite container; `1`–`4` only in a legacy ZIP container. Any other value MUST be rejected. |
| `name` | string | yes | Display name. |
| `canvas` | `{ width, height }` | yes | Positive, finite numbers, in px. Every slide's `viewBox` matches it. |
| `slides` | string[] | yes | Ordered slide paths. May be empty. Every path MUST name an existing file. |
| `fonts` | `FontEntry[]` | no | Embedded fonts (§8). |
| `templates` | `(string \| { file, name })[]` | no | Template slides; bare strings are the legacy form and may be mixed with objects. |
| `transition` | string | no | Reserved; no effect. |
| `author` | string | no | Who made the deck, as it should be displayed. |
| `created` | string | no | When the deck was first created: an RFC 3339 date-time (`2026-09-01T09:00:00Z`). Never changed afterwards. |
| `modified` | string | no | When the deck's content last changed, RFC 3339. Writers update it on every save that changes content. |
| `description` | string | no | A one- or two-sentence summary, plain text. |
| `keywords` | string[] | no | Free-form tags. |
| `lang` | string | no | The deck's main language, a BCP 47 tag (`en`, `zh-Hant-TW`). See §4.7. |
| `cover` | string | no | The slide that represents the deck in lists and previews. MUST be one of `slides`; default is the first slide. |

### 2.1 Document metadata

`author`, `created`, `modified`, `description`, `keywords`, `lang` and `cover` describe the deck; they never change how it renders or plays. A reader that shows them (in a library, a title bar, a link preview) MUST treat them as untrusted plain text. Writers MUST write them with the types above. A reader MUST NOT reject a deck over them: it ignores a field of the wrong type, an unparseable date, and a `cover` that is not one of `slides` (falling back to the first slide), and it may report the problem.

**Unknown fields are preserved.** A writer MUST keep fields it does not understand; a reader MUST NOT reject a deck for carrying them. Writers serialise with 2-space indentation and a trailing newline, preserving key order.

### 2.2 `FontEntry`

```ts
interface FontEntry {
  file: string;        // container path, e.g. "fonts/MyFont.ttf"
  family: string;      // CSS font-family name, unique within the deck
  license: string;     // human-readable licence name
  licenseFile: string; // container path to the licence text
  source: string;      // where the font came from
}
```

`file` and `licenseFile` follow §1.4. Writers MUST write all five fields. To render a deck, a reader needs only `file` and `family` and MUST NOT reject a deck for missing the other three.

---

## 3. Slides

Each slide is one SVG document under `slides/`.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"
     style="background-color:#101418">
  <metadata> … </metadata>         <!-- §5: effects, transition, notes, comments -->
  <g id="el-background"> … </g>    <!-- §4.6: optional background image -->
  <g id="el-…"> … </g>             <!-- content elements; z-order = document order -->
</svg>
```

- The `viewBox` MUST match `project.json`'s `canvas`.
- `style="background-color:…"` on the root sets the slide background.
- A slide is **self-contained**: its graphics, element ids, effects, transition, notes and comments all live in its own SVG. Reordering slides touches only `project.json`'s `slides` array.
- Files are conventionally named `001.svg`, `002.svg`, … by position; the number is not an identity.
- `data-slidra-slide-id` on the root is the slide's stable identity: `s-` + 12 base64url characters, opaque, unique within the deck, and kept when the slide is moved, renamed or edited. It is optional; a slide without one cannot be the target of a link (§4.8). Writers that copy a slide MUST give the copy a new id.
- An SVG `<title>` as the root's first child (after `<metadata>`, if any) is the slide's title, for lists, the overview and assistive technology (§4.7).

---

## 4. Elements

### 4.1 The element container

Every addressable element is wrapped in a `<g>`:

```xml
<g id="el-Ab3xK9mQ2pLw" data-slidra-name="Title" transform="translate(96 200)">
  <text x="0" y="0" font-size="86" fill="#f4f6f8">Hello</text>
</g>
```

| Attribute | Meaning |
|---|---|
| `id` | `el-` + 12 base64url characters (9 random bytes). Opaque and stable; it encodes nothing. |
| `data-slidra-name` | Display name; free text, not used for addressing. |
| `transform` | Optional. Position and rotation live here, on the container, never on its primitives. |

A primitive outside an element container is non-conforming and not addressable. Unknown `data-slidra-*` attributes MUST be preserved by writers.

### 4.2 Groups

A group is an element container whose children are element containers. Groups nest.

### 4.3 Locked elements

`data-slidra-lock="true"` marks structural scaffolding that editors should not change by accident. It has no effect on rendering or playback.

### 4.4 Text boxes

A container with `data-slidra-text-width` is a text box whose lines were wrapped at that width:

```xml
<g id="el-tb1" data-slidra-text-width="400" data-slidra-text-height="200" transform="translate(100 200)">
  <text font-size="24" fill="#333">
    <tspan x="0" dy="0">Line one</tspan>
    <tspan x="0" dy="28" data-slidra-break="true">Line two</tspan>
  </text>
</g>
```

| Attribute | Meaning |
|---|---|
| `data-slidra-text-width` | Wrap width (px). |
| `data-slidra-text-height` | Height after wrapping (informational). |
| `data-slidra-text-align` | `left` (default) \| `center` \| `right`. |
| `data-slidra-break="true"` (on `<tspan>`) | A hard line break in the source text; soft wraps carry no marker. |
| `data-slidra-list` | `bullet` \| `number` \| `none`. |
| `data-slidra-list-marker` | The rendered marker text (`•`, `1.`). |

The wrapped `<tspan>`s are the rendering; readers display them as-is.

### 4.5 Media

`data-slidra-media` on a container names a media file (a path relative to the slide, e.g. `../assets/intro.webm`); the container's own shapes are the placeholder the media is shown over.

```xml
<g id="el-video1" data-slidra-media="../assets/intro.webm" data-slidra-type="video">
  <rect x="240" y="220" width="400" height="300" fill="#3a4550"/>
</g>
```

| Attribute | Meaning |
|---|---|
| `data-slidra-media` | The media reference. |
| `data-slidra-type` | Optional `video` \| `audio`; otherwise the kind comes from the extension. |
| `data-slidra-embed` | Set (to a provider name, currently `youtube`) when `data-slidra-media` is a third-party player URL rather than a file. |

Recognised extensions — video: `.mp4 .m4v .mov .webm .ogv`; audio: `.mp3 .m4a .wav .opus .oga .aac`. Images use a plain `<image href="…">` inside the container.

### 4.6 Background image

At most one element per slide carries `data-slidra-role="background"`. It has the fixed id `el-background`, is locked, and is the first element after `<metadata>`:

```xml
<g id="el-background" data-slidra-name="Background image" data-slidra-lock="true" data-slidra-role="background">
  <image href="../assets/bg.png" x="0" y="0" width="1280" height="720"/>
</g>
```

### 4.7 Accessibility

A slide is shown to people who cannot see it: through a screen reader, as text in a search index, or as an outline. The format carries what they need in plain SVG.

**Names and descriptions.** An element container's accessible name is the text of an SVG `<title>` that is its first child element; an optional `<desc>` right after it is a longer description. The slide's own name is the root's `<title>` (§3).

```xml
<g id="el-Ab3xK9mQ2pLw" data-slidra-name="Team photo">
  <title>The platform team at the 2026 offsite, twelve people on a beach</title>
  <image href="../assets/team.jpg" x="96" y="160" width="640" height="360"/>
</g>
```

**Decorative elements.** `data-slidra-decorative="true"` marks an element that carries no information (a divider, a glow, a pattern). Assistive technology skips it and everything inside it. The background image (§4.6) is always decorative.

**Language.** `project.json`'s `lang` is the deck's language. An `xml:lang` (or `lang`) attribute on a slide's root or on an element overrides it for that subtree, as in any XML document.

**Reading order** is document order: element containers are read in the order they appear, which is also their z-order. A group with a `<title>` is read as one item (its name); a group without one is read through, child by child.

**What a reader derives.** For each element that is not decorative, in reading order, a reader that exposes slides to assistive technology SHOULD present:

| Element | Presented as |
|---|---|
| With a `<title>` | its name, then its `<desc>`, if any |
| Text (`<text>`, a text box) with no `<title>` | its text, each `<tspan>` with `data-slidra-break` or its own `x` a new line |
| Chart (§11) with no `<title>` | a summary generated from `<slidra:chart>`: the chart type, then each series' name and values by category |
| Table (§12) with no `<title>` | its cells, row by row |
| Media (§4.5) with no `<title>` | its kind and file name |
| An image or other graphic with no `<title>` | nothing |

A checker SHOULD flag every element that shows an image, media or a chart and has neither a `<title>` nor `data-slidra-decorative="true"`.

A reader that renders slides in a browser SHOULD also stop `<title>` from showing as a hover tooltip during playback (for example by moving it to `aria-label`); the stored SVG is not changed.

**Writers** SHOULD give every element that shows an image, media or a chart either a `<title>` or `data-slidra-decorative="true"`, and SHOULD set `lang`.

### 4.8 Links

`data-slidra-link` on an element container makes the element a link. Activating it (a click or tap on the element, or Enter while it has keyboard focus) follows the link **instead of** advancing the slide.

```xml
<g id="el-cta000000000" data-slidra-link="https://slidra.app/spec">…</g>        <!-- a web page -->
<g id="el-appendix0000" data-slidra-link="#s-Q2xpY2tNZTEy">…</g>                <!-- another slide -->
<g id="el-back00000000" data-slidra-link="#first">…</g>                         <!-- a navigation action -->
```

| Value | Meaning |
|---|---|
| `https://…`, `http://…`, `mailto:…` | Opens the URL outside the presentation (a new browser tab, the mail client). The viewer itself never navigates away. |
| `#s-…` | Goes to the slide whose `data-slidra-slide-id` (§3) matches, arriving at its opening state. |
| `#next`, `#previous` | Goes to the next / previous slide, skipping the rest of the current slide's steps. |
| `#first`, `#last` | Goes to the first / last slide. |

Every slide a link arrives at opens in its opening state (playback §2), with its page transitions played as for any other jump.

A reader MUST ignore (and SHOULD report) a link whose value is none of these: another URL scheme (`javascript:`, `data:`, `file:` …), a relative path, or a slide id that no slide in the deck carries. An ignored link is not an error that makes the slide corrupt; the element behaves as if it had no link. A reader SHOULD show linked elements as interactive (a pointer cursor, a focus ring) and make them reachable with Tab.

SVG's own `<a href>` is not a Slidra link: readers MUST NOT follow it, and writers use `data-slidra-link` instead. Following a link never changes the deck and never runs anything from the slide (§17).

---

## 5. Metadata

Slide-level metadata lives in `<metadata>` as elements in the Slidra namespace. Machine-readable: [`schema/metadata.schema.json`](schema/metadata.schema.json). XML attributes are strings, so an element is checked by reading its attributes into a JSON object and validating it against the definition named after the element (`$defs/effect` for `<slidra:effect>`, `$defs/element` for an element container, and so on). Recognised elements:

| Element | Purpose |
|---|---|
| `<slidra:effects>` | Effect list (§6) |
| `<slidra:transition>` | Page transition (§7) |
| `<slidra:notes>` | Speaker notes (§9) |
| `<slidra:comments>` | Review annotations (§10) |

Each block declares the namespace itself (`xmlns:slidra="https://slidra.app/ns/2026"`); a declaration on the root is equally valid. A slide MAY carry more than one `<metadata>` block; readers consider all of them. `<slidra:chart>` and `<slidra:source>` use the same namespace but live inside their element's container (§11, §12).

---

## 6. Effects

An effect is a playback-time animation of exactly one element. A slide's effects are one ordered list:

```xml
<slidra:effects xmlns:slidra="https://slidra.app/ns/2026">
  <slidra:effect target="el-abc" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>
  <slidra:effect target="el-def" family="emphasis" effect="pulse" start="with-previous"/>
</slidra:effects>
```

### 6.1 Attributes

| Attribute | Required | Description |
|---|---|---|
| `target` | yes | Id of an element (or group) on this slide. |
| `family` | yes | `enter` \| `emphasis` \| `exit` \| `path` \| `media` |
| `effect` | yes | One of the family's effects (§6.2). |
| `start` | yes | `on-click` \| `with-previous` \| `after-previous` |
| `duration` | no | Seconds, as a plain decimal (`0.6`, `2`, `.5`; no sign, exponent or hex). Default `0.6`; `0` for `media`. |
| `delay` | no | Seconds. Default `0`. |
| `d` | for `path` | SVG path data (slide coordinates, relative motion). |
| `easing` | no | `ease` \| `linear` \| `ease-in` \| `ease-out` \| `ease-in-out` \| `overshoot`. Default `ease`; `linear` for `path`. Not allowed on `media`. |
| `repeat` | no | How many times the effect runs, a positive integer. Default `1`. `emphasis` only. |
| `by` | no | `line` \| `word` \| `letter`: build the target's text one unit at a time (playback §3.5). `enter` and `exit` only. |
| `stagger` | no | Seconds between units when `by` is set. Default `0.1`. Only with `by`. |
| `trigger` | no | Id of an element on this slide. The effect then runs when that element is activated, not when the slide advances (§6.3). |

### 6.2 Families

| Family | Effects |
|---|---|
| `enter` | `appear`, `fade`, `fly-up`, `fly-down`, `fly-left`, `fly-right`, `zoom` |
| `emphasis` | `pulse`, `spin`, `grow` |
| `exit` | `disappear`, `fade-out`, `fly-out-up`, `fly-out-down`, `fly-out-left`, `fly-out-right`, `zoom-out` |

A `fly-*` name says which way the element moves: `fly-up` rises into place from below, `fly-out-left` leaves towards the left.
| `path` | `path` |
| `media` | `play`, `pause` |

### 6.3 Steps

Effects are grouped into **steps**, the unit of advancing: every `on-click` effect opens a new step; `with-previous` and `after-previous` effects join the current one. Steps are derived, never stored.

Effects with a `trigger` are left out of the slide's steps. Each trigger element gets its own sequence, built from its effects in list order by the same rule: every activation of the trigger (a click, or Enter while it has focus) runs its next step. Advancing the slide never runs them.

### 6.4 Validity

A slide's effect list is **corrupt** — and a reader MUST NOT animate it (it SHOULD show the slide statically and report why) — when:

- a required attribute is missing or empty;
- `family`, `effect` or `start` is not one of the values above;
- `target` names no element on the slide;
- a `path` effect has no `d`;
- `duration` or `delay` is present but not a finite, non-negative decimal number (an empty `duration=""` is invalid, not "default"; `1e3`, `0x10` and `Infinity` are invalid too);
- the first effect's `start` is not `on-click` — counting only effects without a `trigger`, and separately for each trigger's own effects;
- `easing`, `by` or `repeat` has a value not listed above, `stagger` is not a valid number of seconds, or `trigger` names no element on the slide;
- `easing` is set on a `media` effect, `repeat` on a family other than `emphasis`, `by` on a family other than `enter` and `exit`, or `stagger` without `by`;
- a `media` `play` effect's target has no `data-slidra-media` (and is not an embed), or names an unsupported format.

How each family animates is specified in [`playback.md`](playback.md).

---

## 7. Transitions

A slide's page transition is per slide and has two edges: how the slide arrives (`enter`) and how it leaves (`exit`).

```xml
<slidra:transition xmlns:slidra="https://slidra.app/ns/2026"
                   enter="fade" enter-duration="0.3" exit="none" exit-duration="0.5"/>
```

| Attribute | Values | Default |
|---|---|---|
| `enter` | `none` \| `fade` \| `slide` \| `zoom` \| `morph` | `none` |
| `enter-duration` | seconds ≥ 0 | `0.6` |
| `exit` | `none` \| `fade` \| `slide` \| `zoom` | `none` |
| `exit-duration` | seconds ≥ 0 | `0.5` |

At most one `<slidra:transition>` per slide; two or more, or an invalid value, makes the slide's playback data corrupt (§6.4). `morph` is an arrival only: `exit="morph"` is invalid.

`morph` animates from the slide being left to this one element by element, pairing elements by `id` (playback §5.1). Element ids are stable (§4.1), so a writer makes a "magic move" by keeping an element's id on both slides and changing its position, size or opacity.

---

## 8. Fonts

Fonts are stored under `fonts/` and registered in `project.json` (§2.2). Slides refer to them by `font-family` name only; a reader that renders the deck MUST make every registered font available under its `family` name (e.g. with `@font-face`). A deck with no `fonts` array but a `fonts/NotoSansTC-Presentation.ttf` file SHOULD be rendered with that file as `Noto Sans TC`.

A slide opened on its own, outside its deck, falls back to system fonts — pixel-identical rendering is then not guaranteed. Fonts are deliberately not inlined into every slide.

---

## 9. Speaker notes

```xml
<slidra:notes xmlns:slidra="https://slidra.app/ns/2026">Remember to introduce yourself first.</slidra:notes>
```

Plain text (XML-escaped), shown to the presenter only. Absent or empty means no notes.

---

## 10. Comments

Review annotations attached to elements, for collaborators to act on. Not rendered during playback.

```xml
<slidra:comments xmlns:slidra="https://slidra.app/ns/2026">
  <slidra:comment id="c-01" target="el-title" author="Alice" created="2026-09-01T00:00:00.000Z">Should the title be bigger?</slidra:comment>
</slidra:comments>
```

| Attribute | Description |
|---|---|
| `id` | Opaque identifier. |
| `target` | An element id, or `page` for the whole slide. |
| `author` | Optional. |
| `created` | ISO 8601 timestamp, never modified. |

---

## 11. Charts

A chart is an element container holding both its data and its rendering:

```xml
<g id="el-chart1" data-slidra-type="chart" transform="translate(691.2 115.2)">
  <slidra:chart xmlns:slidra="https://slidra.app/ns/2026" type="bar" width="480" height="320" legend="bottom">
    <slidra:series name="Revenue" values="100,120,140" axis="left"/>
    <slidra:categories values="Q1,Q2,Q3"/>
  </slidra:chart>
  <svg width="480" height="320" viewBox="0 0 480 320"> <!-- the rendered chart --> </svg>
</g>
```

| `slidra:chart` attribute | Values |
|---|---|
| `type` (required) | `bar` \| `hbar` \| `line` \| `area` \| `pie` \| `donut` |
| `width`, `height` (required) | positive numbers |
| `stacked` | `true` \| `false` (default) — `bar`, `hbar`, `area` only |
| `axes` | `single` (default) \| `dual` |
| `palette` | `brand` \| `cool` \| `warm` |
| `legend` | `none` \| `bottom` \| `right` |
| `grid`, `labels` | `true` \| `false` |
| `x-title`, `y-title` | strings (empty = none) |

Children: one or more `<slidra:series name values axis? color?>` (`values` comma-separated numbers, `axis` `left`/`right`, `color` `#RRGGBB`), and exactly one `<slidra:categories values>`.

The embedded `<svg>` **is** the rendering; readers display it and never need to re-render from data. Writers regenerate it whenever the data changes. The chart's box is the embedded `<svg>`'s `width`/`height`.

---

## 12. Tables

Tables use the same "data plus rendering" shape:

```xml
<g id="el-t1" data-slidra-type="table" data-slidra-cols="200 300" data-slidra-rows="44 40"
   data-slidra-header="1" data-slidra-theme="dark" transform="translate(100 100)">
  <slidra:source xmlns:slidra="https://slidra.app/ns/2026" src="assets/data/sales.csv"/>
  <g data-slidra-cell="0,0" transform="translate(0 0)">
    <rect x="0" y="0" width="200" height="44" fill="#EEEEEE"/>
    <text x="8" y="28" fill="#000000" font-weight="700"><tspan>Total</tspan></text>
  </g>
  <!-- … one <g data-slidra-cell> per cell … -->
</g>
```

| Container attribute | Meaning |
|---|---|
| `data-slidra-cols` / `data-slidra-rows` | Space-separated column widths / row heights (px). |
| `data-slidra-header` | `1` when the first row is a header. |
| `data-slidra-theme` | `dark` (default) \| `light` \| `zebra`. |

| Cell attribute | Meaning |
|---|---|
| `data-slidra-cell` | `row,col`, 0-based. |
| `data-slidra-span` | `rowSpan,colSpan` (default `1,1`). |
| `data-slidra-repeat="row"` | Template row for bound tables (with `display="none"`; at most one). |
| `data-slidra-generated="1"` | Content was generated from the CSV source. |
| `data-slidra-align` | `left` (default) \| `center` \| `right`. |

`<slidra:source src>` (at most one) binds the table to a CSV under `assets/`. The grid MUST be fully covered by cells, and merged ranges MUST NOT overlap. As with charts, the cells are the rendering.

---

## 13. Assets

Media and data files live under `assets/` (CSV files under `assets/data/`). Slides reference them with paths relative to the slide, e.g. `href="../assets/photo.png"`. References are resolved against the slide's own path inside the deck; a reader MUST NOT resolve them against anything outside the deck. Absolute URLs (`https:`) are allowed but make a deck no longer self-contained.

---

## 14. Dynamic text

Three placeholders are substituted when a slide is rendered:

| Placeholder | Value |
|---|---|
| `{{ slide_number }}` | The slide's 1-based position |
| `{{ slide_total }}` | Number of slides |
| `{{ presentation_name }}` | `project.json`'s `name` |

Whitespace inside the braces is optional. Substitution applies only to the character data of leaf `<text>` and `<tspan>` elements — never to attributes or markup — and an unknown name is left exactly as written. The stored SVG keeps the literal placeholders.

---

## 15. Templates

Templates are complete slide SVGs under `templates/`, listed in `project.json`'s `templates`. Applying a template copies it into a new slide; from then on the two are independent. Templates are not part of playback.

---

## 16. Design principles

1. **Self-contained.** One file holds everything needed to render and play the deck, fonts included.
2. **SVG is the format.** No proprietary intermediate layer; each slide is a valid SVG document.
3. **Slides are independent.** Swapping two slides changes nothing but their order.
4. **Flat addressing.** Elements are addressed by opaque ids, stable under reordering and renaming.
5. **Forward compatible.** Unknown `project.json` fields, unknown `data-slidra-*` attributes and unknown tables survive every writer.
6. **No silent correction.** An invalid `project.json`, an out-of-range `formatVersion` or a corrupt effect list is an explicit error, never quietly patched. The single sanctioned conversion is legacy ZIP → SQLite (§1.2).

---

## 17. Security

A deck is meant to be opened by people other than its author, and a valid SVG can carry scripts and event handlers. **Slide content is untrusted.** A reader that renders slides in a browser:

- MUST NOT execute any script, `on*` handler or `javascript:` URL from the slide;
- SHOULD render each slide in a sandboxed, opaque-origin frame (`<iframe sandbox="allow-scripts">` without `allow-same-origin` when it needs its own runtime inside the frame; never both flags together), with a Content-Security-Policy that admits only the reader's own runtime;
- MUST treat every id, attribute and text value from a slide as data — in particular when building selectors, JSON or HTML from them;
- MUST NOT follow entry paths outside the deck (§1.4);
- MUST treat the container bytes as untrusted too: a malformed or hostile file (a truncated database, a page pointing outside the file, a ZIP entry that inflates far beyond its declared size) MUST end in an error that says the deck cannot be read, never a crash or a hang;
- SHOULD enforce limits on the size of the file, of any one entry and on the number of entries, checking a ZIP entry's declared size before inflating it, and say which limit a deck exceeded;
- MUST open external links (§4.8) only on the user's own activation, outside the viewer, without giving the opened page a reference back to it (`noopener`), and only for `http:`, `https:` and `mailto:` URLs.

---

## 18. Layout summary

```
my-presentation.slidra          (one SQLite file; each line below is a row of `content`)
├── project.json
├── slides/
│   ├── 001.svg
│   └── 002.svg
├── assets/
│   ├── photo-1.png
│   ├── video-1.webm
│   └── data/
│       └── sales-1.csv
├── fonts/
│   ├── NotoSansTC-Presentation.ttf
│   └── LICENSE-NotoSansTC.txt
├── templates/                  (optional)
└── plan/                       (optional)
```
