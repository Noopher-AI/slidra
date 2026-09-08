---
name: comotion-new-slide
description: 在簡報最後（或指定位置）新增一頁，放上標題與內文，並確認結果真的長對了
---

# 新增一頁投影片

使用者說「加一頁講 X」時的完整流程。每一步都用 `co-motion`，不要自己寫 SVG。
命令的完整參數見 `reference/commands.md`，這裡只寫順序與容易做錯的地方。

## 步驟

1. **先看現有的頁**：`co-motion ls <presentation-id> slides`
   知道目前有幾頁、新頁會變成第幾頁。

2. **照抄既有版面，而不是從空白開始**：如果已有結構相近的一頁，用
   `co-motion slide duplicate <presentation-id> slides/00N.svg` 複製它，再改文字。
   這樣字級、邊界、配色都會跟整份簡報一致。
   真的沒有可抄的版面時才用 `co-motion slide add <presentation-id>`（`--at <索引>` 指定插入位置，省略則加到最後）。

3. **改文字**：複製來的頁面用 `co-motion text set` 覆寫既有元素的文字；
   空白頁才需要 `co-motion textbox add ... --x --y --width --text`。
   要下 `--x/--y` 之前，先 `co-motion cat <presentation-id> slides/00N.svg`
   看鄰近頁面同類元素的座標，照抄那組數字——不要自己猜版面。

4. **驗收**：`co-motion cat <presentation-id> slides/00N.svg` 確認文字真的寫進去了。
   做完把新頁的路徑（`slides/00N.svg`）告訴使用者。

## 容易做錯的地方

- **不要用 `slide add` 之後才發現是空白頁**：空白頁沒有任何文字元素，
  接著下 `text set` 會找不到 element id。空白頁一定要走 `textbox add`。
- **索引從 1 開始，檔名補零到三位**：第 2 頁是 `slides/002.svg`。
- **一次只做一頁**：使用者說「加三頁」時，一頁做完並確認過再做下一頁，
  中途出錯才知道停在哪裡。
