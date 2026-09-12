# 04 · 假想後端介面（Backend Interface, hypothetical）

原型是純前端；以下是依前端資料模型與交互推導的後端契約，供實作參考。核心前提：**投影片＝SVG 檔**，deck 是一個資料夾（`.comot` 為 manifest），agent 以 CLI 操作檔案，GUI 與 agent 透過同一份檔案與事件流同步。

## 1. 檔案佈局
```
Q3 產品路線圖.comot/          # 或單一 zip
  deck.json                   # Deck manifest
  slides/01.svg … 07.svg      # 每頁一個自包含 SVG（含 <style> keyframes）
  slides/03.notes.md          # 講者備忘
  assets/                     # 圖片／影音
  comments.json               # pins（給 agent 的 context）
  history/                    # 快照（可選）
```

## 2. 型別（TypeScript）
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
| Method | Path | 說明 |
|---|---|---|
| `GET` | `/decks/:deckId` | Deck manifest |
| `PATCH` | `/decks/:deckId` | 改名、尺寸 `{width,height}`、頁序 `{slideIds[]}` |
| `GET` | `/decks/:deckId/slides/:slideId` | Slide JSON |
| `GET` | `/decks/:deckId/slides/:slideId.svg` | 渲染後 SVG（權威輸出） |
| `PUT` | `/decks/:deckId/slides/:slideId` | 整頁覆寫（GUI 的 commit 單位）。Header `If-Match: <revision>` 樂觀鎖。 |
| `POST` | `/decks/:deckId/slides` | `{after?: slideId, template?: templateId, outline?: string}`；含 outline 時由 agent 草擬（非同步，回 job） |
| `POST` | `/decks/:deckId/slides/:slideId/duplicate` | |
| `DELETE` | `/decks/:deckId/slides/:slideId` | |
| `POST` | `/decks/:deckId/assets` | multipart 上傳 → `{src}` |
| `GET/POST/PATCH/DELETE` | `/decks/:deckId/comments[/:id]` | pins |
| `POST` | `/decks/:deckId/export` | `{format:'pptx'|'pdf'|'pdf-frames'}` → job |
| `GET` | `/jobs/:jobId` | `{state:'queued'|'running'|'done'|'error', progress, resultUrl}` |
| `GET/POST/DELETE` | `/templates[/:id]` | 範本 |

錯誤：`409 Conflict` 帶最新 `revision`（前端提示重新載入或合併）；`423 Locked` 表示 agent 正在寫該頁（前端進入凍結態）。

## 4. WebSocket（`/decks/:deckId/stream`）
伺服器 → 客戶端事件：
```ts
type Event =
 | { type:'slide.updated'; slideId: Id; revision: number; by: 'agent'|'user'; diff?: JsonPatch[] }
 | { type:'deck.updated'; revision: number }
 | { type:'lock'; slideIds: Id[]; by:'agent'; reason: string }      // GUI 顯示 Agent editing · undo paused
 | { type:'unlock'; slideIds: Id[] }
 | { type:'agent.message'; role:'agent'; text: string }
 | { type:'agent.command'; id: Id; state:'in_progress'|'completed'|'failed'; target: string; command: string }
 | { type:'comment.updated'; comment: Comment }
 | { type:'job.progress'; jobId: Id; progress: number };
```
客戶端 → 伺服器：
```ts
type ClientMsg =
 | { type:'chat'; text: string; context: { slideId: Id; selection: Id[]; pins: Id[] } }   // 送出時打包 pins
 | { type:'presence'; slideId: Id; selection: Id[] };
```

## 5. Agent CLI（對應對話卡中的指令）
```
comotion textbox set slides/03.svg --id title --text "…"
comotion element move  slides/03.svg --id sub --box 8.4,45,44,7.5
comotion anim add      slides/03.svg --id chart --effect zoom --trigger click --duration .7
comotion table cell    slides/05.svg --id table --r 1 --c 2 --text "< 400 ms"
comotion chart data    slides/03.svg --id chart --csv data.csv
comotion deck draft    --from outline.md --after 03
comotion export        --format pdf-frames
```
每個指令執行前發 `lock`，完成後 `slide.updated` + `unlock`；GUI 對應顯示 Running → Done。

## 6. SVG 輸出約定
- `viewBox="0 0 W H"`（deck 尺寸）；元素以 `<g id="{elementId}" data-name data-groups>` 包裹。
- 文字：`<text>`（字級 = `size/100*W`）；表格：`<g>` + `<rect>/<text>`；圖表：直接嵌入前端產生的 `<svg>` 內容（含 `<style>`）。
- 物件動畫：`<style>` 內 keyframes + `animation`，`data-anim-order`、`data-trigger` 供播放器解析；頁面轉場寫在 `deck.json`。
- By-frame PDF：以 `animOrder` 展開步數，每步渲染一張。
