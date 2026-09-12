---
name: comotion-chart
description: 用一組貼在對話裡的數列資料在指定頁做出圖表，可選類型、雙軸、堆疊、配色與圖例。使用者說「幫我做成圖表」「畫成長條圖／折線圖」「雙軸」「堆疊圖」「圖表配色改一下」或訊息以 /comotion-chart 開頭時用
---

# 做圖表

資料只走對話裡貼上的類別與數列：`--csv`／`--csv-asset` 要本機檔案路徑或既有資料資產，對 agent 不可用，一律用 `--categories`／`--series`。

## 輸入

- 目標頁：`slides/00N.svg`。
- 資料：類別清單與一或多組數列。
- 選填：圖表類型、雙軸、堆疊、配色、圖例位置。
- 缺目標頁或缺資料時先 `comotion ls <presentation-id> slides` 看現況，問使用者缺的那一項，問清楚前不下任何寫入命令。

## 步驟

1. **指定的頁不存在**：回報「這份簡報只有 N 頁」，不執行。
2. **建立圖表元素**：`comotion chart create <presentation-id> slides/00N.svg --type <T> --x <N> --y <N> --width <N> --height <N>`。沒指定類型時預設 `bar`；時間序列或使用者說「趨勢」用 `line`；佔比且只有一個數列用 `pie`。沒指定座標時預設 `--x 140 --y 160 --width 640 --height 400`，回報裡說明可再調整。
3. **寫入資料**：記下步驟 2 回傳的 element id，`comotion chart data set <presentation-id> slides/00N.svg <el> --categories <c1,c2,...> --series 'name=v1,v2,...'`（每組數列一個 `--series`）。
4. **雙軸與堆疊互斥**，順序要對：
   - 雙軸：`comotion chart axis set <presentation-id> slides/00N.svg <el> dual --right <右軸系列名>`；先前設過堆疊要先 `comotion chart stack set <presentation-id> slides/00N.svg <el> off`，否則命令回「堆疊圖表必須是 axes=single」。
   - 堆疊：只有 `bar`／`hbar`／`area` 可以堆疊，且必須是 `axes=single`。先 `chart type set`（若需要換型別）→ 再 `chart axis set <el> single`（若之前是 dual）→ 最後 `chart stack set <el> on`。
   - `pie`／`donut` 不支援堆疊與雙軸：說明後問使用者要哪一個，由他選。
   命令報錯就是順序錯了，照上面的順序重來。
5. **配色**：`comotion chart palette set <presentation-id> slides/00N.svg <el> brand|cool|warm`；個別系列覆寫用 `--color 'name=#RRGGBB'`（含 `#`，單引號）。
6. **圖例**：`comotion chart legend set <presentation-id> slides/00N.svg <el> none|bottom|right`。
7. **驗證**：以命令自己的成功訊息為主。`cat` 圖表頁的輸出很長（內嵌整張 render 過的 SVG），只有需要確認資料細節時才 `cat`，並先跟使用者說輸出會很長。

## 收尾

動完之後、回覆之前跑一次 `comotion validate <presentation-id>`（只動一頁就驗那一頁），把結果寫進回報的第一行；`errors` 不是空的就修完再驗，修到 0 錯誤才結束這一輪（見 `AGENTS.md` 的「收尾條件」）。

## 回報格式

列出建立的圖表 element id、所在頁、類型、資料的類別與數列、以及是否設定了雙軸／堆疊／配色／圖例。使用者要求了不支援的組合時，說明原因與可行替代方案。
