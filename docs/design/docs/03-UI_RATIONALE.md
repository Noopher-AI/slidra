# 03 · UI Rationale — the meaning behind every region and every interface element

## A. Title bar
| Element | Meaning / rationale |
|---|---|
| `CoMotion` + `BETA` | Text-only brand mark; the logo square was removed after discussion (low information value). |
| ↶ ↷ | Placed to the left of the filename, right next to the content — "history belongs to this file." Disabled and shown as a toast when frozen. |
| `filename.comot` | Showing the extension reinforces the mental model that "this is a file, operated on by an agent via CLI"; `Saved · just now` / `Unsaved changes` reflects dirty state in real time. |
| `Agent editing · undo paused` | Explicitly signals the frozen state: while the agent is writing to the file, the human cannot undo, avoiding conflicts. |
| Open / Save / Export | File actions are grouped on the right. Export offers PPTX, PDF, and By-frame PDF (one page per animation step) — the latter is the key output for animated presentations. |
| ▶ Play ▏▶| | The primary CTA is red, split into two: play from the current slide, or from the start. It sits at the far right of the top row because "playback" is a file-level action, not an editing tool. |

## B. Left rail
| Element | Meaning |
|---|---|
| New / Templates | New slide and templates are "page" operations, so they sit above the page list rather than in the editing toolbar. New expands a layout list (including "From outline…" as an AI-driven starting point). |
| Thumbnails | Rendered by scaling the real elements (positioned in cqw), not screenshots — always in sync with the content. |
| Page-number dot | The current page has a red fill and white text; `✦ n` indicates the number of animations on that page. |
| Comment button (top-right) | Comments on the "whole page" for the AI; shows a pin number when comments exist. Appears only on hover to reduce visual noise. |
| Drag to reorder | A red insertion line; can be dragged to the last slot. Right-click: add / duplicate / comment / move up-down / delete / add from outline. |

## C. Stage well
| Element | Meaning |
|---|---|
| Dark gray background + slide | A dark background makes the slide's colors stand out; gray rather than black so the boundary doesn't disappear against black slides. |
| Figma-style zoom/pan | ⌘+wheel to zoom (centered on the cursor), wheel to pan, Space/✋ to grab. Editing detail and the overview share the same canvas, so no separate view is needed. |
| Selection box | Red outline, four corner handles, name label at top-left; multi-select uses a dashed outline, a whole group uses a solid outline. The name label is accompanied by that element's pin number (shown only while selected). |
| Alignment guides | Snap to canvas edges/centerlines and to other elements' edges/centers while dragging; ⌥ temporarily disables snapping. |
| Contextual bar (glass) | Appears directly below the selection box (or flips above if there isn't enough room), with actions in order: Comment to AI ｜ Edit style · Edit animation (only when animation exists) ｜ Delete. Operations like Left/Center/Front that can already be done via Arrange or the right-click menu are omitted, so the bar only holds "the most likely next action." |
| Comment box (glass) | Grows from the selection box; keeps only the input and action, with no extra explanatory text. |
| Pin numbers | A red rounded square, corresponding one-to-one with "Pinned context" in the chat panel; clicking it jumps to the target. |
| Double-click | Text → edit in place; chart → data window; group → drill into the next layer. |

### Only two overlay layers

The stage overlay is collapsed into two layers: `.stage-geometry` (the geometry layer) holds everything that's "drawn for the eye, not meant to be interacted with" — the visual next to the name label, snapping guides, animation-number badges; `.stage-widgets` (the widget layer) holds everything that's "meant to be clicked" — the contextual bar, comment pins and comment box, cell edit box/column-width handles/right-click menu, chart data window, third-party player.

This is a structural guarantee, not a convention. The geometry layer is forced to `pointer-events: none !important`, so no individual component can turn its own events back on. Under the old approach, each component decided for itself whether to consume events, which let a bug slip through unnoticed — a display-only animation badge left as `auto` covering an element's top-left resize handle. Once the layers are split, that whole class of bug becomes structurally impossible.

Rule for the widget layer: a widget must not cover the slide's content, and must not handle its own hover state (the contextual bar is the one exception). The explicit exceptions: a third-party player iframe is forced into the parent document by its sandbox (see ADR-0011) and has nowhere else to live but the widget layer; three other display-only elements stay in the widget layer because they're rendered by the same component as their interactive siblings, but they always keep `pointer-events: none` (the name-label row, the player container, the cell-range box).

The contextual bar's own hover handling works like this: while not hovered it's semi-transparent (`opacity: .55`) with `pointer-events: none` — the cursor passes straight through it to click or add to a selection on whatever it's covering underneath. Only once the cursor stays within the bar's bounds for `HOVER_SOLIDIFY_MS` (120ms) does it become solid (`opacity: 1`, `pointer-events: auto`, so its buttons can receive clicks); only once the cursor has been outside for `HOVER_GHOST_MS` (250ms) does it fade back to semi-transparent. The two separate delays mean neither a quick pass-through nor jitter at the boundary triggers a false click or a false flicker. Cursor position is tracked (via the new `stage-hover` message inside the iframe, and via `mousemove` on the parent document outside it) and compared against the contextual bar's current bounding rect.

The stage overlay uses only two z-index values (geometry 1, widget 2); ordering among widgets themselves is decided within the widget layer.

## D. Bottom glass toolbar
| Section | Element | Meaning |
|---|---|---|
| Left | ✋ grab / `100%` | Canvas navigation tools; once ✋ is locked, the whole stage (including the slide) can be dragged, and the selection is cleared to avoid accidental edits. The percentage expands into a horizontal zoom menu. |
| Center | Text Shape Image Video Audio Table Chart | "Insert" is the first step of editing, so it sits in the most reachable, central position. Everything asks for input first before inserting (to avoid producing layout clutter up front); panels always grow from directly above and centered on the toolbar. |
| Right | Animate Arrange Group | Operations that act on the current selection; disabled when nothing is selected. The Animate panel includes an effect preview, start timing, and duration; Group/Ungroup toggles based on selection state. No divider separates these three, signaling that they belong to the same category. |

Why it floats above the stage: the top row is already occupied by file actions; anchoring it below the stage would shrink the stage's height; a floating glass bar stays close to the working area at any zoom level, and 76px is reserved below the stage so the contextual bar never collides with it.

## E. Right rail (side panel)
| Tab | Meaning |
|---|---|
| Chat | AI is the main character here, so it gets its own dedicated tab. Three message types: user, agent, and command card (Done/Running state + target file). "Pinned context" at the bottom stacks in 30px rows (up to 6.5 rows visible, scrollable beyond that), ordered by page order → top-left-to-bottom-right position; the input shows an `n pinned` hint indicating these will be sent together. |
| Style › Page | Slide dimensions (16:9 / 4:3 / 16:10 / A4 / custom) — a whole-deck property. |
| Style › Object | Shown per element type: text (size, weight, color, alignment, position), table (theme, header, borders, cell: bold/alignment/fill/text color/merge), chart (position + entry point to the chart data window). Disabled and auto-reverts to Page when nothing is selected. |
| Animate › Page | Enter/Exit effects and durations, Apply to all. "Transition" was renamed to page animation and placed alongside object animation to unify the concept of "animation." |
| Animate › Object | The card list = click order; a group's animation shows as a single card (matching PPTX behavior). Preview plays the whole page sequence. |

## F. Speaker notes
Kept directly below the stage (its original position in web/); shown to the presenter during playback.

## G. Status bar
Selection name chip, keyboard-shortcut hints, page number and ‹ ›, view switch (Normal / Grid / Play). Grid is the overview overlay.

## H. Dialogs / panels
| Panel | Meaning |
|---|---|
| Insert Text | Text content + style presets (Title/Subtitle/Body/Caption) + alignment; Enter inserts directly. |
| Insert Image/Video/Audio | Drag-and-drop or file picker, URL, caption (context for the AI); inserts a placeholder if left empty. |
| Insert Table | An 8×6 grid to pick dimensions (hover preview, click to lock in), theme, header. |
| Insert Chart | Type, number of series, number of categories, palette; inserted with sample data. |
| Animate | Effect cards (looping preview), Start, Duration → Add animation. |
| Chart data (floating window) | Type row, data grid (categories × series), palette/legend/gridlines/labels/axis titles, Copy SVG. Draggable. |
| Templates | Layout cards, save current page as a template. |
| From outline | Paste an outline → the agent drafts slides (indentation becomes subtitles). Also used as the starting point from an empty state. |

## I. Play mode
Full-bleed black background; a pill-shaped control bar at the bottom (‹ page·step › ｜ fullscreen ｜ Exit); clicking anywhere or pressing → advances one step (object animation step → page). Page Enter/Exit animations actually play.

## J. Right-click menu
Element: Edit text / Edit chart data / Add·Edit animation / Comment / four layer-order items / Duplicate / Delete. Thumbnail: New below / From outline / Duplicate / Comment / Move up·down / Delete. Table cell: Edit / Bold / insert row·column / merge / delete row·column.
