# `slidra` Command Reference

This file covers every command currently registered in the `slidra` CLI: name, parameters, a one-line purpose, and an example. The editing spec only demonstrates quoting syntax for a few commands (`text set`, `comment list`) as format examples; for everything else, consult this file.

The full rules for parameter syntax (quoting, comma-separated lists, etc.) are in the editing spec's "How to Write Command Parameters" section and are not repeated here. `<presentation-id>` is always the only presentation identifier you have available.

## asset import

**Parameters** `<presentation-id>` `<source>` (local file path, resolved relative to the CLI process's working directory; or an `http(s)://` URL), `--as csv` (optional, declares this is a data asset rather than media); or alternatively `--svg '<SVG markup>'` and `--name <filename.svg>` (creates an SVG asset from command-line content, mutually exclusive with `<source>`, `--name` allows only alphanumerics, underscores, and hyphens; fails if a file with the same name already exists).
**Usage** Import an image/video/audio (or a data table when declared with `--as csv`) into the presentation's `assets/` directory, or write an SVG directly via `--svg` (e.g. a background recipe).
**Example** `slidra asset import <presentation-id> --svg '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">…</svg>' --name bg-mesh.svg`

## cat

**Parameters** `<presentation-id>` `<path>`.
**Usage** Read the full contents of a virtual path — an alternative to reading the file directly.
**Example** `slidra cat <presentation-id> slides/001.svg`

## chat-history

**Parameters** `<presentation-id>` `--limit <n>` (optional, 1-1000, default 20) `--query <text>` (optional, must not be empty).
**Usage** Read back this conversation's history, persisted in the presentation's own file — the most recent entries, or only those matching `--query` (case-insensitive substring). Use this to recall earlier turns you were not present for (e.g. right after taking over from another agent), or anything past what your own context window still holds.
**Example** `slidra chat-history <presentation-id> --limit 50` or `slidra chat-history <presentation-id> --query "Q3 revenue"`

## chart axis set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `single|dual`, `--right <series-name>` (repeatable; only applies when mode is `dual`, specifying which series plot on the right axis).
**Usage** Switch the chart's axis mode.
**Example** `slidra chart axis set <presentation-id> slides/001.svg el-1 dual --right Revenue`

## chart create

**Parameters** `<presentation-id>` `<slide-path>`, `--type`, `--series`, `--categories`, `--palette`, `--x`, `--y`, `--width`, `--height` (all optional).
**Usage** Add a chart element to a slide.
**Example** `slidra chart create <presentation-id> slides/001.svg --type bar --x 100 --y 100 --width 400 --height 300`

## chart data set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>`, data source one of three: `--categories <c1,c2,...>` with one or more `--series 'name=v1,v2,...'`; or `--csv <local CSV file path>`; or `--csv-asset <virtual path to CSV under assets/>`.
**Usage** Set the chart's categories and series data.
**Example** `slidra chart data set <presentation-id> slides/001.svg el-1 --categories Q1,Q2,Q3 --series 'Revenue=100,120,140'`
> `--csv` reads a local filesystem path (not embedded CSV text). The agent cannot write files, so this flag is practically only useful to the user or Slidra itself; the agent should always use `--categories`/`--series`.

## chart legend set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<legend>`.
**Usage** Set the chart legend's display position.
**Example** `slidra chart legend set <presentation-id> slides/001.svg el-1 bottom`

## chart option set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<key>` `<value>`.
**Usage** Set a single custom chart option (key-value pair).
**Example** `slidra chart option set <presentation-id> slides/001.svg el-1 showGrid true`

## chart palette set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<palette>`, `--color 'name=#RRGGBB'` (repeatable, overrides individual series colors).
**Usage** Set the chart color scheme.
**Example** `slidra chart palette set <presentation-id> slides/001.svg el-1 default --color 'Revenue=#3366FF'`

## chart stack set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `on|off`.
**Usage** Toggle whether the chart displays in stacked mode.
**Example** `slidra chart stack set <presentation-id> slides/001.svg el-1 on`

## chart type set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<type>`.
**Usage** Switch the chart type (e.g. bar, line).
**Example** `slidra chart type set <presentation-id> slides/001.svg el-1 line`

## comment add

**Parameters** `<presentation-id>` `<slide-path>` `<target>` (element id or `page`) `<text>`, `--author` (optional).
**Usage** Add a comment to an element or the whole slide.
**Example** `slidra comment add <presentation-id> slides/001.svg page 'Should the title on this page be bigger?'`

## comment delete

**Parameters** `<presentation-id>` `<slide-path>` `<comment-id>`.
**Usage** Delete an existing comment.
**Example** `slidra comment delete <presentation-id> slides/001.svg c-1`

## comment edit

**Parameters** `<presentation-id>` `<slide-path>` `<comment-id>` `<text>`.
**Usage** Modify the content of an existing comment.
**Example** `slidra comment edit <presentation-id> slides/001.svg c-1 'Already fixed'`

## comment list

**Parameters** `<presentation-id>` `[slide-path]` (omit to list comments across all slides).
**Usage** List comments.
**Example** `slidra comment list <presentation-id> slides/001.svg`

## convert

**Parameters** `<presentation-id>`.
**Usage** Convert the entire presentation to the current format spec (all-or-nothing; there is no single-slide or dry-run form).
**Example** `slidra convert <presentation-id>`
> This command is used by the user or Slidra itself; the agent typically does not need it.

## deck list

**Parameters** `<dir-or-file>` (a real filesystem path, not a `<presentation-id>`), `--owner <owner>` (optional; filters to an exact match).
**Usage** Scans a folder for `.slidra` files (or describes a single one) without opening any of them — file name, display name, slide count, and owner.
**Example** `slidra deck list ~/Slidra --owner alice`
> This command's first argument is a real filesystem path, which the agent's own permission gate refuses regardless of this document (ADR-0019: any `.slidra` container, or anything under `<SLIDRA_HOME>`, is blocked). Listed here only for `docs/spec/cli.md` parity — the agent cannot actually run it.

## deck meta set

**Parameters** `<deck-path>` (a real filesystem path, not a `<presentation-id>`), `--name <name>` (optional), `--owner <owner>` (optional; at least one of the two is required).
**Usage** Overwrites `project.json`'s `name`/`owner` fields directly by file path, ahead of the deck ever being registered.
**Example** `slidra deck meta set ~/Slidra/Q3.slidra --owner alice`
> Same caveat as `deck list` above: its first argument is a `.slidra` path, which the agent's own permission gate refuses (ADR-0019). Listed here only for `docs/spec/cli.md` parity.

## font import

**Parameters** `<presentation-id>` `<source-path-or-url>`, `--family <family-name>`, `--license <license>`, `--source <origin>` (all three flags required), `--license-file <path-or-url>` (optional).
**Usage** Embed a font file into the presentation so that `--font-family` can use this family name going forward. Family names must be unique within a presentation; the file name is derived from the family name.
**Example** `slidra font import <presentation-id> https://fonts.example.org/NotoSerifTC-Regular.otf --family 'Noto Serif TC' --license 'SIL Open Font License 1.1' --source 'https://fonts.google.com/noto/specimen/Noto+Serif+TC'`

## effect add

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated), `--family <enter|emphasis|exit|path|media>`, `--effect <effect-name>`, `--start <on-click|with-previous|after-previous>` (optional), `--duration`, `--delay`, `--d`, `--index` (all optional).
**Usage** Add an animation effect to one or more elements.
**Example** `slidra effect add <presentation-id> slides/001.svg el-1 --family enter --effect fade`

## effect list

**Parameters** `<presentation-id>` `<slide-path>`.
**Usage** List all effects on a slide's elements (in playback order).
**Example** `slidra effect list <presentation-id> slides/001.svg`

## effect move

**Parameters** `<presentation-id>` `<slide-path>` `<index>` (1-based) `up|down`.
**Usage** Adjust an effect item's position in the playback order.
**Example** `slidra effect move <presentation-id> slides/001.svg 2 up`

## effect remove

**Parameters** `<presentation-id>` `<slide-path>` `<indices>` (1-based, comma-separated).
**Usage** Remove one or more effect items.
**Example** `slidra effect remove <presentation-id> slides/001.svg 1,3`

## effect set

**Parameters** `<presentation-id>` `<slide-path>` `<index>` (1-based), `--effect`, `--start`, `--duration`, `--delay`, `--d` (all optional). `--duration`/`--delay`/`--d` are in seconds.
**Usage** Modify parameters of an existing effect item.
**Example** `slidra effect set <presentation-id> slides/001.svg 1 --duration 0.5`

## element align

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `<direction>` (`left|hcenter|right|top|vcenter|bottom`).
**Usage** Align multiple elements.
**Example** `slidra element align <presentation-id> slides/001.svg el-1,el-2 hcenter`

## element copy

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated).
**Usage** Copy elements to the clipboard (does not delete the originals).
**Example** `slidra element copy <presentation-id> slides/001.svg el-1`

## element cut

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated).
**Usage** Cut elements to the clipboard and remove them from the slide.
**Example** `slidra element cut <presentation-id> slides/001.svg el-1`

## element delete

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated).
**Usage** Delete one or more elements.
**Example** `slidra element delete <presentation-id> slides/001.svg el-1,el-2`

## element distribute

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `<axis>` (`horizontal|vertical`).
**Usage** Distribute spacing evenly among multiple elements along a given axis.
**Example** `slidra element distribute <presentation-id> slides/001.svg el-1,el-2,el-3 horizontal`

## element duplicate

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated), `--dx`, `--dy` (optional, default 0).
**Usage** Duplicate one or more elements in place, with an optional offset.
**Example** `slidra element duplicate <presentation-id> slides/001.svg el-1 --dx 20 --dy 20`

## element group

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated).
**Usage** Group multiple elements into one group.
**Example** `slidra element group <presentation-id> slides/001.svg el-1,el-2`

## element insert

**Parameters** `<kind>` (`rect|ellipse|line|image|path|video|audio`) `<presentation-id>` `<slide-path>`, coordinate/style flags depending on `kind` (`--x`, `--y`, `--width`, `--height`, `--x1`, `--y1`, `--x2`, `--y2`, `--d`, `--fill`, `--stroke`, `--stroke-width`, `--href`, `--media`, `--embed`, all optional).
**Usage** Add a shape/image/media element.
**Example** `slidra element insert rect <presentation-id> slides/001.svg --x 0 --y 0 --width 200 --height 100 --fill '#3366FF'`

## element lock

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated).
**Usage** Lock elements to prevent them from being moved or edited.
**Example** `slidra element lock <presentation-id> slides/001.svg el-1`

## element move

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `--dx <number>` `--dy <number>`, `--force` (optional).
**Usage** Translate one or more elements.
**Example** `slidra element move <presentation-id> slides/001.svg el-1 --dx 10 --dy 0`

## element name set

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `<name>`.
**Usage** Set a human-readable display name for elements (does not affect the identifier).
**Example** `slidra element name set <presentation-id> slides/001.svg el-1 'Title text'`

## element order

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `<direction>` (`front|back|up|down`), `--force` (optional).
**Usage** Adjust the stacking order (z-order) of elements.
**Example** `slidra element order <presentation-id> slides/001.svg el-1 front`

## element paste

**Parameters** `<presentation-id>` `<slide-path>`, `--dx`, `--dy` (optional, default 0), `--svg-file` (optional, paste from a specified SVG file instead of the clipboard).
**Usage** Paste previously copied or cut elements from the clipboard.
**Example** `slidra element paste <presentation-id> slides/001.svg --dx 20 --dy 20`

## element resize

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `--width <number>` `--height <number>`, `--anchor <nw|ne|sw|se>` (optional, default `nw`), `--force` (optional).
**Usage** Resize elements, scaling relative to an anchor point.
**Example** `slidra element resize <presentation-id> slides/001.svg el-1 --width 300 --height 200`

## element rotate

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `--degrees <number>`, `--force` (optional).
**Usage** Rotate one or more elements.
**Example** `slidra element rotate <presentation-id> slides/001.svg el-1 --degrees 45`

## element scale

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `--factor <number>`, `--force` (optional).
**Usage** Scale one or more elements uniformly.
**Example** `slidra element scale <presentation-id> slides/001.svg el-1 --factor 1.5`

## element style set

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated) `<attr>` `<value>`, `--force` (optional).
**Usage** Set an SVG style attribute on elements (whitelisted; see ADR-0014).
**Example** `slidra element style set <presentation-id> slides/001.svg el-1 fill '#FF0000'`

## element ungroup

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated).
**Usage** Ungroup a group.
**Example** `slidra element ungroup <presentation-id> slides/001.svg group-1`

## element unlock

**Parameters** `<presentation-id>` `<slide-path>` `<element-ids>` (comma-separated).
**Usage** Unlock elements.
**Example** `slidra element unlock <presentation-id> slides/001.svg el-1`

## extract

**Parameters** `<id-or-path>` (an open presentation's id, or a `.slidra` filesystem path not yet opened), `<dir>` (must not already exist as a non-empty directory).
**Usage** Write the deck's entire content out as plain real files under `dir` — the escape hatch back to "just files on disk" without any tool that understands the container format.
**Example** `slidra extract <presentation-id> ./extracted`
> This command is used by the user or Slidra itself; the agent typically does not need it.

## ls

**Parameters** `<presentation-id>` `[path]` (omit to list the top level).
**Usage** List files in the presentation (mimics `ls`).
**Example** `slidra ls <presentation-id>`

## new

**Parameters** `<path>`, `--name` (optional).
**Usage** Create a new `.slidra` presentation file.
**Example** `slidra new ./deck.slidra --name My Presentation`
> This command is used by the user or Slidra itself; the agent typically does not need it.

## open

**Parameters** `<path>`.
**Usage** Open an existing `.slidra` presentation file and obtain the identifier needed for subsequent commands.
**Example** `slidra open ./deck.slidra`
> This command is used by the user or Slidra itself; the agent typically does not need it.

## pack

**Parameters** `<presentation-id>` `<path>`.
**Usage** Pack an open presentation back into a `.slidra` file.
**Example** `slidra pack <presentation-id> ./deck.slidra`
> This command is used by the user or Slidra itself; the agent typically does not need it.

## plan delete

**Parameters** `<presentation-id>` `[outline|design-spec]` (omit to delete the entire `plan/` directory).
**Usage** Delete a plan file; does not go into undo history.
**Example** `slidra plan delete <presentation-id> outline`

## plan list

**Parameters** `<presentation-id>`.
**Usage** List the presentation's existing plan files (`plan/outline.md` with its `status`, `plan/design-spec.md`).
**Example** `slidra plan list <presentation-id>`

## plan set

**Parameters** `<presentation-id>` `<name>` (`outline` or `design-spec`) `<content>` (the full file content, beginning with a ```` ```json ```` fence followed by markdown body), `--force` (optional, only valid after `<content>`).
**Usage** Write to `plan/outline.md` or `plan/design-spec.md`; validates the JSON section's fields before writing and rejects on mismatch. Use `cat <presentation-id> plan/outline.md` to read. Does not go into undo history.
When the plan `status` is already `confirmed`, the outline has a set of protected fields: `mode`, `animation`, `background`, existing pages' `relationship`/`rhythm`/`title`, pages cannot be deleted, and the **`blueprint` of a page that has already been drawn**; changing these requires `--force`. Writing a page's `blueprint` for the first time, modifying pages that haven't been drawn yet, changing `type`, and appending pages at the end are unrestricted.
**Example** `slidra plan set <presentation-id> outline '<full content>'`

## presentation canvas set

**Parameters** `<presentation-id>` `--width <number>` `--height <number>`.
**Usage** Set the presentation canvas size.
**Example** `slidra presentation canvas set <presentation-id> --width 1920 --height 1080`

## redo

**Parameters** `<presentation-id>`.
**Usage** Redo the last undone change.
**Example** `slidra redo <presentation-id>`

## slide add

**Parameters** `<presentation-id>`, `--template <template virtual path>` (optional), `--svg <full-page SVG>` (optional, mutually exclusive with `--template`), `--at <index>` (optional; omit to append at the end).
**Usage** Add a slide: a blank page, a template copy, or write a complete page at once with `--svg` (bare `<text>` with `data-slidra-text-width` is converted to a real text box; `<defs>`, gradients, and `path` are allowed; `<script>` or duplicate ids are rejected). On success with `--svg`, `data.elementIds` lists each top-level element's id. **`--svg` has a write gate**: if any check fails — geometric overlap/overflow, text volume, font size and color scheme, role consistency, asset paths, scrim — the entire page is rejected (the response lists each violation) and nothing is written. Animations, notes, templates, and `blueprint` are not gated here. See `slide-design.md` section 0 for the checklist.
**Example** `slidra slide add <presentation-id> --svg '<svg viewBox="0 0 1280 720" style="background-color:#101418"><text id="el-title" data-slidra-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="#F4F6F8">Title</text></svg>'`

## slide set

**Parameters** `<presentation-id>` `<slide-path>` `--svg <full-page SVG>`.
**Usage** Overwrite an existing slide (or template) with a full-page SVG; ingest rules are the same as `slide add --svg`; when the new SVG has no `<metadata>`, the old page's notes, comments, effects, and transitions are preserved. Undoable.
**Example** `slidra slide set <presentation-id> slides/003.svg --svg '<svg viewBox="0 0 1280 720"><text data-slidra-text-width="1120" x="80" y="72" font-size="40">Rewritten title</text></svg>'`

## slide delete

**Parameters** `<presentation-id>` `<slide-path>`.
**Usage** Delete a slide.
**Example** `slidra slide delete <presentation-id> slides/002.svg`

## slide duplicate

**Parameters** `<presentation-id>` `<slide-path>`.
**Usage** Duplicate a slide, inserting it after the original.
**Example** `slidra slide duplicate <presentation-id> slides/001.svg`

## slide move

**Parameters** `<presentation-id>` `<slide-path>` `<new-index>`.
**Usage** Reorder a slide within the presentation.
**Example** `slidra slide move <presentation-id> slides/003.svg 0`

## slide notes set

**Parameters** `<presentation-id>` `<slide-path>` `<text>`.
**Usage** Set the speaker notes for a slide (can be an empty string to clear).
**Example** `slidra slide notes set <presentation-id> slides/001.svg 'Remember to introduce yourself first'`

## slide render

**Parameters** `<presentation-id>` `<slide-path>`.
**Usage** Rasterize a slide for export or preview.
**Example** `slidra slide render <presentation-id> slides/001.svg`
> This command is used by the user or Slidra itself; the agent typically does not need it.

## slide background set

**Parameters** `<presentation-id>` `<slide-path>`, `--asset <assets/filename>` (existing asset) and `--opacity <0–1>` (optional), or `--none`.
**Usage** Place a full-bleed, locked background image at the bottom layer of the slide (`id="el-background"`, `data-slidra-role="background"`); calling it again replaces the background; `--none` removes it. Background images do not get animation effects.
**Example** `slidra slide background set <presentation-id> slides/002.svg --asset assets/bg-mesh.svg --opacity 0.8`

## slide style set

**Parameters** `<presentation-id>` `<slide-path>`, `--background`, `--accent` (at least one).
**Usage** Set the slide's background color or accent color.
**Example** `slidra slide style set <presentation-id> slides/001.svg --background '#FFFFFF'`

## slide transition set

**Parameters** `<presentation-id>` `<slide-path>`, `--enter`, `--exit` (`none|fade|slide|zoom`, optional), `--enter-duration`, `--exit-duration` (optional, in seconds), `--all` (optional, at least one must be specified).
**Usage** Set transition animations for slide transitions.
**Example** `slidra slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3`

## table bind

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--source <data-source>`, `--template-row` (optional).
**Usage** Bind a table to a data source so it can later be synced with `table refresh`.
**Example** `slidra table bind <presentation-id> slides/001.svg el-1 --source assets/data/sales.csv`

## table cell copy

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--range <cell-range>`.
**Usage** Copy a range of table cells.
**Example** `slidra table cell copy <presentation-id> slides/001.svg el-1 --range A1:B2`

## table cell cut

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--range <cell-range>`.
**Usage** Cut a range of table cells.
**Example** `slidra table cell cut <presentation-id> slides/001.svg el-1 --range A1:B2`

## table cell paste

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--at <target-cell>` `--tsv-file <TSV file virtual path>`.
**Usage** Paste clipboard or specified TSV file contents into the table.
**Example** `slidra table cell paste <presentation-id> slides/001.svg el-1 --at A1 --tsv-file assets/data/clip.tsv`

## table cell set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--row <number>` `--col <number>` `--text <text>`.
**Usage** Set the text content of a single cell.
**Example** `slidra table cell set <presentation-id> slides/001.svg el-1 --row 0 --col 0 --text 'Total'`

## table cell style set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--row` `--col`, `--row-end`, `--col-end` (optional, specifies a range) `<attr>` `<value>`.
**Usage** Set a style attribute on a cell or range of cells.
**Example** `slidra table cell style set <presentation-id> slides/001.svg el-1 --row 0 --col 0 fill '#EEEEEE'`

## table col delete

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--at <column-index>`.
**Usage** Delete a column from the table.
**Example** `slidra table col delete <presentation-id> slides/001.svg el-1 --at 2`

## table col insert

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--at <column-index>`.
**Usage** Insert a column at the specified position.
**Example** `slidra table col insert <presentation-id> slides/001.svg el-1 --at 2`

## table col width

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--col <number>` `--width <number>`, `--keep-total` (optional).
**Usage** Set the width of a column.
**Example** `slidra table col width <presentation-id> slides/001.svg el-1 --col 0 --width 120`

## table create

**Parameters** `<presentation-id>` `<slide-path>` `--rows <number>` `--cols <number>` `--x <number>` `--y <number>`, `--col-width`, `--theme`, `--header <true|false>` (all optional).
**Usage** Add a table to a slide.
**Example** `slidra table create <presentation-id> slides/001.svg --rows 3 --cols 4 --x 100 --y 100`

## table header set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `true|false`.
**Usage** Toggle whether the table has a header row.
**Example** `slidra table header set <presentation-id> slides/001.svg el-1 true`

## table merge

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--row <number>` `--col <number>`, `--row-span`, `--col-span` (optional), `--unmerge` (optional).
**Usage** Merge (or unmerge) table cells.
**Example** `slidra table merge <presentation-id> slides/001.svg el-1 --row 0 --col 0 --row-span 1 --col-span 2`

## table refresh

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>`.
**Usage** Refresh the table content using the data source bound by `table bind`.
**Example** `slidra table refresh <presentation-id> slides/001.svg el-1`

## table row delete

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--at <row-index>`.
**Usage** Delete a row from the table.
**Example** `slidra table row delete <presentation-id> slides/001.svg el-1 --at 2`

## table row insert

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--at <row-index>`.
**Usage** Insert a row at the specified position.
**Example** `slidra table row insert <presentation-id> slides/001.svg el-1 --at 2`

## table set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>`, data source one of three: `--from`, `--markdown`, `--markdown-file`.
**Usage** Overwrite the entire table content using a Markdown table (inline text or file).
**Example** `slidra table set <presentation-id> slides/001.svg el-1 --markdown '| A | B |\n|---|---|\n| 1 | 2 |'`

## table theme set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<theme>`. Valid values: `dark`, `light`, `zebra`.
**Usage** Apply a table color theme.
**Example** `slidra table theme set <presentation-id> slides/001.svg el-1 zebra`

## template add

**Parameters** `<presentation-id>`, `--from <source slide virtual path>`, `--name` (all optional).
**Usage** Save a slide as a reusable template.
**Example** `slidra template add <presentation-id> --from slides/001.svg --name 'Title slide'`

## template delete

**Parameters** `<presentation-id>` `<template-path>`.
**Usage** Delete a template.
**Example** `slidra template delete <presentation-id> templates/001.svg`

## template list

**Parameters** `<presentation-id>`.
**Usage** List all templates in the presentation.
**Example** `slidra template list <presentation-id>`

## template rename

**Parameters** `<presentation-id>` `<template-path>` `<new-name>`.
**Usage** Rename a template.
**Example** `slidra template rename <presentation-id> templates/001.svg 'Cover'`

## text list set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--paragraph <number>` `--kind <bullet|number|none>`, `--force` (optional).
**Usage** Set the list style (bullet/numbered/none) for a paragraph of text.
**Example** `slidra text list set <presentation-id> slides/001.svg el-1 --paragraph 0 --kind bullet`

## text set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<new-text>`, `--force` (optional).
**Usage** Modify the text content of an element.
**Example** `slidra text set <presentation-id> slides/001.svg el-1 'Q3 Earnings'`

## text style set

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `--range <start:end>`, `--font-weight`, `--font-style` (at least one), `--force` (optional).
**Usage** Set the font weight or font style for a text range.
**Example** `slidra text style set <presentation-id> slides/001.svg el-1 --range 0:3 --font-weight 700`

## textbox add

**Parameters** `<presentation-id>` `<slide-path>` `--x <number>` `--y <number>` `--width <number>` `--text <text>`, `--font-size`, `--font-family`, `--font-weight`, `--fill`, `--align <left|center|right>` (all optional).
**Usage** Add a text box.
**Example** `slidra textbox add <presentation-id> slides/001.svg --x 100 --y 100 --width 400 --text 'New text box'`

## textbox align

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<align>` (`left|center|right`), `--force` (optional).
**Usage** Set the text alignment inside a text box.
**Example** `slidra textbox align <presentation-id> slides/001.svg el-1 center`

## textbox width

**Parameters** `<presentation-id>` `<slide-path>` `<element-id>` `<width>`, `--force` (optional).
**Usage** Adjust the width of a text box.
**Example** `slidra textbox width <presentation-id> slides/001.svg el-1 500`

## undo

**Parameters** `<presentation-id>`.
**Usage** Undo the last change.
**Example** `slidra undo <presentation-id>`

## validate

**Parameters** `<presentation-id>` `[slide-path]` (omit to validate the whole presentation).
**Usage** Validate slides against hardcoded design rules: text volume, one title per page, overflow and overlap, font size and color scheme matching the table in `plan/design-spec.md`, background and notes, page count and type matching `plan/outline.md`, and taboo rules (thank-you pages, duplicate covers, borders). `data.errors` items each have `slide`/`element`/`rule`/`actual`/`limit`/`message`; exit code is 1 when errors are found (non-zero means findings, not a fault). Without plan files, only geometry and skeleton are validated.
**Example** `slidra validate <presentation-id>`
