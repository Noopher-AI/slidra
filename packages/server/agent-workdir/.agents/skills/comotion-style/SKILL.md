---
name: comotion-style
description: 統一整份簡報的字級、顏色、字重與字型，或把某一頁的樣式套到全部
---

# 統一樣式

使用者說「全部標題改成一樣大小」「正文顏色統一」「把這頁的樣式套到全部」時的完整流程。樣式改動只涵蓋顏色、字級、字型、字重（見「不可做的事」），不含行距。
命令的完整參數見 `reference/commands.md`，這裡只寫順序與容易做錯的地方。

## 觸發語

「統一字級」「正文顏色改成」「標題都改成一樣大小」「把這頁樣式套到全部」「改頁面底色」。

## 輸入格式

- 目標角色：標題／正文／全部文字，或指定一頁的樣式當範本。
- 目標屬性與值：字級（數字）、顏色（`#RRGGBB`）、字型、字重、或頁面底色／強調色。

## 步驟

1. **沒指定目標或值時不要猜**：先 `co-motion ls <presentation-id> slides` 看現況，問使用者缺的那一項，**不執行任何寫入命令**。
2. **統一全份標題／正文的字級或顏色**：逐頁 `co-motion cat <presentation-id> slides/00N.svg`，依 `data-comot-name` 找出對應角色的元素（標題類，或該頁 `font-size` 最大的文字元素視為標題；其餘文字元素視為正文），再 `co-motion element style set <presentation-id> slides/00N.svg <el-ids 逗號分隔> <attr> <value>`。
3. **色碼一律加 `#` 並用單引號**：例如 `element style set … fill '#F4F6F8'`。
4. **把第 N 頁的樣式套到全部**：先 `cat` 第 N 頁，讀出標題與正文的 `font-size`／`fill`／`font-family`／`font-weight` 實際值，把讀到的值列給使用者確認，再逐頁套用到其他頁的對應角色元素。
5. **頁面底色與元素底色是兩回事**：`co-motion slide style set <presentation-id> slides/00N.svg --background '#RRGGBB'` 改的是根 `<svg>` 的樣式；如果那一頁另外有一個滿版背景 `<rect>` 元素，`--background` 會被那個 `<rect>` 蓋住看不出效果，要改視覺底色必須改那個 `<rect>` 的 `fill`（走 `element style set`）。**先問使用者是哪一種**，不要自己猜。
6. **目標是表格或圖表元素**：命令會回「請用 table／chart 命令族調整」，把原始錯誤轉述給使用者，並建議改用 `/comotion-table` 或 `/comotion-chart`。
7. **要改一段文字內的部分字重／字型（例如某幾個字加粗）**：只有文字框（有 `data-comot-text-width` 屬性的元素）能用 `co-motion text style set <presentation-id> slides/00N.svg <el> --range <起:訖> <attr> <value>`。純 `<text>` 元素跑這個命令會回「元素不是文字框」，此時改用 `element style set <id> font-weight 700`（整個元素一起改），並跟使用者說明差異：文字框可以只改一部分字元，純 `<text>` 元素只能整個一起改。

## 使用的命令

`co-motion cat`、`co-motion element style set`、`co-motion text style set`、`co-motion slide style set`。

## 回報格式

列出改動的元素 id、屬性、新值，以及套用的頁面範圍。若涉及「套用第 N 頁樣式」，列出讀到的原始值。若使用者要求行距，說明目前不支援並停在這裡。

## 不可做的事

- **不做行距／段距**：樣式白名單目前沒有 `line-height`，命令會回「樣式屬性 line-height 不在樣式白名單內」。使用者要求行距或段距時，**明確回答目前不支援**，不得用改 `y` 座標、縮放、加空行等方式假造效果。
- 不使用雙引號或反斜線；引號一律用單引號。
- 不使用管線或重導向驗證結果——一律用 `cat` 讀回。
- 不寫任何檔案。
- 不對表格或圖表元素直接用 `element style set`／`text style set`——改用對應的 `table`／`chart` 命令族。
- 不在純 `<text>` 元素上使用 `text style set --range`。
