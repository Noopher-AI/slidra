---
name: slidra-style
description: 統一整份簡報的字級、顏色、字重與字型，或把某一頁的樣式套到全部，或改頁面底色。使用者說「統一字級」「正文顏色改成」「標題都改成一樣大小」「把這頁樣式套到全部」「改頁面底色」或訊息以 /slidra-style 開頭時用
---

# 統一樣式

樣式改動涵蓋顏色、字級、字型、字重與頁面底色；行距不在樣式白名單裡（見步驟 7）。

## 輸入

- 目標角色：標題／正文／全部文字，或指定一頁的樣式當範本。
- 目標屬性與值：字級（數字）、顏色（`#RRGGBB`）、字型、字重、或頁面底色／強調色。
- 缺目標或缺值時先 `slidra ls <presentation-id> slides` 看現況，問使用者缺的那一項，問清楚前不下任何寫入命令。

## 步驟

1. **統一全份標題／正文的字級或顏色**：逐頁 `slidra cat <presentation-id> slides/00N.svg`，依 `data-slidra-name` 找出對應角色的元素（標題類，或該頁 `font-size` 最大的文字元素視為標題；其餘文字元素視為正文），再 `slidra element style set <presentation-id> slides/00N.svg <el-ids 逗號分隔> <attr> <value>`。色碼加 `#` 並用單引號：`fill '#F4F6F8'`。
2. **把第 N 頁的樣式套到全部**：先 `cat` 第 N 頁，讀出標題與正文的 `font-size`／`fill`／`font-family`／`font-weight` 實際值，把讀到的值列給使用者確認，再逐頁套用到其他頁的對應角色元素。
3. **字型**：只能寫簡報已內嵌的家族（`slidra cat <presentation-id> project.json` 的 `fonts`）；沒有的照 `reference/fonts.md` 先 `font import`。
4. **頁面底色與元素底色是兩回事**：`slidra slide style set <presentation-id> slides/00N.svg --background '#RRGGBB'` 改的是根 `<svg>` 的樣式；那一頁另外有滿版背景 `<rect>` 元素時，`--background` 會被它蓋住看不出效果，要改視覺底色得改那個 `<rect>` 的 `fill`（走 `element style set`）。先問使用者是哪一種。
5. **目標是表格或圖表元素**：命令會回「請用 table／chart 命令族調整」，把原始錯誤轉述給使用者，建議改用 `/slidra-table` 或 `/slidra-chart`。
6. **改一段文字內的部分字重／字型**：只有文字框（有 `data-slidra-text-width` 屬性的元素）能用 `slidra text style set <presentation-id> slides/00N.svg <el> --range <起:訖> <attr> <value>`。純 `<text>` 元素會回「元素不是文字框」，改用 `element style set <id> font-weight 700`（整個元素一起改），並跟使用者說明差異。
7. **使用者要求行距或段距**：明確回答目前不支援（白名單沒有 `line-height`），停在這裡；改 `y` 座標、縮放、加空行都不是行距。
8. **驗證**：`cat` 讀回確認屬性真的改了。

## 收尾

動完之後、回覆之前跑一次 `slidra validate <presentation-id>`（只動一頁就驗那一頁），把結果寫進回報的第一行；`errors` 不是空的就修完再驗，修到 0 錯誤才結束這一輪（見 `AGENTS.md` 的「收尾條件」）。

## 回報格式

列出改動的元素 id、屬性、新值，以及套用的頁面範圍。若涉及「套用第 N 頁樣式」，列出讀到的原始值。
