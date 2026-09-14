# `.slidra` Format Specification

**Version:** 5 (container: SQLite, `spec/rfcs/0001-sqlite-container-format.md`)  
**Status:** Stable  
**Namespace:** `https://slidra.app/ns/2026`

A `.slidra` file is the canonical, self-contained container for a Slidra presentation. This document describes the file's internal shape — `project.json`, slide SVGs, assets, fonts, templates — independent of which container format currently carries them; §1 covers where that shape lives on disk for each format version.

> **`formatVersion` 5 changes the container itself, not just this document's version number.** [`spec/rfcs/0001-sqlite-container-format.md`](../../spec/rfcs/0001-sqlite-container-format.md) is authoritative for the SQLite container (schema, migration, concurrency, write granularity); this file's container description below (ZIP) applies to `formatVersion` 1 through 4 only. Every field/element/attribute rule elsewhere in this document — `project.json`'s shape, slide SVG structure, `<slidra:*>` elements — is unaffected by which container carries it.

---

## 1. Container

**`formatVersion` 1 through 4** (legacy): a `.slidra` file is a standard ZIP archive (`.zip` internally; the `.slidra` extension is conventional). No specific compression method or level is mandated — any valid ZIP is acceptable.

**`formatVersion` 5** (current): a `.slidra` file is a SQLite database — see `spec/rfcs/0001-sqlite-container-format.md` §1 for the schema. Every entry below (`project.json`, `slides/`, `assets/`, `fonts/`, `templates/`, `plan/`) is a `path` row in that database's `content` table instead of a ZIP entry; the entries themselves, and everything `project.json` requires of them, are otherwise identical. A legacy file is migrated to this format exactly once, the first time `slidra open` sees it (RFC 0001 §2) — there is no ZIP-to-ZIP migration chain above `formatVersion` 4, and no SQLite-to-SQLite migration chain either: 5 is the only version this crate has ever produced.

### 1.1 Required top-level entries

| Entry | Type | Description |
|-------|------|-------------|
| `project.json` | file | Presentation metadata (see §2). **Required.** |
| `slides/` | directory | Slide SVG files. **Required** (may be empty). |
| `assets/` | directory | Media assets (images, video, audio, data files). **Required** (may be empty). |
| `fonts/` | directory | Embedded font files. **Required** (may be empty). |

### 1.2 Optional entries

| Entry | Type | Description |
|-------|------|-------------|
| `templates/` | directory | Slide templates (one SVG per template). |
| `assets/data/` | directory | CSV data files referenced by tables (subdirectory of `assets/`). |
| `plan/` | directory | Plan files (`outline.md`, `design-spec.md`). |

### 1.3 Unpack safety

When extracting a `.slidra` archive, all entry paths are validated **before** any file is written:

- No entry may resolve to a path outside the target directory (no absolute paths, no `..` segments).
- If validation fails, the entire extraction is aborted and no partial files are left behind.
- Missing required directories (`slides/`, `assets/`, `fonts/`) are created automatically.

---

## 2. `project.json`

The presentation's root metadata file. UTF-8 encoded JSON.

### 2.1 Schema

```jsonc
{
  "formatVersion": 1,          // required, must equal 1
  "name": "My Presentation",   // required, string
  "canvas": {                  // required
    "width": 1280,            // required, positive number (px)
    "height": 720             // required, positive number (px)
  },
  "slides": [                  // required, array of virtual paths
    "slides/001.svg",
    "slides/002.svg"
  ],
  "fonts": [                   // optional
    {
      "file": "fonts/NotoSansTC-Presentation.ttf",
      "family": "Noto Sans TC",
      "license": "SIL Open Font License 1.1",
      "licenseFile": "fonts/LICENSE-NotoSansTC.txt",
      "source": "https://fonts.google.com/noto/specimen/Noto+Sans+TC"
    }
  ],
  "templates": [               // optional
    { "file": "templates/001.svg", "name": "Title Slide" }
  ],
  "transition": "fade"         // optional, reserved for future use
}
```

### 2.2 Field details

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `formatVersion` | `number` | Yes | Must equal `1`. Any other value causes the file to be rejected. |
| `name` | `string` | Yes | Presentation display name. |
| `canvas` | object | Yes | `{ width, height }` — both positive numbers, in pixels. |
| `slides` | `string[]` | Yes | Ordered list of virtual paths to slide SVGs. May be empty (`[]`). |
| `fonts` | `FontEntry[]` | No | Registered fonts. See §8. |
| `templates` | `(string \| TemplateEntry)[]` | No | Template slides. May mix bare strings and objects. |
| `transition` | `string` | No | Reserved. No behavioral effect currently. |

### 2.3 `FontEntry`

```ts
interface FontEntry {
  file: string;        // container-relative path, e.g. "fonts/MyFont.ttf"
  family: string;      // CSS font-family name (unique within the presentation)
  license: string;     // human-readable license name
  licenseFile: string; // container-relative path to license text
  source: string;      // URL where the font was originally obtained
}
```

Constraints: `file` and `licenseFile` must not start with `/` and must not contain `..` path segments. `family` must be unique across all entries.

### 2.4 `TemplateEntry`

```ts
interface TemplateEntry {
  file: string;  // container-relative path to the template SVG
  name: string;  // user-visible display name
}
```

In `project.json`, templates may appear as either bare strings (legacy) or `{ file, name }` objects. A mix within the same array is valid.

### 2.5 Unknown fields

Fields not defined in this specification **are preserved** on write and do not cause validation errors. This ensures forward compatibility: a presentation saved by a newer Slidra version can be opened by an older one without loss of unrecognized data.

### 2.6 Write format

When Slidra writes `project.json`, it serializes with 2-space indentation and appends a single trailing newline. Key order is preserved (insertion order).

### 2.7 `formatVersion` enforcement

There is **no migration chain**. If `formatVersion` is not `1`, the file is rejected immediately with an error. No automatic upgrade, conversion, or partial read is attempted.

Legacy CoMotion files are rejected outright, even though they can also carry `formatVersion: 1`. A slide containing `xmlns:comot` or `co-motion.dev/ns` is recognized as legacy content and the entire archive is rejected; Slidra never migrates or partially reads it.

---

## 3. Slides

Each slide is a single SVG file stored under `slides/` (e.g., `slides/001.svg`). The slide file **is** the rendered output — it is not an intermediate format.

### 3.1 SVG root

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"
     style="background-color:#101418">
  ...
</svg>
```

- The `viewBox` must match the `canvas` dimensions in `project.json`.
- The `style="background-color:..."` sets the slide background.

### 3.2 Slide structure (layer order, bottom to top)

```
<svg>
  <metadata>          <!-- slidra:* metadata (effects, transition, notes, comments) -->
  <g id="el-background">  <!-- background image (optional) -->
  <g id="el-...">         <!-- content elements (z-order = document order) -->
  ...
</svg>
```

### 3.3 Naming convention

Slide files use zero-padded sequence numbers: `slides/001.svg`, `slides/002.svg`, … The number is positional (not a persistent ID) and is renumbered on reorder.

---

## 4. Elements

### 4.1 Standard element container

Every addressable element is wrapped in a `<g>` element:

```xml
<g id="el-Ab3xK9mQ2pLw" data-slidra-name="Title">
  <text x="640" y="330" text-anchor="middle" font-size="86" fill="#f4f6f8">
    Hello
  </text>
</g>
```

- **`id`**: must start with `el-` followed by 12 characters of base64url (9 random bytes). The id is opaque — it encodes no path or meaning.
- **`data-slidra-name`**: the user-visible display name (editable via `element name set`). Changing the name does not affect the id or addressing.
- **`transform`**: optional. Standard SVG transform attribute (`translate`, `rotate`, `scale`, `matrix`).

A bare SVG element (e.g., a `<text>` not wrapped in `<g id="el-…">`) is **non-conforming** and is treated as non-addressable.

### 4.2 Groups

A group is simply an element container whose children are other element containers:

```xml
<g id="el-group1" data-slidra-name="Header Group">
  <g id="el-title" data-slidra-name="Title">...</g>
  <g id="el-subtitle" data-slidra-name="Subtitle">...</g>
</g>
```

Groups can be nested (a group inside a group). Grouping/ungrouping is done via `element group` / `element ungroup` commands.

### 4.3 Locked elements

Elements marked with `data-slidra-lock="true"` are structural scaffolding. They cannot be modified by ordinary commands (move, resize, style set, text set, etc.) unless the command is explicitly given `--force`. They can still be **deleted** or **cut** without `--force`.

The lock is a guard against accidental edits, not an absolute prohibition.

### 4.4 Text boxes

A text box is a special element that holds wrapped text content. It is identified by the presence of `data-slidra-text-width` on its container:

```xml
<g id="el-tb1" data-slidra-name="Body"
   data-slidra-text-width="400" data-slidra-text-height="200"
   transform="translate(100 200)">
  <text font-size="24" fill="#333">
    <tspan x="0" dy="0">Line one</tspan>
    <tspan x="0" dy="28">Line two</tspan>
    <tspan x="0" dy="28" data-slidra-break="true">Line three</tspan>
  </text>
</g>
```

- `data-slidra-text-width`: the content width (px) at which wrapping occurs.
- `data-slidra-text-height`: the computed height after wrapping (informational).
- `data-slidra-text-align`: `left` | `center` | `right` (optional; default `left`).
- `data-slidra-break="true"` on a `<tspan>` marks a hard line break (the source text had a `\n`). Soft wraps (inserted by the layout engine) do not carry this marker.
- `data-slidra-list`: `bullet` | `number` | `none` — paragraph list style.
- `data-slidra-list-marker`: the rendered marker text (e.g., `•`, `1.`).

### 4.5 Media elements

Media (image, video, audio) is indicated by the `data-slidra-media` attribute on the container:

```xml
<g id="el-video1" data-slidra-name="Video" data-slidra-media="../assets/intro.webm">
  <rect x="240" y="220" width="400" height="300" fill="#3a4550"/>
</g>
```

- `data-slidra-media`: container-relative path to the media file.
- `data-slidra-embed`: set when the media is embedded (base64) rather than referenced.

For images, the standard `<image href="...">` is used inside the container.

### 4.6 Background image

At most one element per slide may carry `data-slidra-role="background"`:

```xml
<g id="el-background" data-slidra-name="Background image"
   data-slidra-lock="true" data-slidra-role="background">
  <image href="../assets/bg.png" x="0" y="0" width="1280" height="720"/>
</g>
```

- Fixed `id="el-background"`.
- Always `data-slidra-lock="true"`.
- Positioned first (bottom-most layer), immediately after `<metadata>`.
- Managed exclusively by `slide background set`; not addressable by normal element commands.

---

## 5. Metadata (`<metadata>`)

Slide-level metadata lives inside `<metadata>` using the Slidra namespace (`https://slidra.app/ns/2026`). Only the following tags are recognized:

| Tag | Purpose |
|-----|---------|
| `<slidra:effects>` | Effect list (see §6) |
| `<slidra:transition>` | Slide transition (see §7) |
| `<slidra:notes>` | Speaker notes (see §9) |
| `<slidra:comments>` | Annotations (see §10) |

> **Note:** `<slidra:chart>` and `<slidra:source>` (table data) use the same namespace but live **inside the element's `<g>` container**, not inside `<metadata>`.

### 5.1 Namespace declaration

Each `slidra:*` root element declares its own namespace:

```xml
<slidra:effects xmlns:slidra="https://slidra.app/ns/2026">
```

This is repeated per block rather than declared once on the `<svg>` root. This is the current behavior; a single root-level declaration is a planned simplification.

---

## 6. Effects

Effects are playback-time animations applied to elements. They are stored in the slide's `<metadata>`.

```xml
<slidra:effects xmlns:slidra="https://slidra.app/ns/2026">
  <slidra:effect target="el-abc" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>
  <slidra:effect target="el-def" family="emphasis" effect="pulse" start="with-previous"/>
</slidra:effects>
```

### 6.1 `slidra:effect` attributes

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | `string` | Yes | Element id (or group id) this effect applies to. |
| `family` | `string` | Yes | One of: `enter`, `emphasis`, `exit`, `path`, `media`. |
| `effect` | `string` | Yes | The specific effect within the family (see below). |
| `start` | `string` | Yes | Trigger: `on-click`, `with-previous`, `after-previous`. |
| `duration` | `number` | No | Seconds. Default: `0.6` (all families except `media`), `0` for `media`. |
| `delay` | `number` | No | Seconds. Default: `0`. |
| `d` | `string` | No | SVG path data. Only meaningful when `family="path"`. |

### 6.2 Effect families

| Family | Effects | Description |
|--------|---------|-------------|
| `enter` | `appear`, `fade`, `fly-up`, `fly-left`, `zoom` | Element appears. |
| `emphasis` | `pulse`, `spin`, `grow` | Element already visible; applies emphasis. |
| `exit` | `disappear`, `fade-out`, `zoom-out` | Element disappears. |
| `path` | `path` | Element follows an SVG path. |
| `media` | `play`, `pause` | Media playback control. |

### 6.3 Step grouping

Effects are grouped into **steps** for playback. The grouping rule:

- The first effect in the list **must** have `start="on-click"`. If it does not, the slide is considered corrupt.
- A new step begins at every effect with `start="on-click"`.
- Effects with `start="with-previous"` or `start="after-previous"` belong to the current step.

A step is the atomic unit of advancement during playback.

### 6.4 Duration/delay semantics

- An **absent** `duration`/`delay` attribute uses the default value.
- A **present but empty** attribute (e.g., `duration=""`) is invalid and will be rejected.

---

## 7. Transitions

Slide transitions are per-slide (not deck-wide). Each slide defines its own enter/exit behavior.

```xml
<slidra:transition xmlns:slidra="https://slidra.app/ns/2026"
                   enter="fade" enter-duration="0.3"
                   exit="none" exit-duration="0.5"/>
```

| Attribute | Values | Default |
|-----------|--------|---------|
| `enter` | `none`, `fade`, `slide`, `zoom` | `none` |
| `enter-duration` | non-negative number (seconds) | `0.6` |
| `exit` | `none`, `fade`, `slide`, `zoom` | `none` |
| `exit-duration` | non-negative number (seconds) | `0.5` |

At most one `<slidra:transition>` element per slide. Two or more is considered corrupt.

---

## 8. Fonts

Fonts are registered in `project.json` (see §2.3) and stored as files under `fonts/`.

- The SVG references fonts by `font-family` name only (e.g., `font-family="Noto Sans TC"`).
- The actual font file is resolved at render time by the runtime (e.g., Slidra's web viewer injects `@font-face` rules).
- When a slide SVG is opened standalone by an external tool (browser, Illustrator), the font falls back to the system font stack — pixel-identical rendering is not guaranteed. This is by design to avoid embedding the font (as base64) in every SVG, which would multiply storage cost by the number of slides.
- Multiple slides referencing the same font share one `FontEntry` and one font file.

---

## 9. Speaker Notes

Speaker notes are per-slide, invisible during the audience view, and visible only to the presenter.

```xml
<slidra:notes xmlns:slidra="https://slidra.app/ns/2026">
  Remember to introduce yourself first.
</slidra:notes>
```

- Content is plain text (XML-escaped).
- An empty string (`<slidra:notes></slidra:notes>`) clears the notes.
- Omitting the element entirely means "no notes" (equivalent to empty).

---

## 10. Annotations (Comments)

Annotations are one-line edit instructions attached to elements for an agent to act on. They are bundled with user messages sent to the agent.

```xml
<slidra:comments xmlns:slidra="https://slidra.app/ns/2026">
  <slidra:comment id="c-01" target="el-title" author="Alice"
                  created="2026-09-01T00:00:00.000Z">
    Should the title be bigger?
  </slidra:comment>
</slidra:comments>
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Opaque identifier. |
| `target` | `string` | Element id, or the literal string `page` (meaning the whole slide). |
| `author` | `string` | Optional. |
| `created` | `string` | ISO 8601 timestamp, set at creation, never modified. |

The element text content is the annotation text. `comment edit` changes only the text, never `created`.

---

## 11. Chart Container

Charts use the "exception shape" — a data element plus a rendered result combined in one container:

```xml
<g id="el-chart1" data-slidra-type="chart" transform="translate(691.2 115.2)">
  <slidra:chart xmlns:slidra="https://slidra.app/ns/2026"
                type="bar" stacked="false" axes="single"
                palette="brand" legend="bottom" grid="true" labels="true"
                x-title="" y-title="" width="480" height="320">
    <slidra:series name="Revenue" values="100,120,140" axis="left"/>
    <slidra:series name="Costs" values="80,90,95" axis="right"/>
    <slidra:categories values="Q1,Q2,Q3"/>
  </slidra:chart>
  <svg width="480" height="320" viewBox="0 0 480 320">
    <!-- rendered chart (SVG) -->
  </svg>
</g>
```

### 11.1 `slidra:chart` attributes

| Attribute | Values | Required |
|-----------|--------|----------|
| `type` | `bar`, `hbar`, `line`, `area`, `pie`, `donut` | Yes |
| `stacked` | `true`, `false` | No (default `false`; effective only for `bar`/`hbar`/`area`) |
| `axes` | `single`, `dual` | No (default `single`) |
| `palette` | `brand`, `cool`, `warm` | No |
| `legend` | `none`, `bottom`, `right` | No |
| `grid` | `true`, `false` | No |
| `labels` | `true`, `false` | No |
| `x-title` | string | No (empty = no title) |
| `y-title` | string | No |
| `width` | positive number | Yes |
| `height` | positive number | Yes |

### 11.2 Child elements

- **`<slidra:series>`** (one or more):
  - `name`: series label (string)
  - `values`: comma-separated numbers (e.g., `"100,120,140"`)
  - `axis`: `left` | `right` (default `left`)
  - `color`: optional `#RRGGBB` override
- **`<slidra:categories>`** (exactly one):
  - `values`: comma-separated strings (e.g., `"Q1,Q2,Q3"`)

### 11.3 Rendering

The embedded `<svg>` is the rendered chart. It is regenerated exclusively by the `chart` command family (`chart data set`, `chart type set`, `chart palette set`, etc.). Other commands (`element style set`, `element move`, etc.) do not modify the chart's internals. The bounding box is determined solely by the embedded `<svg>`'s `width`/`height`.

---

## 12. Table Container

Tables also use the "exception shape":

```xml
<g id="el-t1" data-slidra-type="table"
   data-slidra-cols="200 300 240"
   data-slidra-rows="44 40 40"
   data-slidra-header="1"
   data-slidra-theme="dark"
   transform="translate(100 100)">
  <slidra:source xmlns:slidra="https://slidra.app/ns/2026" src="assets/data/sales.csv"/>
  <g data-slidra-cell="0,0" transform="translate(0 0)">
    <rect x="0" y="0" width="200" height="44" fill="#EEEEEE"/>
    <text x="8" y="28" fill="#000000" font-weight="700"><tspan>Total</tspan></text>
  </g>
  <g data-slidra-cell="0,1" transform="translate(200 0)">
    <rect x="0" y="0" width="300" height="44" fill="#EEEEEE"/>
    <text x="8" y="28" fill="#000000" font-weight="700"><tspan>Q1</tspan></text>
  </g>
  <!-- ... -->
</g>
```

### 12.1 Container attributes

| Attribute | Description |
|-----------|-------------|
| `data-slidra-cols` | Space-separated column widths in px (e.g., `"200 300 240"`). |
| `data-slidra-rows` | Space-separated row heights in px. |
| `data-slidra-header` | `"1"` if the first row is a header; absent or `"0"` if not. |
| `data-slidra-theme` | `dark` \| `light` \| `zebra` (default `dark`). |

### 12.2 Data binding

The optional `<slidra:source>` element declares a CSV data source:

```xml
<slidra:source xmlns:slidra="https://slidra.app/ns/2026" src="assets/data/sales.csv"/>
```

- `src` is a container-relative path to a CSV file under `assets/`.
- At most one `<slidra:source>` per table.
- `table refresh` re-reads the CSV and regenerates cell contents.

### 12.3 Cell structure

Each cell is a `<g data-slidra-cell="row,col">` where `row` and `col` are 0-based indices.

| Cell attribute | Description |
|----------------|-------------|
| `data-slidra-cell` | `"row,col"` (0-based). |
| `data-slidra-span` | `"rowSpan,colSpan"` (optional; default `1,1`). |
| `data-slidra-repeat` | `"row"` — marks this cell's row as the template row for bound tables (paired with `display="none"`; at most one per table). |
| `data-slidra-generated` | `"1"` — content was auto-generated from CSV by `table bind`/`table refresh`. |
| `data-slidra-align` | `left` \| `center` \| `right` (default `left`). |

Cell content:
- `<rect>` — cell background (fill, optional `fill-opacity`).
- `<text><tspan>...</tspan></text>` — cell text (fill = text color, `font-weight` = weight).

### 12.4 Structural invariants

- The grid must be **fully covered** by cells (no gaps).
- Merged cell ranges (`data-slidra-span`) must **not overlap**.

---

## 13. Assets

Media files (images, video, audio, CSV data) live under `assets/` (and `assets/data/` for CSV files).

- Referenced from slides via container-relative paths (e.g., `href="../assets/photo.svg"`).
- The canvas renders a `<base>` tag so that relative paths resolve correctly in the browser.
- `asset import` assigns a numbered filename (e.g., `photo-1.png`, `video-2.webm`).
- `asset import --as csv` places the file under `assets/data/` with its own numbering.

---

## 14. Dynamic Text

Dynamic text placeholders are computed at render time:

| Placeholder | Value |
|-------------|-------|
| `{{ slide_number }}` | Current slide index (1-based). |
| `{{ slide_total }}` | Total number of slides. |
| `{{ presentation_name }}` | Value of `project.json.name`. |

These are substituted by `slide render` before output. In the stored SVG, they appear as literal `{{ ... }}` strings.

---

## 15. Templates

Templates are stored under `templates/` and registered in `project.json.templates`. A template is a complete slide SVG (same structure as slides). Applying a template copies it to a new slide; from that point, the original template and the new slide are independent.

---

## 16. `formatVersion`

- Current version: **5** (SQLite container, `spec/rfcs/0001-sqlite-container-format.md`). A ZIP-container deck legitimately sits at 1 through 4 until the next `slidra open` migrates it once; a `.slidra` file itself is never partially at one version and partially at another.
- A `project.json` with `formatVersion` greater than the version this build understands is rejected. A ZIP container additionally rejects any `formatVersion` outside 1–4 outright (no migration chain within the ZIP era either).
- Legacy CoMotion files (which also use `formatVersion: 1`) are detected by the presence of `xmlns:comot` or `co-motion.dev/ns` in any slide SVG and are rejected outright with an error message, at migration time. They are never migrated or partially read.

---

## 17. File naming and layout summary

The tree below is the entry set every `.slidra` file has, regardless of
container format — a ZIP archive's entries (`formatVersion` 1–4) or a
SQLite deck's `path` rows (`formatVersion` 5, `spec/rfcs/0001-sqlite-container-format.md`).

```
my-presentation.slidra
├── project.json
├── slides/
│   ├── 001.svg
│   ├── 002.svg
│   └── ...
├── assets/
│   ├── photo-1.png
│   ├── video-1.webm
│   └── data/
│       └── sales-1.csv
├── fonts/
│   ├── NotoSansTC-Presentation.ttf
│   └── LICENSE-NotoSansTC.txt
├── templates/          (optional)
│   └── 001.svg
└── plan/               (optional)
    ├── outline.md
    └── design-spec.md
```

---

## 18. Design principles

1. **Self-contained**: A `.slidra` file contains everything needed to render and play the presentation. No external dependencies beyond the fonts (which are embedded).
2. **Slide independence**: Swapping two slides requires touching no other file. Each SVG is a complete, self-contained unit.
3. **Flat addressing**: Elements are addressed by opaque ids (`el-…`), not by path or position. This makes addressing stable under reordering.
4. **SVG is the format**: Slides are SVG. The format does not layer a proprietary intermediate on top of SVG; the SVG *is* the artifact.
5. **Forward compatibility**: Unknown fields in `project.json` are preserved. Unknown `data-slidra-*` attributes on elements are preserved.
6. **No silent migration**: Format violations are rejected, not silently corrected.

---

## 19. Known implementation gaps

These are known current behaviors, not additional format requirements:

- `xmlns:slidra` is declared on each `slidra:*` metadata block rather than once on the SVG root.
- A slide may contain multiple `<metadata>` blocks; the reader and writer handle them, but this is not a deliberately designed format rule.
- A historical CoMotion clipboard namespace correction no longer applies: any legacy namespace marker is rejected under §2.7, never rewritten in place.
