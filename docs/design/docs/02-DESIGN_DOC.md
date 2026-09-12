# 02 · Design Document — Slidra New v3

## 1. 產品定位
Slidra 是「人與 AI agent 共同編輯」的簡報工具。投影片本體是 SVG 檔（動畫以 SVG 內 `<style>` keyframes／SMIL 表示），agent 透過 CLI 指令修改檔案，人類在 GUI 直接操作並用「留言」給 agent 上下文。

## 2. 設計原則
1. **舞台優先**：外殼淺、舞台深；所有工具浮在舞台上（玻璃），不佔固定版面。
2. **一個入口一件事**：頂列＝檔案與播放；底部玻璃列＝插入與編輯；右欄＝AI／樣式／動畫；左欄＝頁。
3. **一律從同一個地方長出**：任何需要輸入的浮層（插入 Text/Image/Table/Chart、Shape、Arrange、Animate、Zoom）都從底部玻璃列正上方中央長出，位置可預期。
4. **AI 是對等協作者**：留言（pin）掛在元素上、附在對話裡、送出時打包成 context；agent 修改時凍結 undo。
5. **PPTX 心智模型**：群組／動畫序列／觸發時機／轉場都對齊 PowerPoint 行為，降低學習成本。
6. **可還原**：所有結構性操作進歷史堆疊（50 步）。

## 3. 版面結構（1280×720 最小）
```
┌ Titlebar 48 ───────────────────────────────────────────────────────────┐
│ Slidra BETA │ ↶ ↷ │ 檔名.slidra  Saved  │        Open Save Export ▶Play│
├ Rail 212 ┬──────────── Stage well (dark) ────────────┬ Side panel 340 ─┤
│ New Tmpl │                                           │ Chat│Style│Anim│
│ 1 [thumb]│         ┌──────── slide ────────┐         │                 │
│ 2 [thumb]│         │   elements (cqw/cqh)  │         │  …              │
│ …        │         └───────────────────────┘         │                 │
│          │   [✋ 100% | Text Shape … | Animate Arrange Group]           │
│          ├──────────── Speaker notes 112 ────────────┤                 │
├ Statusbar 36 ──────────────────────────────────────────────────────────┤
```
- 舞台區以 CSS `grid` 置中投影片，`aspect-ratio` 由 Page style 決定；投影片 `container-type:size`，內部一切以 `cqw/cqh` 定位，故換尺寸／縮放皆自然跟隨。
- 舞台可縱橫平移／縮放（Figma 式）；縮放矩陣套在投影片外框，`getBoundingClientRect` 使各浮層定位自動正確。

## 4. 狀態機（重點）
### 4.1 選取
`none → single → multi(shift/marquee) → group(整組) → drill(雙擊進入子層)`
- 點空白／Esc → none。抓取模式（hand／Space）進入時清空。
### 4.2 編輯模式
`view ⇄ play`；`play` 內有 `playStep`（物件動畫步）與 `exiting`（頁退場中）。
### 4.3 浮層互斥
`menu ∈ {new-slide, shape, arrange, zoom, null}`、`insertDlg ∈ {text, image, video, audio, table, chart, animate, null}`、`composer`、`chartWin`、`ctxMenu`、`exportOpen`。任一 mousedown 在外部 → 全關（`closeMenu`）。
### 4.4 右欄
`side ∈ {chat, style, animate}`；style／animate 內 `sub ∈ {page, object}`，object 在無選取時 disabled 並自動回 page；有選取時自動切 object。

## 5. 資料模型（前端）
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
歷史：`past[]/future[]` 存 `{slides}` 快照；拖曳／文字／表格／圖表輸入以「開始前快照、結束後推入」策略避免每幀入棧。

## 6. 視覺系統摘要
- 外殼：暖白三階（surface.0/1/2）+ 品牌紅；文字對比 ≥ 4.5:1。
- 舞台：#3A3A3D 中性灰；投影片深色底（可換）；輔助線粉紅。
- 玻璃：所有舞台浮層統一材質；選單以 `hs-grow` 由錨點向上長出。
- 圖示：單線 1.5px、圓角；Insert 群組保留文字標籤。
- 圖表：以字串產生自包含 SVG（含 keyframes），與「投影片＝SVG」的輸出格式一致，可直接 Copy SVG。

## 7. 無障礙
- 所有圖示按鈕有 `title`＋`aria-label`；停用態以 `disabled` + 40% 透明。
- 鍵盤：方向鍵換頁、Enter 進入編輯、Esc 逐層關閉、⌘Z/⇧⌘Z、⌘D、⌘A、⌘S、⌘B、⌘]/[、⌘0/+/−。
- 對比：玻璃上文字使用 ink.700 以上；淡色提示僅用於非必要資訊。

## 8. 響應
最小 1280px。右欄／左欄固定寬，舞台區吸收餘量；工具列最寬 ≈ 700px，在 728px 舞台欄內置中。若要支援 <1280，建議：右欄可收合、Insert 群組退化為圖示。
