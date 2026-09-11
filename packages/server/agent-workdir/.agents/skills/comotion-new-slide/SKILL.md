---
name: comotion-new-slide
description: 在簡報最後（或指定位置）新增一頁：有計畫就照設計指南的頁型範例一頁寫一份 SVG 並套動畫，沒有計畫才照抄既有版面或退回指南的骨架
---

# 新增一頁投影片

使用者說「加一頁講 X」時的完整流程。命令的完整參數見 `reference/commands.md`，這裡只寫順序與容易做錯的地方。

## 步驟

1. **先看現有的頁**：`co-motion ls <presentation-id> slides`
   知道目前有幾頁、新頁會變成第幾頁。

2. **決定怎麼做，依序判斷**：
   - **有計畫**（`co-motion cat <presentation-id> plan/design-spec.md` 讀得到）：讀出配色、字級表與 `plan/outline.md` 的 `animation`；依 `reference/slide-design.md` 第 6.1 節先判斷這一頁的關係（並列→`membership`、順序→`order`、A vs B→`contrast`、單一主張或數字→`none`…），再依第 6.2 節挑一個解；剛好是第 6.3 節的已知解就取第 4 節該頁型的完整 SVG 範例，`<role>` 換成色碼、範例文字換成使用者給的關鍵詞，`co-motion slide add <presentation-id> --svg '<SVG>'`（`--at <索引>` 指定位置）；接著 `slide style set --background`；**背景類型的裝飾（大圓、光暈、色團、光束、對角線、格線、光點）不進頁面 SVG**——那些都在背景圖資產裡，頁面 SVG 只有內容、scrim 與頁尾；也不要自己加範例以外的裝飾幾何。**其他頁有背景圖時**（`cat` 任一頁看得到 `data-comot-role="background"` 的 `<image href="../assets/…">`）新頁也要有：把第 4b 節該頁型的 scrim rect 寫進 SVG，再 `co-motion slide background set <presentation-id> slides/00N.svg --asset <同一個 assets/ 路徑> --opacity <第 4b 節建議值>`，不要另建資產；然後把同一段裡的元素 `co-motion element group` 起來（要點頁每張卡片一組、對照頁左右各一組），再依第 5 節對群組套動畫（強度照計畫，一段一個 on-click，背景圖不加效果）、`slide notes set` 寫講稿。也把這一頁補進 `plan/outline.md` 的 `pages`（必填 `relationship`，用了已知解才填 `type`；`status` 維持不變）。
   - **沒有計畫但有範本**：`co-motion template list <presentation-id>`，有對應頁型的範本就 `co-motion slide add <presentation-id> --template <file 路徑>`，再 `text set` 覆寫文字。
   - **沒有計畫、沒有範本，但有結構相近的一頁**：`co-motion slide duplicate <presentation-id> slides/00N.svg` 複製它，再改文字。
   - **什麼都沒有**：照 `reference/slide-design.md` 第 4 節的骨架、配色 B 淺色簡潔，`slide add --svg` 寫一頁。不要自己發明版面。
   頁面只放關鍵詞（一條要點以 1 行為目標，`validate` 的上限是 2 行 32 字），完整句子寫進 `co-motion slide notes set`。

3. **驗收**：`co-motion validate <presentation-id> slides/00N.svg`，有錯誤就修到 0；沒有計畫檔時它只驗幾何與骨架，另外 `cat` 讀回確認文字真的寫進去了。
   做完把新頁的路徑（`slides/00N.svg`）告訴使用者。

## 容易做錯的地方

- **SVG 的引號**：整段用單引號包住，裡面只用雙引號，不能有半形單引號；文字裡的 `&` 寫 `&amp;`。
- **背景圖要跟整份一致**：整份有背景圖，新頁沒有，會在縮圖列裡特別突兀；同理整份沒有就不要單獨加。
- **所有文字用文字框宣告**（`<text data-comot-text-width=…>`），內容直接換行分段；不要自己放 `<tspan>`，否則不能就地編輯、`validate` 也驗不到。
- **不要用 `slide add` 之後才發現是空白頁**：沒帶 `--svg`／`--template` 的 `slide add` 是空白頁，沒有任何文字元素，接著下 `text set` 會找不到 element id。
- **索引從 1 開始，檔名補零到三位**：第 2 頁是 `slides/002.svg`。
- **一次只做一頁**：使用者說「加三頁」時，一頁做完並確認過再做下一頁，
  中途出錯才知道停在哪裡。
