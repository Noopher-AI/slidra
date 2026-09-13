# `.slidra` File Format Specification

## Status of this document

This document is the implementation-facing reference for the `.slidra` container format and the `~/.slidra/` (`SLIDRA_HOME`) workspace layout: how the Rust CLI enforces the format, the exact byte-level rules, and the on-disk workspace layout. The public, human-readable format specification lives at [`docs/spec/slidra-format.md`](slidra-format.md); where the two disagree, the public spec wins and this document should be updated. The CLI command reference lives at [`docs/spec/cli.md`](cli.md).

Rust is the sole implementation; this document records structural facts the code must honor. `FORMAT_VERSION` is **1** (`crates/slidra/src/presentation.rs`), and there is no migration chain: a `project.json` whose `formatVersion` is anything other than 1 is rejected outright when the presentation is opened. A `.slidra`/`.comot` file produced by the old CoMotion format is not migrated either — it is rejected outright by a container-level guard (see "`formatVersion`" below).

## Container layout

`.slidra` is a zip file with no contract on compression level (the current implementation uses the `zip`/`flate2` crates' `Deflated` method; compression level is an implementation choice, not part of the format).

Required directories — `slides/`, `assets/`, and `fonts/` must each have their own entry in the zip even when they hold no files (an empty-directory entry). These three directory names are fixed: `pack` guarantees they exist, and `unpack`/`open` creates any that are missing.

Other locations that may appear:

- `templates/`: optional. Templates (produced by `template add`) are structured like `slides/` — one `.svg` per template, filename format not mandated (the current implementation uses a sequence number, e.g. `templates/001.svg`).
- `assets/data/`: where `asset import --as csv` data assets land — a subdirectory shared with general media under `assets/`, with its own numbering space independent of the media files directly under `assets/`.

Unpack safety rule (`unpack_container`, `crates/slidra/src/container.rs`): **validate everything first, then write**. Every entry path in the zip that ends up outside the target directory once resolved — an absolute path, or one containing a `..` segment that would escape the target directory — causes the entire archive to be rejected: no partial unpack, no path sanitization, no attempt at correction. If any step fails (an illegal entry path, a missing or malformed `project.json`, an unsupported `formatVersion`, or a legacy-CoMotion slide), the target directory that was already being written is removed entirely — no half-unpacked state is left behind.

## `project.json`

The one metadata file of `.slidra`, UTF-8 JSON. Fields, per `validate_project_json` (`crates/slidra/src/workspace/project.rs`):

| Field | Type | Required? | Validation |
|---|---|---|---|
| `formatVersion` | `number` | required | must be a `number` equal to `FORMAT_VERSION` (currently 1); any other value or type is rejected at open with `project.json 格式錯誤：formatVersion 必須是 1` |
| `name` | `string` | required | must be a `string` |
| `canvas` | `{ width: number; height: number }` | required | object; both `width` and `height` must be `number` |
| `slides` | `string[]` | required | must be an array whose every item is a string (a virtual path); an empty array (`[]`) is structurally valid — "no slides yet" is a legitimate state for a presentation |
| `fonts` | `FontEntry[]` | optional | when present, must be an array of `FontEntry` objects; each `FontEntry` is `{ file, family, license, licenseFile, source }`, all five fields must be `string`; `file`/`licenseFile` must not start with `/` or contain a `..` path segment; `family` must not repeat within the array |
| `templates` | `(string \| TemplateEntry)[]` | optional | when present, must be an array; each entry may be either a bare string (pre-normalization shape) or a `{ file, name }` object — a mix of both in the same array is valid, not an error; `file` is subject to the same absolute-path/`..` ban; `name` must be a string when the entry is an object |
| `transition` | `string` | optional | when present, must be a `string`; any string value is accepted — the field carries no special legacy meaning and nothing reads it |

`TemplateEntry` = `{ file: string; name: string }` (`file` is the virtual path inside the container; `name` is the user-visible display name, and may repeat across entries).

`FontEntry` = `{ file: string; family: string; license: string; licenseFile: string; source: string }` (see "`fonts/`" below).

A `project.json` may omit `fonts` and `templates` entirely — both are genuinely optional keys, not merely "may be empty." When a slide/template-mutating command writes `project.json` back (`write_project`), it defaults a missing `fonts` key to `[]` and normalizes any bare-string `templates` entries to the `{ file, name }` shape, but neither addition is required for a file to be read.

**Unknown fields are always preserved, never rejected** (forward compatibility): an older build opening a `project.json` written by a newer one, with fields it doesn't recognize, does not error out over the extra fields.

**Frozen write format**: `serde_json`'s pretty printer with 2-space indentation plus exactly one trailing newline — i.e., `JSON.stringify(value, null, 2) + "\n"`'s Rust equivalent; the original key order is preserved (`serde_json`'s `preserve_order` feature plus 2-space indentation).

## `slides/` and `templates/`

Each `.svg` file is itself the finished artifact, not an intermediate format meant to be converted further (ADR-0001). Editable elements are wrapped in `<g id="el-…" data-slidra-name="…">` containers (ADR-0012); a bare element (a `<text>` etc. not wrapped in a `<g>`) is considered non-conforming.

- **Element id format**: an `el-` prefix plus a 12-character base64url string (`generateOpaqueId()`: 9 random bytes, base64url-encoded to exactly 12 characters; `generateElementId()` adds the `el-` prefix). Generated from pure randomness — the id itself never decodes to any path or meaning (ADR-0004).
- **Two known exceptions to the container shape** (ADR-0012 amendment): chart containers and table containers are not "a `<g>` wrapping one or more elements" but each a data element plus a rendered result combined — see "Chart container" and "Table container" below.

Full `data-slidra-*` attribute table (the complete set currently used in the repo, per `grep -rhoP 'data-slidra-[a-zA-Z-]+' crates/slidra/src`):

| Attribute | Where used | Meaning |
|---|---|---|
| `data-slidra-name` | every element container `<g>` | user-visible display name (`element name set`); does not affect the id |
| `data-slidra-type` | chart/table container `<g>` | marks which exception shape the container follows; current values are `chart`, `table` |
| `data-slidra-lock` | element container `<g>` | lock state (`element lock`/`unlock`); `--force` bypasses the lock on write |
| `data-slidra-clipboard` | internal use | marker attribute for the clipboard's serialized exchange format |
| `data-slidra-media` | media elements (image/video/audio) | marks the kind of media the element carries |
| `data-slidra-embed` | media elements | whether embedded (per `element insert`'s `--embed`) |
| `data-slidra-source` | internal use | tracks the origin marker of a piece of content |
| `data-slidra-list` | paragraph `<tspan>`/text node | list style (`text list set`): `bullet`/`number`/`none` |
| `data-slidra-list-marker` | list item | the actual rendered marker text for that item (e.g. `•`, `1.`) |
| `data-slidra-text-align` / `data-slidra-text-width` / `data-slidra-text-height` | text box | cache/marker attributes for text box layout computation |
| `data-slidra-break` | `<tspan>` | marks that this tspan is followed by a "hard break" (the original text had `\n`), distinguishing it from a soft wrap (displayed as a new line but with no `\n` in the source) |
| `data-slidra-type="table"`, `data-slidra-cols`, `data-slidra-rows`, `data-slidra-header`, `data-slidra-theme` | table container `<g>` | see "Table container" below |
| `data-slidra-cell`, `data-slidra-span`, `data-slidra-repeat`, `data-slidra-generated`, `data-slidra-align` | table cell `<g>` | see "Table container" below |

(This table reflects attributes actually used by the current code; the precise validation rule for each attribute is authoritatively defined in the corresponding `crates/slidra/src` module — `element/text.rs`, `element/edit.rs`, `table/model.rs`, `chart/model.rs`. This table is an overview, not a complete restatement of every attribute's validation rule.)

### Background image element

A slide has at most one top-level container carrying `data-slidra-role="background"`: fixed `id="el-background"`, `data-slidra-name="Background image"`, `data-slidra-lock="true"`, whose content is a full-bleed `<image href="../assets/…" x="0" y="0" width="<canvas width>" height="<canvas height>" [opacity]>`, positioned after `<metadata>` and before all other elements (the bottom-most layer). Written/replaced/removed by `slide background set`; content passed to `slide add --svg`/`slide set --svg` that already contains this container is kept as-is and re-locked. `validate` applies no geometry, style, or forbidden-pattern rules to it — its presence is only used to decide whether `structure.scrim` is checked.

## `slidra:*` inside `<metadata>`

**Only these tags live inside an `<svg>`'s `<metadata>` child**: `slidra:effects` (wrapping `slidra:effect`), `slidra:transition`, `slidra:notes`, `slidra:comments` (wrapping `slidra:comment`). The namespace URI is uniformly `https://slidra.app/ns/2026` (the `EFFECTS_NS`, `NOTES_NS`, `TRANSITION_NS`, and `COMMENTS_NS` constants all hold this same literal value).

> The chart's `<slidra:chart>` (wrapping `slidra:series`, `slidra:categories`) and the table's `<slidra:source>` are also named `slidra:*` and use the same namespace, but **do not live inside `<metadata>`** — they hang directly under the chart's/table's own `<g>` container (the exception shape from the ADR-0012 amendment). It's easy to misread this as "all ten tags live under `<metadata>`" — that isn't the case; see "Chart container" and "Table container" below.

### `<slidra:effects>` / `<slidra:effect>`

```xml
<metadata>
  <slidra:effects xmlns:slidra="https://slidra.app/ns/2026">
    <slidra:effect target="el-p5-b" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>
  </slidra:effects>
</metadata>
```

`slidra:effect` attribute table:

| Attribute | Type/value domain | Required? |
|---|---|---|
| `target` | string, the id of some element (or group `<g>`) within the same slide | required |
| `family` | `enter \| emphasis \| exit \| path \| media` | required |
| `effect` | a fixed list depending on `family`: `enter` → `appear \| fade \| fly-up \| fly-left \| zoom`; `emphasis` → `pulse \| spin \| grow`; `exit` → `disappear \| fade-out \| zoom-out`; `path` → `path`; `media` → `play \| pause` | required |
| `start` | `on-click \| with-previous \| after-previous` | required |
| `duration` | non-negative seconds | optional; when absent defaults to `0` for the `media` family, `0.6` for all others |
| `delay` | non-negative seconds | optional; defaults to `0` when absent |
| `d` | SVG path syntax string | only meaningful when `family="path"`; preserved verbatim whenever present in the XML, never validated or interpreted (kept as-is even when it appears on another family) |

A `duration`/`delay` attribute that is **present but an empty string** (e.g. `duration=""`) is an invalid duration; only an **absent** attribute takes the default value — these are two different things. The first item in the list must have `start="on-click"`, otherwise the presentation is considered corrupt.

### `<slidra:transition>`

```xml
<metadata>
  <slidra:transition xmlns:slidra="https://slidra.app/ns/2026"
                     enter="fade" enter-duration="0.3" exit="none" exit-duration="0.5"/>
</metadata>
```

A slide's `<metadata>` has at most one `<slidra:transition>`; two or more is considered a corrupt presentation. Attributes: `enter`/`exit` ∈ `none | fade | slide | zoom`; `enter-duration`/`exit-duration` are non-negative seconds. **Defaults when absent** (no `<slidra:transition>` element, or the element exists but an individual attribute is absent): `enter: { effect: "none", duration: 0.6 }`, `exit: { effect: "none", duration: 0.5 }`.

### `<slidra:notes>`

```xml
<metadata>
  <slidra:notes xmlns:slidra="https://slidra.app/ns/2026">Remember to introduce yourself first</slidra:notes>
</metadata>
```

Plain text content (XML-escaped); an empty string is the valid way to clear speaker notes (not the same as omitting the element).

### `<slidra:comments>` / `<slidra:comment>`

```xml
<metadata>
  <slidra:comments xmlns:slidra="https://slidra.app/ns/2026">
    <slidra:comment id="c-01" target="el-p1-title" author="Author" created="2026-09-01T00:00:00.000Z">Should the title on this page be bigger?</slidra:comment>
  </slidra:comments>
</metadata>
```

`slidra:comment` attributes: `id` (opaque string), `target` (an element id, or the literal value `page` meaning the whole page), `author` (optional), `created` (ISO 8601 timestamp, generated at write time and never changed afterward — `comment edit` changes only the content, not `created`). The element's content is the comment text itself.

## Chart container

The first exception shape from the ADR-0012 amendment: a `data-slidra-type="chart"` container holds exactly one `<slidra:chart>` (the data) plus one embedded rendered-result `<svg>` (the picture) — not "one or more elements."

```xml
<g id="el-chart1" data-slidra-type="chart" transform="translate(691.2 115.2)">
  <slidra:chart xmlns:slidra="https://slidra.app/ns/2026"
               type="bar" stacked="false" axes="single" palette="brand"
               legend="bottom" grid="true" labels="true"
               x-title="" y-title="" width="480" height="320">
    <slidra:series name="Revenue" values="100,120,140" axis="left"/>
    <slidra:categories values="Q1,Q2,Q3"/>
  </slidra:chart>
  <svg width="480" height="320" viewBox="0 0 480 320">...</svg>
</g>
```

`<slidra:chart>` attributes: `type` ∈ `bar|hbar|line|area|pie|donut`; `stacked` ∈ `true|false` (a literal string; stacking has real effect only for the `bar|hbar|area` types); `axes` ∈ `single|dual`; `palette` ∈ `brand|cool|warm`; `legend` ∈ `none|bottom|right`; `grid`/`labels` ∈ `true|false`; `x-title`/`y-title` are strings (absent treated as empty string); `width`/`height` are required positive numbers. Child nodes: one or more `<slidra:series>` (`name` string, `values` a comma-separated number list, `axis` ∈ `left|right`, `color` optional `#RRGGBB`); exactly one `<slidra:categories>` (`values` a comma-separated string list). `<slidra:chart>` contributes nothing to `getBBox()`; the element's bounding box is determined solely by the embedded `<svg>`'s `width`/`height`, the rendered result is only ever redrawn by the `chart` command family, and other commands (`element style set`, etc.) all refuse to touch this container's internals directly.

## Table container

The second exception shape from the ADR-0012 amendment: a `data-slidra-type="table"` container holds an optional `<slidra:source>` (data-binding declaration) plus multiple `<g data-slidra-cell="r,c">` cells — **there is no dedicated `<slidra:table>` element**.

```xml
<g id="el-t1" data-slidra-type="table" data-slidra-cols="200 300 240"
   data-slidra-rows="44 40" data-slidra-header="1" data-slidra-theme="dark"
   transform="translate(x y)">
  <slidra:source xmlns:slidra="https://slidra.app/ns/2026" src="assets/data/sales.csv"/>
  <g data-slidra-cell="0,0" transform="translate(0 0)">
    <rect x="0" y="0" width="200" height="44" fill="#EEEEEE"/>
    <text x="8" y="28" fill="#000000" font-weight="700"><tspan>Total</tspan></text>
  </g>
  ...
</g>
```

Container attributes: `data-slidra-cols`/`data-slidra-rows` are space-separated lists of positive numbers (column widths/row heights, in user units); `data-slidra-header = "1"` means there is a header row; `data-slidra-theme` ∈ `dark|light|zebra` (defaults to `dark` when absent). `<slidra:source>` is optional; when present, `src` is the virtual path of a CSV file under `assets/` (the source bound by `table bind`; `table refresh` reads it to refresh the table); a table container has at most one `<slidra:source>`.

Cells, `<g data-slidra-cell="row,col">`: `row`/`col` are 0-based; `data-slidra-span="rowSpan,colSpan"` is optional (absence is equivalent to `1,1`); `data-slidra-repeat="row"` marks this as a bound table's template row (always paired with `display="none"`; a table has at most one template row); `data-slidra-generated="1"` marks that this cell's content was auto-generated from CSV by `table bind`/`table refresh`; `data-slidra-align` ∈ `left|center|right` (defaults to `left` when absent). Text content lives in `<text><tspan>...</tspan></text>`; a cell's fill color is the `<rect>`'s `fill` (`none` or `#RRGGBB`) plus an optional `fill-opacity` (0 to 1); text color is the `<text>`'s `fill` (must be `#RRGGBB`); font weight is the `<text>`'s `font-weight` (a multiple of 100, from 100 to 900). **The table grid must be fully covered by cells with no gaps, and merged ranges must not overlap** (a structural invariant of `validateTableModel`).

## `plan/`

`plan/` is the presentation's own plan-file directory (ADR-0018), with two fixed filenames: `plan/outline.md` (status `status: draft|confirmed`, narrative mode, per-page `pages`, `questions` for the author, an optional `animation`) and `plan/design-spec.md` (`density`, the six-role `palette`, `type_scale`, an optional `visual`). Each file starts with a ```` ```json ```` fence — the machine-readable segment, parsed and field-validated before `plan set` writes it — followed by markdown prose meant for humans and agents. It can only be written via `plan set|list|delete` and read via `cat`; a plan is not slide content and does not enter the undo history. The directory may not exist.

### A text-box declaration is not a storage shape

`slide add --svg`/`slide set --svg` accepts one **input form**: a bare `<text>` placed directly under the root `<svg>`, carrying `data-slidra-text-width` (content split into paragraphs by newlines, may carry `data-slidra-list`, `data-slidra-text-align`). On write, this is always converted into the real text-box structure described in "`slides/`" (`<g data-slidra-text-width data-slidra-text-height transform>` wrapping `<text>` and `<tspan>`); a `.slidra` file never stores a bare `<text>` carrying `data-slidra-text-width`.

## `fonts/`

`project.json.fonts` registers which fonts a presentation embeds. `FontEntry` has five fields: `file` (a path relative to the container root, e.g. `fonts/NotoSansTC-Presentation.ttf`; must not start with `/` or contain `..`), `family` (the value referenced by SVG's `font-family`; the unique key within this presentation, must not repeat), `license` (a human-readable license name), `licenseFile` (a container-relative path to the full license text), and `source` (where the font came from). When the same font is referenced by multiple slides, they share one `FontEntry` rather than duplicating the font file itself; the SVG only stores the `font-family` string reference.

**Degradation when a single SVG is opened standalone** (ADR-0016 decision 2): `@font-face` is only injected, via internal routing, inside Slidra's own wrapper document. When opened by an external tool (a browser opening the file directly, Illustrator, etc.), `font-family` falls back to that environment's system font per normal CSS font-stack rules — the layout doesn't break, but pixel-identical rendering with what Slidra shows is not guaranteed. This is a deliberate decision, not a defect: base64-embedding a font's `@font-face` into every SVG would multiply an N-page presentation's font storage cost by N.

## `formatVersion`

`FORMAT_VERSION` (`crates/slidra/src/presentation.rs`) is **1** — the value this spec settles on. `new` produces `formatVersion: 1` directly, and `validate_project_json` (`crates/slidra/src/workspace/project.rs`) requires a `project.json`'s `formatVersion` to equal exactly `FORMAT_VERSION`; any other value — including anything that looks like a future or historical CoMotion version — is rejected outright at open with:

```
project.json 格式錯誤：formatVersion 必須是 1
```

**There is no migration chain.** No version-to-version upgrade path exists in this codebase — nothing analogous to a `workspace/migrate.rs` module — and none is planned; a `project.json` that isn't already at `formatVersion: 1` in the current shape simply fails to open.

**Old CoMotion-format files are rejected outright, not migrated.** Format version 1 happens to be shared by both the old CoMotion format and the new Slidra format, so the version number alone can't distinguish them. Instead, `unpack_container` (`crates/slidra/src/container.rs`) runs `assert_no_legacy_comotion_slides` on every slide SVG after unpacking: if any slide's content contains the string `xmlns:comot` or `co-motion.dev/ns` — markers only an old CoMotion-format file would carry — the whole presentation is rejected with:

```
this presentation was made by CoMotion and is not supported by Slidra: <path>
```

This is a hard rejection, not a compatibility parse: the content is never interpreted, converted, or partially trusted. A caller with an old `.slidra`/`.comot` file needs to recreate the presentation under the current format; nothing here reads or repairs it.

## `~/.slidra/` (`SLIDRA_HOME`)

`resolveSlidraHome()`'s resolution rule: use `SLIDRA_HOME` from the environment if set, otherwise default to `~/.slidra`; **the environment variable is re-read on every call, never cached** (tests can point it at a temp directory).

```
<SLIDRA_HOME>/
├── projects.json              # registry file
├── work/<id>/                 # unpacked work directory (= .slidra's contents)
├── history/<id>/
│   ├── stack.json
│   └── snapshots/<snapshotId> # raw bytes, no encoding conversion of any kind
└── clipboard/<id>.json        # one per id; this file layout is the entire "paste only within the same presentation" mechanism
```

Four locations are listed here, all required: `projects.json`, `work/<id>/`, `history/<id>/`, `clipboard/<id>.json`.

### `projects.json`

The registry file, keyed by opaque presentation id, whose value is a `RegistryEntry`:

```ts
interface RegistryEntry {
  workDir: string;       // the actual path corresponding to work/<id>/
  sourcePath?: string;   // the .slidra path most recently read by open or "reopen in place"; older registry entries may lack this field
  savedAt?: number;      // a reading of the work directory's mtime snapshot, not Date.now() — see below
}
```

`savedAt` is deliberately not a `Date.now()` timestamp: comparing two different clock sources (`Date.now()` and filesystem `mtime`) can misjudge on some filesystems due to differing resolution, so this instead compares two `stat`-based readings taken the same way, eliminating cross-clock error.

Write method: the whole registry is serialized to a temp file in the same directory (`.projects.json.<12 hex>.tmp`) first, then `rename`d over the real file on success — `rename` is atomic on the same filesystem, so a mid-write failure or a full disk never leaves `projects.json` half-written. Only "file does not exist" (ENOENT) is treated as "the registry is still empty"; any other read failure (corrupt JSON, permission error, any I/O error) is reported explicitly rather than silently treated as an empty registry — silently treating it as empty would make every already-opened presentation vanish overnight.

### `history/<id>/stack.json`

```jsonc
{
  "undo": [ { "groupId": "…", "entries": [ { "virtualPath": "slides/001.svg", "snapshotId": "…" } ] } ],
  "redo": [ /* same shape as above */ ],
  "openGroup": null            // or a HistoryGroup (an in-progress, not-yet-committed group)
}
```

Three top-level keys are fixed: `undo`, `redo`, `openGroup` — missing any of them means the file is considered corrupt (only "file does not exist" reads as an empty stack). `HistoryGroup` = `{ groupId: string; entries: HistoryEntry[] }`; `HistoryEntry` = `{ virtualPath: string; snapshotId: string | null }`. A `null` `snapshotId` means this entry records that path's **creation** (e.g. newly imported media); undoing it means **deleting that file**, not restoring some prior content, because the path didn't exist before creation. When `snapshotId` is non-null, its value is an id produced by `generateOpaqueId()` (the same generator, exactly 12 base64url characters), corresponding to a raw-bytes snapshot under `history/<id>/snapshots/<snapshotId>`.

Written the same way as `projects.json`: temp file plus atomic `rename`, content being the equivalent of `JSON.stringify(stack, null, 2) + "\n"`. Reading does full structural validation; only ENOENT reads as an empty stack, and any other case (corrupt JSON, missing key, wrong type, I/O error) is treated as "the undo history is corrupt" and reported as an error, with no attempt at partial reading or repair.

`UNDO_STACK_CAP = 50`: once the undo stack exceeds 50 groups, the oldest group is discarded, along with every snapshot file it references, to keep it from growing without bound (there is no "close presentation" action to trigger cleanup, so this cap is the only backstop).

### `clipboard/<id>.json`

One independent file per presentation id, living outside `work/<id>/` (packing a `.slidra` never includes clipboard content). This "one file per id" layout is itself the complete implementation of the "paste only within the same presentation" rule — there is no extra check code; pasting simply reads this file, and nothing to read means nothing to paste.

## Known gaps (not fixed by this spec; documented as current state and reasoning)

These are known, deliberately-not-yet-fixed states in the current code. Rust **preserves the current behavior** rather than fixing it as part of this spec:

- **`xmlns:slidra` is declared per block, not once at the `<svg>` root.** Each `slidra:*` root block (`<slidra:effects>`, `<slidra:transition>`, `<slidra:notes>`, `<slidra:comments>`, `<slidra:chart>`, `<slidra:source>`) carries its own `xmlns:slidra="https://slidra.app/ns/2026"` declaration, rather than a single shared declaration on the `<svg>` root element.
- **A single SVG may have multiple `<metadata>` blocks.** The current read/write logic permits this and handles it, but it isn't a deliberately designed rule — just the current state.
- **A legacy namespace mistake used to be corrected in place; this is now moot.** An old `element-clipboard.ts` paste path once wrote an incorrect `xmlns:comot="https://schemas.comotion.app/effects"` (the correct old CoMotion value was `https://co-motion.dev/ns`), and a read-side fixup detected the wrong value (or its absence) and rewrote it to the correct one in place. That correction logic never existed in Rust and is no longer relevant: any slide SVG containing an old CoMotion namespace marker — `xmlns:comot`, or the literal string `co-motion.dev/ns`, correct or historically broken alike — is now rejected outright by `assert_no_legacy_comotion_slides` (see "`formatVersion`" above), never silently corrected or migrated.
