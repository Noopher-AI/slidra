# 02 · Design Document — Slidra New v3

## 1. Product positioning
Slidra is a presentation tool built for "human and AI agent co-editing." Each slide is itself an SVG file (animation expressed as `<style>` keyframes/SMIL inside the SVG); the agent modifies files through CLI commands, while the human works directly in the GUI and gives the agent context through "comments."

## 2. Design principles
1. **Stage-first**: the shell is shallow, the stage is deep; every tool floats above the stage (as glass) rather than occupying fixed layout space.
2. **One thing grows from one place**: the top row is for file and playback; the bottom glass bar is for insert and edit; the right rail is AI/style/animation; the left rail is pages.
3. **Everything grows from the same spot**: any overlay that needs input (insert Text/Image/Table/Chart, Shape, Arrange, Animate, Zoom) grows from directly above and centered on the bottom glass bar, so its position is predictable.
4. **AI is a peer collaborator**: comments (pins) attach to elements, appear in the conversation, and are bundled as context when sent; undo is frozen while the agent is making edits.
5. **PPTX mental model**: groups, animation sequencing, trigger timing, and transitions all align with PowerPoint behavior to lower the learning curve.
6. **Undoable**: every structural operation goes onto the history stack (50 steps).

## 3. Layout structure (1280×720 minimum)
```
┌ Titlebar 48 ───────────────────────────────────────────────────────────┐
│ Slidra BETA │ ↶ ↷ │ filename.slidra  Saved  │        Open Save Export ▶Play│
├ Rail 212 ┬──────────── Stage well (dark) ────────────┬ Side panel 340 ─┤
│ New Tmpl │                                           │ Chat│Style│Anim│
│ 1 [thumb]│         ┌──────── slide ────────┐         │                 │
│ 2 [thumb]│         │   elements (cqw/cqh)  │         │  …              │
│ …        │         └───────────────────────┘         │                 │
│          │   [✋ 100% | Text Shape … | Animate Arrange Group]           │
│          ├──────────── Speaker notes 112 ────────────┤                 │
├ Statusbar 36 ──────────────────────────────────────────────────────────┤
```
- The stage area centers the slide using CSS `grid`; `aspect-ratio` is determined by the page's style. The slide has `container-type:size`, and everything inside it is positioned in `cqw/cqh`, so it follows resizing and zooming naturally.
- The stage can pan and zoom in both directions (Figma-style); the zoom matrix is applied to the slide's outer frame, and `getBoundingClientRect` keeps every overlay positioned correctly automatically.

## 4. State machines (key ones)
### 4.1 Selection
`none → single → multi(shift/marquee) → group(whole group) → drill(double-click into a sublayer)`
- Clicking empty space / Esc → none. Entering grab mode (hand tool / Space) clears the selection.
### 4.2 Edit mode
`view ⇄ play`; `play` has `playStep` (object animation step) and `exiting` (page exit in progress).
### 4.3 Overlay mutual exclusion
`menu ∈ {new-slide, shape, arrange, zoom, null}`, `insertDlg ∈ {text, image, video, audio, table, chart, animate, null}`, `composer`, `chartWin`, `ctxMenu`, `exportOpen`. Any mousedown outside → close everything (`closeMenu`).
### 4.4 Right rail
`side ∈ {chat, style, animate}`; inside style/animate, `sub ∈ {page, object}` — `object` is disabled and auto-reverts to `page` when nothing is selected, and auto-switches to `object` when something is selected.

## 5. Data model (frontend)
```ts
Deck { name, w, h, slides: Slide[] }
Slide { id, bg, accent, elements: Element[], animOrder: id[], groupNames: Record<gid,string>,
        transition?: { enter:{effect,duration}, exit:{effect,duration} } }
Element = Text | Shape | Image | Video | Audio | Table | Chart
  common: { id, type, name, box:{l,t,w,h} /* % of slide */, groups?: gid[] /* outer→inner */,
           anim?: { effect, trigger:'click'|'with'|'after', duration, delay, groupId? } }
Text  { text, size /*cqw*/, weight, color, align }
Shape { type:'rect'|'ellipse'|'line', fill }
Media { mediaLabel, src?, caption? }
Table { cells: Cell[][], cols:{w}[], header, theme:'dark'|'light'|'zebra', border }
Cell  { t, b?, align?, bg?, color?, span?:{r,c}, hidden? }
Chart { chartType, categories, series:{name,values,color?}[], palette, legend, grid, labels, xTitle, yTitle }
Comment { id, slideId, target: elementId|'page', text }
```
History: `past[]/future[]` store `{slides}` snapshots; dragging, text, table, and chart input use a "snapshot before, push after" strategy to avoid pushing a history entry every frame.

## 6. Visual system summary
- Shell: three-step warm white (surface.0/1/2) + brand red; text contrast ≥ 4.5:1.
- Stage: #3A3A3D neutral gray; slide background is dark (swappable); guides are pink.
- Glass: a single shared material across all stage overlays; menus grow upward from their anchor via `hs-grow`.
- Icons: single-line 1.5px strokes, rounded corners; the Insert group keeps text labels.
- Charts: rendered as self-contained SVG strings (including keyframes), consistent with the "slide = SVG" output format, and directly copyable via Copy SVG.

## 7. Accessibility
- Every icon button has a `title` and `aria-label`; disabled state is `disabled` + 40% opacity.
- Keyboard: arrow keys change page, Enter enters edit mode, Esc closes overlays one layer at a time, ⌘Z/⇧⌘Z, ⌘D, ⌘A, ⌘S, ⌘B, ⌘]/[, ⌘0/+/−.
- Contrast: text on glass uses ink.700 or darker; light-colored hints are used only for non-essential information.

## 8. Responsiveness
Minimum 1280px. Left and right rails have fixed widths; the stage area absorbs the remaining space. The toolbar is at most ≈700px wide and is centered within the 728px stage column. To support widths below 1280px, the recommendation is: the right rail should be collapsible, and the Insert group should degrade to icons only.
