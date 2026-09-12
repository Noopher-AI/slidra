---
name: slidra-new-slide
description: 在簡報最後（或指定位置）新增一頁講某件事：有計畫就照 build 的六階段寫一頁 SVG 並補進計畫，沒有計畫才用範本、複製相近頁、或從版面庫寫一頁。作者說「加一頁講 X」或訊息以 /slidra-new-slide 開頭時用
---

# 新增一頁投影片

## 步驟

1. **先看現有的頁**：`slidra ls <presentation-id> slides`，知道目前有幾頁、新頁會變成第幾頁。索引從 1 開始，檔名補零到三位（第 2 頁是 `slides/002.svg`）。
2. **決定怎麼做，依序判斷**：
   - **有計畫**（`slidra cat <presentation-id> plan/design-spec.md` 讀得到）：這一頁照 `slidra-build` 步驟 4 的六階段做（構圖→背景→前景→群組→動畫→檢視），關係依 `reference/slide-design.md` 第 6.1 節自己判，相鄰頁用過的 `blueprint.shape` 同關係就換一個；其他頁有背景圖時（`cat` 任一頁看得到 `data-slidra-role="background"`）新頁重用同一個 `assets/` 路徑，不另建資產。做完把這一頁補進 `plan/outline.md` 的 `pages`（必填 `relationship` 與 `blueprint`，用了已知解才填 `type`；`status` 維持不變）。
   - **沒有計畫但有範本**：`slidra template list <presentation-id>`，有對應頁型的範本就 `slidra slide add <presentation-id> --template <file 路徑>`，再 `text set` 覆寫文字。
   - **沒有計畫、沒有範本，但有結構相近的一頁**：`slidra slide duplicate <presentation-id> slides/00N.svg` 複製它，再 `text set` 改文字。
   - **什麼都沒有**：從 `slidra-layout-kit` 挑一個解，配色用 `slidra-style-kit` 的 `03 clean-brief`，照 `slide-design.md` 第 0 節的語法 `slide add --svg` 寫一頁——送出前先過該節的自檢清單，沒過的頁面會被整頁拒收。
   頁面只放關鍵詞（一條要點以 1 行為目標），完整句子寫進 `slidra slide notes set`。
3. **驗收**：`slidra validate <presentation-id> slides/00N.svg` 修到 0 錯誤（沒有計畫檔時它只驗幾何與骨架，另外 `cat` 讀回確認文字真的寫進去了）。把新頁的路徑告訴使用者。

## 容易做錯的地方

- 沒帶 `--svg`／`--template` 的 `slide add` 是空白頁，沒有任何文字元素，接著下 `text set` 會找不到 element id。
- 整份有背景圖，新頁也要有；整份沒有就不要單獨加——縮圖列裡會特別突兀。
- 使用者說「加三頁」時，一頁做完並確認過再做下一頁。
