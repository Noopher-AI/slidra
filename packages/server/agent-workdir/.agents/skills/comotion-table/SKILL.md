---
name: comotion-table
description: 把貼在對話裡的 Markdown 或 CSV 表格在指定頁做成表格，可設主題與標題列、綁定既有資料資產。使用者說「幫我做成表格」「這份資料放到第 N 頁」「表格改成 zebra／深色主題」「綁定這份資料」或訊息以 /comotion-table 開頭時用
---

# 做表格

資料只走對話裡貼上的文字：agent 沒有寫檔能力，`--csv`、`--markdown-file`、`asset import <路徑>` 這類要本機檔案路徑的旗標對你不可用。

## 輸入

- 目標頁：`slides/00N.svg`。
- 資料：貼在對話裡的 Markdown 表格或 CSV 文字。
- 選填：主題（`dark`／`light`／`zebra`）、是否有標題列、座標。
- 缺目標頁或缺資料時先 `co-motion ls <presentation-id> slides` 看現況，問使用者缺的那一項，問清楚前不下任何寫入命令。

## 步驟

1. **指定的頁不存在**：回報「這份簡報只有 N 頁」，不執行。
2. **使用者貼的是 CSV**：先在對話裡把它轉成 Markdown 表格（含對齊列），再走下一步。
3. **建立表格元素**：`co-motion table create <presentation-id> slides/00N.svg --rows <R> --cols <C> --x <N> --y <N>`（四個都必填）。沒指定座標時預設 `--x 140 --y 200`，回報裡說明「放在頁面偏左上，需要可以再調」。
4. **寫入內容**：記下步驟 3 回傳的 element id，`co-motion table set <presentation-id> slides/00N.svg <el> --markdown '<多行 Markdown，含真正換行與對齊列>'`——單引號內放真正的換行，這是貼多行 Markdown 的唯一寫法。
   - 命令回「Markdown 表格第二列必須是對齊列」：替使用者補上對齊列（例如 `|---|---|`）再重送，回報裡說明補了什麼。
   - 命令回「第 N 列的欄數與標頭不符」：轉述原始錯誤、問使用者哪一列漏了；補空白欄會掩蓋資料問題。
5. **主題與標題列**：`co-motion table theme set <presentation-id> slides/00N.svg <el> dark|light|zebra`；`co-motion table header set <presentation-id> slides/00N.svg <el> true|false`。使用者說「striped」之類的字對應到 `zebra` 並說明對照。
6. **綁定既有資料**：使用者指名一個簡報內的虛擬路徑時，先 `co-motion ls <presentation-id> assets` 確認看得到，再 `co-motion table bind <presentation-id> slides/00N.svg <el> --source <虛擬路徑>`，之後可用 `co-motion table refresh <presentation-id> slides/00N.svg <el>` 同步。路徑不存在就直接說「這份簡報裡沒有這個資料檔，目前無法從對話匯入 CSV」。
7. **驗證**：`cat` 讀回確認儲存格文字。

## 回報格式

列出建立的表格 element id、所在頁、欄列數、套用的主題，以及是否有標題列。若補了對齊列，說明補了什麼。
