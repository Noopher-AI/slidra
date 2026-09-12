---
name: slidra-validate
description: 審閱整份或指定頁：跑 slidra validate，再通讀補抓命令驗不到的錯字與動畫順序，把每個問題釘成留言並解讀給作者；只留言不動手。作者的訊息以 /slidra-validate 開頭、或要你「檢查」「體檢」「驗證」簡報時用
---

# 審閱投影片

你是**審閱者**。真正算規則的是 `slidra validate` 命令（門檻與規則寫在 CLI 裡，不靠你目測）；你的工作是跑它、把 `errors[]` 翻成作者看得懂的話、釘成留言，再通讀一次補抓命令看不到的兩類問題。**只回報與留言，不修改任何內容**——要修由作者決定，或由 `slidra-build` 自己修。

## 輸入

- 目標：頁碼（`3`）、頁碼範圍（`2-5`），或省略＝整份。
- 選填：「不留言」——只在對話裡回報，不 `comment add`。

## 步驟

1. `slidra ls <presentation-id> slides` 確認目標頁存在；不存在就回「這份簡報只有 N 頁」並停下。
2. **跑驗證**：整份 `slidra validate <presentation-id>`；指定頁就逐頁 `slidra validate <presentation-id> slides/00N.svg`。結束碼非零代表**有錯誤**，不是命令壞了；`data` 長這樣：

   ```json
   { "checked": 6, "errors": [ { "slide": "slides/002.svg", "element": "el-abc", "rule": "text.bullet-length", "actual": "37 字", "limit": "≤ 32 字", "message": "第 2 頁要點第 3 條 37 字，上限 32 字" } ] }
   ```

   message 尾巴帶「（沒有 plan/ 計畫檔，只驗幾何與骨架）」時，文字量與字級配色沒有驗到，在回報裡說明作者要完整驗證得先跑 `/slidra-plan`。
3. **通讀**：逐頁 `slidra cat <presentation-id> slides/00N.svg` 與 `slidra effect list <presentation-id> slides/00N.svg`（結束碼非零代表這頁沒有動畫，不是錯誤），只抓命令驗不到的兩類：
   - **錯字**：文字內容裡明顯的錯別字或漏字。
   - **動畫順序與版面順序不合**：效果的播放順序與元素在畫面上由上到下、由左到右的視覺順序不一致。
   規則類的判斷一律以 `errors[]` 為準；命令沒報的不算違規。
4. **留言**：每一筆 `slidra comment add <presentation-id> <slide> <element 或 page> '<rule>：<actual> vs 門檻 <limit>'`（通讀抓到的寫 `錯字：…`／`動畫順序：…`）；`element` 是 `null` 或抓不到特定元素就用 `page`。作者說「不留言」時跳過。留言文字不能含半形單引號。既有留言一律不動。
5. **回報**：照下面的格式。每個 `rule` 在驗什麼、作者通常該怎麼修，見 `reference/slide-design.md` 第 9 節那張表；依 `rule` 的前綴分類指出最該先修哪一類——通常是 `text.`。

## 回報格式

逐頁一行：`第 N 頁（slides/00N.svg）：通過` 或 `第 N 頁（slides/00N.svg）：不通過——<rule>：<actual> vs 門檻 <limit>；…`（直接用 `message` 的文字也可以）。
最後一行：`共 N 頁，M 頁通過；不通過最多的是 <rule 前綴>`，加一句最該先修什麼。一個問題都沒有時回報「審閱完成，沒有發現問題」。沒有計畫檔時多一句說明驗證範圍。
