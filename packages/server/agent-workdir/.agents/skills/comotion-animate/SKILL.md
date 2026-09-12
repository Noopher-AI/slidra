---
name: comotion-animate
description: 為指定頁或整份簡報加上依序揭露的動畫效果與頁面轉場，可指定保守或活潑。使用者說「加動畫」「依序揭露」「一個一個出現」「加轉場」或訊息以 /comotion-animate 開頭時用
---

# 加動畫效果

依序揭露的順序固定是「標題先、要點逐條、圖／表／圖表最後」，除非使用者另外指定。分段與群組的原則見 `reference/slide-design.md` 第 5 節。

## 輸入

- 目標：某一頁（`slides/00N.svg`）或「整份」。沒指定時先 `comotion ls <presentation-id> slides` 看現況，問使用者是哪一頁或整份，問清楚前不下任何寫入命令。
- 風格（選填）：「保守」或「活潑」；不指定時用預設值。

## 步驟

1. **指定的頁不存在**：回報「這份簡報只有 N 頁」，不執行、不改成最接近的一頁。
2. **讀該頁的結構**：`comotion cat <presentation-id> slides/00N.svg`，依 `data-comot-role`、`data-comot-name`、`font-size`、`y` 座標排出順序：標題 → 要點逐條 → 圖／表／圖表。進不進動畫看角色（第 5.2 節）：`garnish`、`background`、頁尾，以及沒有 `data-comot-name` 又像裝飾的元素（滿版 `<rect>`、線、圓）都留在第一格。
3. **該頁已有效果時先看現況**：`comotion effect list <presentation-id> slides/00N.svg`，讀過才動。
   - 使用者要「重做」：`comotion effect remove <presentation-id> slides/00N.svg <全部 1-based index，逗號分隔>`，再依步驟 4 重新加。
   - 使用者要「補」：只對缺的元素 `effect add`，需要時用 `comotion effect move <presentation-id> slides/00N.svg <index> up|down` 把順序調對。
4. **先分段，再加效果**：把這一頁的元素按「講者會分幾段講」分組——標題一段，之後每個要點（或每組對照）一段；標題的底線、卡片的編號、數字的說明屬於它所在的那一段。**一段一個 `on-click`**，一頁不超過 5 個。同一段已經是一個群組時直接對群組 id 下一個效果；沒有群組時段內其餘元素用 `--start with-previous`。對每個錨點跑一次 `comotion effect add`，風格對應的 family／effect／duration：

   | 風格 | 標題 | 要點 | 圖／表／圖表 | duration |
   |---|---|---|---|---|
   | 預設（未指定） | `enter/fade` | `enter/fade` | `enter/fade` | `0.4` |
   | 保守 | `enter/fade` | `enter/fade` | 不加 | `0.3` |
   | 活潑 | `enter/zoom` | `enter/fly-up` | `enter/zoom` | `0.5` |

5. **目標是「整份」**：逐頁重複步驟 2–4；使用者也要轉場時，跑一次 `comotion slide transition set <presentation-id> <任一頁路徑> --enter fade --enter-duration 0.4 --all`（`--all` 套用到整份）。
6. **秒數一律用秒**：使用者說「300 毫秒」要換算成 `0.3` 再下 `--duration`／`--delay`。
7. **驗證**：`effect list` 讀回確認順序。

## 收尾

動完之後、回覆之前跑一次 `comotion validate <presentation-id>`（只動一頁就驗那一頁），把結果寫進回報的第一行；`errors` 不是空的就修完再驗，修到 0 錯誤才結束這一輪（見 `AGENTS.md` 的「收尾條件」）。

## 回報格式

逐頁列出：頁面路徑、每個錨點加了什麼效果（family/effect/start/duration），以及是否有調整轉場。「補」或「重做」既有效果時，說明改動前後的差異。
