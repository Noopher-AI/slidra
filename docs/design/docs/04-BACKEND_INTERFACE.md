# 04 · Backend Interface (hypothetical)

The prototype is frontend-only; what follows is a backend contract derived from the frontend data model and interactions, for implementation reference. The core premise: **a slide is an SVG file**. A deck is a folder (with `.comot` as the manifest), the agent operates on files via the CLI, and the GUI and the agent stay in sync through the same files and event stream.

## 1. File layout
```
Q3 Product Roadmap.comot/       # or a single zip
  deck.json                   # Deck manifest
  slides/01.svg … 07.svg      # one self-contained SVG per page (including <style> keyframes)
  slides/03.notes.md          # speaker notes
  assets/                     # images/media
  comments.json                # pins (context for the agent)
  history/                    # snapshots (optional)
```

## 2. Types (TypeScript)
```ts
export type Id = string;

export interface Deck {
  id: Id; name: string; width: number; height: number;     // px, e.g. 1280×720
  slides: SlideRef[]; templates: Template[]; updatedAt: string; revision: number;
}
export interface SlideRef { id: Id; file: string; notes?: string; transition?: PageTransition }
export interface PageTransition { enter: Fx; exit: Fx }
export interface Fx { effect: 'none'|'fade'|'slide'|'zoom'; duration: number }

export interface Slide {
  id: Id; bg: string; accent: string;
  elements: Element[]; animOrder: Id[]; groupNames: Record<Id,string>;
  transition?: PageTransition;
}
export type Element = TextEl | ShapeEl | MediaEl | TableEl | ChartEl;
export interface Box { l: number; t: number; w: number; h: number }   // % of slide
export interface ElBase {
  id: Id; type: Element['type']; name: string; box: Box;
  groups?: Id[];                                                       // outermost → innermost
  anim?: { effect: 'fade'|'flyup'|'flyleft'|'zoom'|'wipe'; trigger: 'click'|'with'|'after';
           duration: number; delay: number; groupId?: Id };
}
export interface TextEl  extends ElBase { type:'text'; text: string; size: number; weight: number; color: string; align: 'left'|'center'|'right' }
export interface ShapeEl extends ElBase { type:'rect'|'ellipse'|'line'; fill: string }
export interface MediaEl extends ElBase { type:'image'|'video'|'audio'; src?: string; mediaLabel: string; caption?: string }
export interface Cell { t: string; b?: boolean; align?: 'left'|'center'|'right'; bg?: string; color?: string; span?: {r:number;c:number}; hidden?: boolean }
export interface TableEl extends ElBase { type:'table'; cells: Cell[][]; cols: {w:number}[]; header: boolean; theme:'dark'|'light'|'zebra'; border: boolean }
export interface ChartEl extends ElBase { type:'chart'; chartType:'bar'|'hbar'|'line'|'area'|'pie'|'donut';
  categories: string[]; series: {name:string; values:number[]; color?:string}[];
  palette:'brand'|'cool'|'warm'; legend:'none'|'bottom'|'right'; grid: boolean; labels: boolean; xTitle: string; yTitle: string }

export interface Comment { id: Id; slideId: Id; target: Id | 'page'; text: string; createdAt: string; resolved?: boolean }
export interface Template { id: Id; name: string; tag: string; slide: Slide }
```

## 3. REST
| Method | Path | Description |
|---|---|---|
| `GET` | `/decks/:deckId` | Deck manifest |
| `PATCH` | `/decks/:deckId` | Rename, resize `{width,height}`, reorder `{slideIds[]}` |
| `GET` | `/decks/:deckId/slides/:slideId` | Slide JSON |
| `GET` | `/decks/:deckId/slides/:slideId.svg` | Rendered SVG (authoritative output) |
| `PUT` | `/decks/:deckId/slides/:slideId` | Whole-page overwrite (the GUI's commit unit). `If-Match: <revision>` header for optimistic locking. |
| `POST` | `/decks/:deckId/slides` | `{after?: slideId, template?: templateId, outline?: string}`; when `outline` is present, the agent drafts it (async, returns a job) |
| `POST` | `/decks/:deckId/slides/:slideId/duplicate` | |
| `DELETE` | `/decks/:deckId/slides/:slideId` | |
| `POST` | `/decks/:deckId/assets` | multipart upload → `{src}` |
| `GET/POST/PATCH/DELETE` | `/decks/:deckId/comments[/:id]` | pins |
| `POST` | `/decks/:deckId/export` | `{format:'pptx'|'pdf'|'pdf-frames'}` → job |
| `GET` | `/jobs/:jobId` | `{state:'queued'|'running'|'done'|'error', progress, resultUrl}` |
| `GET/POST/DELETE` | `/templates[/:id]` | Templates |

Errors: `409 Conflict` carries the latest `revision` (the frontend prompts to reload or merge); `423 Locked` means the agent is currently writing to that page (the frontend enters the frozen state).

## 4. WebSocket (`/decks/:deckId/stream`)
Server → client events:
```ts
type Event =
 | { type:'slide.updated'; slideId: Id; revision: number; by: 'agent'|'user'; diff?: JsonPatch[] }
 | { type:'deck.updated'; revision: number }
 | { type:'lock'; slideIds: Id[]; by:'agent'; reason: string }      // GUI shows "Agent editing · undo paused"
 | { type:'unlock'; slideIds: Id[] }
 | { type:'agent.message'; role:'agent'; text: string }
 | { type:'agent.command'; id: Id; state:'in_progress'|'completed'|'failed'; target: string; command: string }
 | { type:'comment.updated'; comment: Comment }
 | { type:'job.progress'; jobId: Id; progress: number };
```
Client → server:
```ts
type ClientMsg =
 | { type:'chat'; text: string; context: { slideId: Id; selection: Id[]; pins: Id[] } }   // pins are bundled when sending
 | { type:'presence'; slideId: Id; selection: Id[] };
```

## 5. Agent CLI (corresponding to the commands shown in chat command cards)
```
comotion textbox set slides/03.svg --id title --text "…"
comotion element move  slides/03.svg --id sub --box 8.4,45,44,7.5
comotion anim add      slides/03.svg --id chart --effect zoom --trigger click --duration .7
comotion table cell    slides/05.svg --id table --r 1 --c 2 --text "< 400 ms"
comotion chart data    slides/03.svg --id chart --csv data.csv
comotion deck draft    --from outline.md --after 03
comotion export        --format pdf-frames
```
Each command emits `lock` before executing and `slide.updated` + `unlock` after completing; the GUI shows the corresponding Running → Done state.

## 6. SVG output conventions
- `viewBox="0 0 W H"` (deck dimensions); elements are wrapped in `<g id="{elementId}" data-name data-groups>`.
- Text: `<text>` (font size = `size/100*W`); tables: `<g>` + `<rect>/<text>`; charts: the frontend-generated `<svg>` content (including `<style>`) is embedded directly.
- Object animation: keyframes + `animation` inside `<style>`, with `data-anim-order` and `data-trigger` for the player to parse; page transitions are stored in `deck.json`.
- By-frame PDF: expands steps from `animOrder`, rendering one page per step.
