# `.slidra` Format Specification

**Version:** 5 (container: SQLite, `spec/rfcs/0001-sqlite-container-format.md`)  
**Status:** Stable  
**Namespace:** `https://slidra.app/ns/2026`

A `.slidra` file is the canonical, self-contained container for a Slidra presentation. This document describes the file's internal shape — `project.json`, slide SVGs, assets, fonts, templates — independent of which container format currently carries them; §1 covers where that shape lives on disk for each format version.

> **`formatVersion` 5 changes the container itself, not just this document's version number.** [`spec/rfcs/0001-sqlite-container-format.md`](../../spec/rfcs/0001-sqlite-container-format.md) is authoritative for the SQLite container (schema, migration, concurrency, write granularity); §1 below describes both the current SQLite container (`formatVersion` 5) and the legacy ZIP container it replaced (`formatVersion` 1 through 4, read-only, migrated once on open). Every field/element/attribute rule elsewhere in this document — `project.json`'s shape, slide SVG structure, `<slidra:*>` elements — is unaffected by which container carries it.

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

### 1.3 Entry path validation

Neither container ever "extracts" onto a real directory tree — a `formatVersion` 5 deck's entries are `content` table rows read directly by path, and a legacy ZIP is read entirely into memory (`read_legacy_zip`) and used to build a brand-new SQLite deck in place; there is no step that writes loose files to disk under either format. Entry paths are still validated before being trusted, in both cases:

- No entry path may resolve outside the deck's own logical root (no absolute paths, no `..` segments).
- For a legacy ZIP being migrated, validation happens while reading it into memory: any invalid entry fails the whole read, and `migrate_legacy_zip_in_place` never begins writing the new SQLite deck — the file being migrated is left byte-for-byte untouched.
- Missing required directories (`slides/`, `assets/`, `fonts/`) are created automatically as explicit rows, for both a freshly created deck and a migrated one.

### 1.4 Undo/redo history tables ([E6.T6], `formatVersion` 5 only)

Three additional tables sit alongside `content` in the same SQLite file, created lazily (`CREATE TABLE IF NOT EXISTS`) the first time a deck's history is touched — a deck migrated from a legacy ZIP, or a fresh `new` deck, has none of these tables until then, and their absence is read as an empty undo/redo history, not a format error. They are not covered by `user_version`/`application_id` and packing (`slidra pack`) copies them like any other part of the file, which is the entire mechanism behind AC2 ("copying the deck file carries its undo history with it").

```sql
history_group(id INTEGER PRIMARY KEY, group_id TEXT NOT NULL,
              stack INTEGER NOT NULL,     -- 0=undo 1=redo 2=open group
              position INTEGER NOT NULL)  -- ascending oldest-to-newest within the same `stack` value
history_entry(id INTEGER PRIMARY KEY, group_rowid INTEGER NOT NULL,
              position INTEGER NOT NULL, virtual_path TEXT NOT NULL,
              snapshot_id TEXT)           -- NULL = this path did not exist before the edit
history_snapshot(snapshot_id TEXT PRIMARY KEY, data BLOB NOT NULL)
```

No `FOREIGN KEY`/`CASCADE` between the three — the Rust crate deletes rows explicitly, on its own eviction/finalize schedule. `group_rowid` references `history_group.id`.

Two caps apply to every push onto the `undo` array (via `redo`, or via a content edit outside an open group): at most 500 groups (`UNDO_STACK_CAP`), and at most 64 MiB of total `history_snapshot.data` bytes (`UNDO_SNAPSHOT_BYTES_CAP`, summed across the whole table — undo, redo, and any open group share the same budget). Exceeding either cap evicts the oldest undo group(s) and deletes the snapshot rows they orphaned, but never evicts the last remaining undo group even if it alone exceeds the byte cap — a single oversized snapshot is legal, not an error. `redo`'s own push (from `undo`) is not capped by either limit, so the actual worst-case total footprint is roughly 2x the byte cap.

The container's editing model (RFC 0001 §4: no `VACUUM`, no `auto_vacuum`) applies here too — trimming evicted history frees pages for reuse but does not shrink the file.

### 1.5 Chat history table ([E6.T7], `formatVersion` 5 only)

A `chat_history` table sits alongside `content` in the same SQLite file, so a conversation travels with the deck: copying the file copies the conversation, and reopening it later (on the same machine or another) reads the same history back. Like the undo/redo tables in §1.4, it is created lazily (`CREATE TABLE IF NOT EXISTS`), the first time a conversation actually appends an entry — a pure read never creates it, so a deck nobody has chatted in yet stays byte-for-byte whatever `new` or the legacy-ZIP migration produced.

```sql
chat_history(seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE,
             kind TEXT NOT NULL,   -- one of: author, agent, command, divider
             at TEXT NOT NULL, text TEXT NOT NULL, meta TEXT)
```

`kind` is validated against a fixed set on every write, never trusted from the caller: `author`/`agent` mirror who spoke, `command` is a `slidra` invocation the agent ran (its outcome folded into the row), and `divider` marks an agent switch or a "New chat" reset. `meta` carries a `command` entry's extra fields (`toolCallId`/`status`/`cli`/`output`/`blocked`) as an opaque JSON object, never inspected by this table's own reader/writer.

## 2. `project.json`

The presentation's root metadata file. UTF-8 encoded JSON.

### 2.1 Schema

```jsonc
{
  "formatVersion": 5,          // required, must equal the current FORMAT_VERSION (see §2.7)
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
| `formatVersion` | `number` | Yes | Must equal the crate's current `FORMAT_VERSION` (**5**). A lower value (1 through 4) is legal only inside a legacy ZIP container, migrated once on open — see §2.7. A value the running build does not understand is rejected. |
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

`formatVersion` doubles as both this JSON field and the deck file's SQLite `user_version` pragma (§1) — the two must always agree, since the field is validated on every read regardless of which pragma the container itself reports. The currently shipped `FORMAT_VERSION` is **5**, and `new` always produces a fresh deck at that version directly.

**Within a single container format, there is no migration chain.** A SQLite deck (`formatVersion` 5) with any other value is rejected immediately with an error — 5 is the only version this crate has ever produced as SQLite, so there is nothing between versions to migrate. A legacy ZIP deck (`formatVersion` 1 through 4) with a value outside that range is likewise rejected outright, with no ZIP-to-ZIP migration chain either.

**Across the two container formats, there is exactly one migration, and it runs once.** The first time `slidra open` sees a legacy ZIP deck (`formatVersion` 1–4), it migrates the file in place to a SQLite deck at `formatVersion` 5 (`migrate_legacy_zip_in_place`, §1) — the jump from 4 straight to 5 marks "this is a different container format," not a continuation of the old numbering. This is the one automatic, silent conversion the format allows; it never partially reads a file (validation failures abort the migration before any new bytes are written, leaving the original untouched, §1.3) and it never runs a second time on a deck already at 5.

Legacy CoMotion files are rejected outright, even though they can also carry `formatVersion: 1`. A slide containing `xmlns:comot` or `co-motion.dev/ns` is recognized as legacy content and the entire file is rejected at migration time; Slidra never migrates or partially reads it.

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
6. **No silent correction of format violations**: an invalid `project.json`, an out-of-range `formatVersion`, or a rejected CoMotion marker is an explicit error, never silently patched. The one exception this principle does not cover is a *container* change, not a violation: a legacy ZIP deck (`formatVersion` 1–4) is migrated once, automatically, to the SQLite container at `formatVersion` 5 the first time `slidra open` sees it (§2.7) — every field and structural rule in this document is unaffected, only the bytes on disk change shape.

---

## 19. Known implementation gaps

These are known current behaviors, not additional format requirements:

- `xmlns:slidra` is declared on each `slidra:*` metadata block rather than once on the SVG root.
- A slide may contain multiple `<metadata>` blocks; the reader and writer handle them, but this is not a deliberately designed format rule.
- A historical CoMotion clipboard namespace correction no longer applies: any legacy namespace marker is rejected under §2.7, never rewritten in place.
