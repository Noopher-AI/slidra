---
name: comotion-animate
description: 為指定頁或整份簡報加上依序揭露的動畫效果與頁面轉場，可指定保守或活潑
---

# 加動畫效果

使用者說「幫這頁加動畫」「讓內容依序出現」「加個轉場」時的完整流程。依序揭露的順序固定是「標題先、要點逐條、圖／表／圖表最後」，除非使用者另外指定。
命令的完整參數見 `reference/commands.md`，這裡只寫順序與容易做錯的地方。

## 觸發語

「加動畫」「依序揭露」「一個一個出現」「加轉場」「保守一點的動畫」「活潑一點的動畫」。

## 輸入格式

- 目標：某一頁（`slides/00N.svg`）或「整份」。
- 風格（選填）：「保守」或「活潑」；不指定時用預設值（見下方「步驟」）。

## 步驟

1. **沒指定目標時不要猜**：先 `co-motion ls <presentation-id> slides` 看現況，問使用者是哪一頁或整份，**不執行任何寫入命令**。
2. **指定的頁不存在**：明確回報「這份簡報只有 N 頁」，不執行、不改成最接近的一頁。
3. **讀該頁的結構**：`co-motion cat <presentation-id> slides/00N.svg`，依 `data-comot-name`（標題／要點／圖片等）與 `font-size`、`y` 座標排出順序：標題 → 要點逐條 → 圖／表／圖表。沒有 `data-comot-name`、看起來是滿版背景或純裝飾的元素（例如背景 `<rect>`）**不加效果**。
4. **該頁已有效果時先看現況**：`co-motion effect list <presentation-id> slides/00N.svg`。
   - 使用者要「重做」：`co-motion effect remove <presentation-id> slides/00N.svg <全部 1-based index，逗號分隔>`，再依步驟 5 重新加。
   - 使用者要「補」：只對缺的元素 `effect add`，需要時用 `co-motion effect move <presentation-id> slides/00N.svg <index> up|down` 把順序調對。
   - **不得在未讀 `effect list` 的情況下直接對已有效果的頁加效果。**
5. **先分段，再加效果**：把這一頁的元素按「講者會分幾段講」分組——標題一段，之後每個要點（或每組對照）一段；標題的底線、卡片的編號、數字的說明屬於它所在的那一段，不自成一段。**一段一個 `on-click`，段內其餘元素 `--start with-previous`**；一頁的 `on-click` 不超過 5 個。裝飾幾何與背景不加效果。然後對每個元素跑一次 `co-motion effect add`，風格對應的 family／effect／duration 見下表：

   | 風格 | 標題 | 要點 | 圖／表／圖表 | duration |
   |---|---|---|---|---|
   | 預設（未指定） | `enter/fade` | `enter/fade` | `enter/fade` | `0.4` |
   | 保守 | `enter/fade` | `enter/fade`（只做標題與要點，不給背景與裝飾元素） | 不加 | `0.3` |
   | 活潑 | `enter/zoom` | `enter/fly-up` | `enter/zoom` | `0.5` |

6. **目標是「整份」**：逐頁重複步驟 3–5；若使用者也要轉場，額外跑一次 `co-motion slide transition set <presentation-id> <任一頁路徑> --enter fade --enter-duration 0.4 --all`（`--all` 會套用到整份，不需要逐頁下）。
7. **秒數一律用秒**：使用者說「300 毫秒」要自己換算成 `0.3` 再下命令，不要把毫秒數字直接當成 `--duration` 的值。

## 使用的命令

`co-motion cat`、`co-motion effect list`、`co-motion effect add`、`co-motion effect move`、`co-motion effect remove`、`co-motion slide transition set`。

## 回報格式

逐頁列出：頁面路徑、每個元素加了什麼效果（family/effect/start/duration），以及是否有調整轉場。若是「補」或「重做」既有效果，說明改動前後的差異。

## 不可做的事

- 不使用雙引號或反斜線；引號一律用單引號。
- 不使用管線或重導向（`|`、`>` 等）驗證結果——一律用 `effect list` 或 `cat` 讀回。
- 不寫任何檔案。
- 不對背景 `<rect>` 或沒有 `data-comot-name` 的裝飾元素加效果。
- 不讓同一段話裡的元素各佔一次 `on-click`（標題與底線、卡片與卡片裡的字要一起進場）；一頁的 `on-click` 不超過 5 個。
- 不在未讀 `effect list` 的情況下對已有效果的頁直接疊加效果。
- 不把毫秒數字直接當秒數使用；`--duration`／`--delay` 一律是秒。
