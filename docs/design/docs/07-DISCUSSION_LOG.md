# 07 · Discussion Log (decisions made and rejected)

Organized chronologically; "→" marks the adopted outcome, "✕" marks something rejected or reverted.

## Phase 1: from the old web/ version to New
- Reviewed `web/` (a dark, Office-style ribbon built with React + CSS tokens) and the Holspire design language (warm white, #C8233B, Plus Jakarta Sans, rounded cards).
- Decided by survey: redesign every screen; **warm-white shell + dark stage**; keep a tabbed side panel on the right; Plus Jakarta Sans + Noto Sans TC; go straight to a high-fidelity build.
- Rebuilt the old version as `Slidra (Old)` for comparison first, then produced `Slidra (New)`.
- Toolbar direction: tab pills + a single condensed command row + a floating contextual bar on selection.

## Phase 2: the AI comment (pin) system
- The selection box is no longer persistent; it now appears only on click.
- "Comment to agent" next to the selection box → a corresponding entry appears in the chat panel (clickable to jump, ✕ to delete).
- Reduced the row height of chat-panel entries (30px), showing only the number, page, and a truncated comment; up to 6.5 rows visible, scrollable beyond that.
- Whole-page comments are now entered via the left-rail thumbnail instead of a persistent "page N" row in the chat panel.
- Pin numbers changed from circles to filled rounded squares; a matching number also appears on the stage; clicking again lets you edit it; entries in both the chat panel and whole-page comments are editable the same way.
- Pin position: replaces the chat icon; the whole-page number in the stage's top-right corner was removed; ordering is page order → top-left to bottom-right.
- Pin numbers were transparent when not hovered → later reverted to solid.
- Comment box: defaults to below the selection box (flips above if there isn't room); glass material; border no longer white; doubled the offset distance; more blur; semi-transparent input area; increased text contrast at the bottom-left; clicking an element that already has a comment and pressing comment again brings back the existing text.

## Phase 3: interface English-ization and feature completion
- All non-content UI switched to English.
- Added Open / Save / Export (PPTX, PDF, By-frame PDF).
- The selection box can now be dragged to move and resized from its corners.
- Diversified sample pages and templates: images, audio, video, tables, SVG animation; animation switched to self-contained SVG (keyframes inside `<svg><style>`).
- Drew up a "what's still missing" candidate list → selected the whole "core completeness" batch (multi-select, drag reorder, keyboard shortcuts, Undo/Redo, right-click menu, empty-state onboarding, double-click to edit, snapping guides); closing the pin loop was deferred.
- Further work: per-object animation and sequencing, New slide from outline, editable tables, bar as an independent rectangle, Text box / Shape, Arrange implementation.
- Removed all ▾ carets so buttons open their menu directly on click; fixed a bug where `overflow:hidden` clipped the menu.
- Real implementation of Table / Chart (after a planning survey): per-cell table styling, column-width dragging, range selection, right-click row/column merge, theme panel; chart data model, 6 chart types, styling, a floating data window, self-contained SVG output. Fixed `<colgroup>` not rendering (switched to using the first row's width) and data cells being squashed (fixed with `flex:none`).

## Phase 4: simplification attempts
- Proposed 10 simplification ideas. Adopted: removed the 1280×720 chip. ✕ Merging Style+Animate into a single Inspector (tried it, then reverted).
- **v2** (a radical variant): no tabbed toolbar, the whole right side given to chat, all properties moved to a dock below the stage. Abandoned partway through because users didn't like it.

## Phase 5: v3 (regenerated from New, the final version)
- Removed the Present tab; moved Transitions into Animate (Page animate: Enter/Exit; Object animate).
- Home + Insert laid out flat and centered; Fullscreen/Play merged → Play later moved to the top row, right of Export, and the fullscreen icon was removed.
- Toolbar position: below the stage → floating glass above the stage → finally **floating glass below the stage**. Along the way, fixed width overflow (tightened spacing; Insert briefly switched to icon-only, then restored labels; tooltips need a single anchor point).
- ✕ Tried making the left/right rails floating glass too and removing speaker notes → reverted.
- New / Templates moved above the left rail (same white-background style).
- Title bar: moved Undo/Redo to the left of the filename; filename now shows `.slidra`; the logo changed from "CM" to removed entirely; "agent connected" indicator removed; AI avatar changed to 🤖.
- Contextual bar: removed Left/Center/Front and the sub-labels; order is Comment to AI ｜ Edit style · Edit animation ｜ Delete; removed the arrow, adjusted dividers; "Comment to agent" → "Comment to AI"; "Revise" → **Edit**; Edit animation hidden when there's no animation.
- Pin numbers moved to the right of the selection box's name label, shown only while selected, solid fill.
- Comment box: removed the header explanation and the bottom-left hint; buttons changed to Save changes / Add comment and kept inside the box.
- Insert types (Image/Video/Audio/Table/Chart) ask for input before inserting → panels always grow from directly above and centered on the toolbar → Text follows the same pattern (compact).
- Added a Page tab (slide dimensions) to Style, alongside Object; Style and Animate both restructured into Page｜Object sub-tabs (Object disabled when nothing is selected); removed section headers.
- Shape / Arrange / Zoom menus rearranged to a horizontal layout.
- Table size grid: hover only previews, click locks in the size (fixed a bug where the size wouldn't "stick").
- Animate: added an Animate button to the toolbar (grouped with Arrange, disabled when nothing is selected); the panel includes an effect preview + Start timing + Duration.
- Group: added Group/Ungroup to the toolbar; supports nesting; double-click drills in; animation follows PPTX behavior (the whole group as one segment; Group/Ungroup clears related animation).
- Canvas: Figma-style zoom/pan; ✋ grab mode (when locked, the slide itself can also be grabbed, and the selection is cleared); the zoom percentage sits on the left of the toolbar and expands into a horizontal menu.
- Stage background → dark gray → lightened slightly (#3A3A3D).
- The user confirmed **New v3** as the final version.
