---
name: comotion-table
description: 把貼上的 Markdown 或 CSV 表格在指定頁做成表格，可綁定既有資料資產
---

# 做表格

使用者貼一份表格（Markdown 或 CSV）要求放進簡報時的完整流程。資料來源只走對話裡貼上的文字內容，不走檔案匯入（見「不可做的事」）。
命令的完整參數見 `reference/commands.md`，這裡只寫順序與容易做錯的地方。

## 觸發語

「幫我做成表格」「這份資料放到第 N 頁」「表格改成 zebra／深色主題」「綁定這份資料」。

## 輸入格式

- 目標頁：`slides/00N.svg`。
- 資料：貼在對話裡的 Markdown 表格或 CSV 文字。
- 選填：主題（`dark`／`light`／`zebra`）、是否有標題列、座標。

## 步驟

1. **沒指定目標頁或資料時不要猜**：先 `co-motion ls <presentation-id> slides` 看現況，問使用者缺的那一項，**不執行任何寫入命令**。
2. **指定的頁不存在**：明確回報「這份簡報只有 N 頁」，不執行。
3. **建立表格元素**：`co-motion table create <presentation-id> slides/00N.svg --rows <R> --cols <C> --x <N> --y <N>`。`--rows/--cols/--x/--y` 四個都是必填。沒指定座標時預設 `--x 140 --y 200`，並在回報裡說明「放在頁面偏左上，需要可以再調」（畫布是 1280×720）。`--rows`／`--cols` 先照貼上的表填，之後 `table set` 會依 Markdown 重排。
4. **使用者貼的是 CSV**：先在對話裡把它轉成 Markdown 表格（含對齊列），再走下一步。**不得使用 `--csv`／`asset import`**——agent 沒有寫檔能力，這兩個命令對 agent 都不可用。
5. **寫入內容**：記下步驟 3 回傳的 element id，跑 `co-motion table set <presentation-id> slides/00N.svg <el> --markdown '<多行 Markdown，含真正換行與對齊列>'`。單引號內可以放真正的換行，這是貼多行 Markdown 的唯一合法寫法。
6. **Markdown 缺對齊列**：命令會回「Markdown 表格第二列必須是對齊列」，**主動幫使用者補上對齊列**（例如 `|---|---|`）再重送，並在回報裡說明補了什麼。
7. **資料列欄數與標頭不符**：命令會回「第 N 列的欄數與標頭不符」，把原始錯誤轉述給使用者、問哪一列漏了，**不得自己補空白欄**。
8. **設定主題／標題列**：`co-motion table theme set <presentation-id> slides/00N.svg <el> dark|light|zebra`；`co-motion table header set <presentation-id> slides/00N.svg <el> true|false`。使用者說「striped」之類的字要對應到 `zebra` 並說明對照。
9. **綁定既有資料**：只有當使用者指名一個**已存在**的簡報內虛擬路徑（先用 `co-motion ls <presentation-id> assets` 確認看得到）才跑 `co-motion table bind <presentation-id> slides/00N.svg <el> --source <虛擬路徑>`，之後可用 `co-motion table refresh <presentation-id> slides/00N.svg <el>` 同步。路徑不存在就直接說「這份簡報裡沒有這個資料檔，目前無法從對話匯入 CSV」。

## 使用的命令

`co-motion ls`、`co-motion table create`、`co-motion table set`、`co-motion table theme set`、`co-motion table header set`、`co-motion table bind`、`co-motion table refresh`。

## 回報格式

列出建立的表格 element id、所在頁、欄列數、套用的主題，以及是否有標題列。若補了對齊列或欄位，說明補了什麼。

## 不可做的事

- 不使用 `--csv`（`chart data set` 的旗標）、`asset import`、`table set --markdown-file` 等任何需要本機檔案路徑的旗標——agent 沒有寫檔能力，這些對 agent 都不可用。
- 不對不存在的虛擬路徑跑 `table bind`。
- 不自己補空白欄位掩蓋欄數不符的錯誤，改為轉述錯誤並詢問使用者。
- 不使用雙引號或反斜線；引號一律用單引號，多行內容放在單引號內。
- 不使用管線或重導向驗證結果——一律用 `cat` 讀回。
- 不寫任何檔案。
