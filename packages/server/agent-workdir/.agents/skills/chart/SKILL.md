---
name: chart
description: 用一組貼上的數列資料在指定頁做出圖表，可選類型、雙軸與堆疊
---

# 做圖表

使用者貼一組數列資料要求做成圖表時的完整流程。資料來源只走對話裡貼上的類別與數列，不走檔案匯入（見「不可做的事」）。
命令的完整參數見 `reference/commands.md`，這裡只寫順序與容易做錯的地方。

## 觸發語

「幫我做成圖表」「畫成長條圖／折線圖」「雙軸」「堆疊圖」「圖表配色改一下」。

## 輸入格式

- 目標頁：`slides/00N.svg`。
- 資料：類別清單與一或多組數列（貼在對話裡的數字）。
- 選填：圖表類型、雙軸、堆疊、配色、圖例位置。

## 步驟

1. **沒指定目標頁或資料時不要猜**：先 `co-motion ls <presentation-id> slides` 看現況，問使用者缺的那一項，**不執行任何寫入命令**。
2. **指定的頁不存在**：明確回報「這份簡報只有 N 頁」，不執行。
3. **建立圖表元素**：`co-motion chart create <presentation-id> slides/00N.svg --type <T> --x <N> --y <N> --width <N> --height <N>`。沒指定類型時預設 `bar`；時間序列或使用者說「趨勢」用 `line`；佔比且只有一個數列用 `pie`。沒指定座標時預設 `--x 140 --y 160 --width 640 --height 400`，並在回報裡說明可再調整。
4. **寫入資料**：記下步驟 3 回傳的 element id，跑 `co-motion chart data set <presentation-id> slides/00N.svg <el> --categories <c1,c2,...> --series 'name=v1,v2,...'`（每組數列一個 `--series`）。**不得使用 `--csv`／`--csv-asset`**——agent 沒有寫檔能力，`--csv` 讀的是本機檔案路徑，對 agent 不可用。
5. **雙軸**：`co-motion chart axis set <presentation-id> slides/00N.svg <el> dual --right <右軸系列名>`。如果先前已經設過堆疊，要先 `co-motion chart stack set <presentation-id> slides/00N.svg <el> off`，否則會回「堆疊圖表必須是 axes=single」。
6. **堆疊**：只有 `bar`／`hbar`／`area` 可以堆疊，且必須是 `axes=single`。順序固定：先 `chart type set`（若需要換型別）→ 再 `chart axis set <el> single`（若之前是 dual）→ 最後 `chart stack set <el> on`。
7. **使用者要 `pie`／`donut` 又要堆疊或雙軸**：明確說明這個型別不支援堆疊或雙軸，問使用者要哪一個，**不得自己選一個**。
8. **配色**：`co-motion chart palette set <presentation-id> slides/00N.svg <el> brand|cool|warm`；個別系列覆寫顏色用 `--color 'name=#RRGGBB'`（含 `#`，單引號）。
9. **圖例**：`co-motion chart legend set <presentation-id> slides/00N.svg <el> none|bottom|right`。
10. **驗證**：`cat` 圖表頁的輸出很長（內嵌整張 render 過的 SVG）。**以命令自己的成功訊息為主要驗證**，只有需要確認資料細節時才 `cat`，且要先跟使用者說輸出會很長。

## 使用的命令

`co-motion ls`、`co-motion chart create`、`co-motion chart data set`、`co-motion chart type set`、`co-motion chart axis set`、`co-motion chart stack set`、`co-motion chart palette set`、`co-motion chart legend set`、`co-motion cat`。

## 回報格式

列出建立的圖表 element id、所在頁、類型、資料的類別與數列、以及是否設定了雙軸／堆疊／配色／圖例。若使用者要求了不支援的組合，說明拒絕的理由與可行替代方案。

## 不可做的事

- 不使用 `--csv`／`--csv-asset`（需要本機檔案路徑或既有資料資產）——agent 沒有寫檔能力，資料一律用 `--categories`／`--series`。
- 不對 `pie`／`donut` 設定堆疊或雙軸。
- 不在未先關閉堆疊的情況下設定雙軸（反之亦然）——順序錯了命令會直接報錯，不得改用其他方式繞過。
- 不使用雙引號或反斜線；引號一律用單引號。
- 不使用管線或重導向驗證結果。
- 不寫任何檔案。
