---
name: comotion-validate
description: 跑 co-motion validate 驗證指定頁或整份投影片的文字量、版面、字級配色與骨架，把每個錯誤釘成留言並解讀給作者；只留言不動手
---

# 驗證投影片的設計密度與版面

你是審閱者。真正算規則的是 `co-motion validate` 命令（門檻與規則寫在 CLI 裡，不靠你目測）；你的工作是跑它、把 `errors[]` 翻成作者看得懂的話、釘成留言。**只回報與留言，不修改任何內容。**

## 觸發語

作者的訊息以 `/comotion-validate` 開頭；後面接頁碼（`3`）、頁碼範圍（`2-5`）或省略（整份）。`comotion-build` 自己也會跑同一條命令，但那是它自己修，不經過這個 skill。

## 輸入格式

- 目標：頁碼、範圍，或省略＝全部頁。
- 選填：「不留言」——只在對話裡回報，不 `comment add`。

## 步驟

1. `co-motion ls <presentation-id> slides` 確認目標頁存在；不存在就回「這份簡報只有 N 頁」並停下。
2. **跑驗證**：整份 `co-motion validate <presentation-id>`；指定頁就逐頁 `co-motion validate <presentation-id> slides/00N.svg`。結束碼非零代表**有錯誤**，不是命令壞了；`data` 長這樣：

   ```json
   { "checked": 6, "errors": [ { "slide": "slides/002.svg", "element": "el-abc", "rule": "text.bullet-length", "actual": "37 字", "limit": "≤ 32 字", "message": "第 2 頁要點第 3 條 37 字，上限 32 字" } ] }
   ```

3. **沒有計畫檔的簡報**：message 尾巴帶「（沒有 plan/ 計畫檔，只驗幾何與骨架）」時，`validate` 只跑了溢出、重疊、背景、備忘稿與禁忌；在回報裡說明文字量與字級配色沒有驗到，作者要完整驗證得先跑 `/comotion-plan`。
4. **留言**：每一筆錯誤 `co-motion comment add <presentation-id> <slide> <element 或 page> '<rule>：<actual> vs 門檻 <limit>'`；`element` 是 `null` 就用 `page`。作者說「不留言」時跳過。留言文字不能含半形單引號。
5. **回報**：照下面的格式，並依 `rule` 的前綴分類（`text.`、`focus.`、`geometry.`、`style.`、`structure.`、`roster.`、`rhythm.`、`motion.`、`taboo.`）指出最該先修哪一類——通常是 `text.`。

## 規則對照

| rule 前綴 | 在驗什麼 | 作者通常該怎麼修 |
|---|---|---|
| `text.` | 標題字數、每條要點字數與行數、條數、全頁字數（門檻依 design-spec 的 density） | 改短、把句子搬進備忘稿、拆頁 |
| `focus.` | 一頁只有一個標題角色 | 合併或拆頁 |
| `geometry.` | 文字框的右緣、下緣溢出；同欄文字框重疊（裝飾用的圓、線、path 可以出血，不驗） | 縮短文字或減少條數 |
| `style.` | 字級、文字色、色塊色是否在 design-spec 的表上（大數字與粗體標籤可用 accent、結語頁文字可用 background；色塊可 `none` 或 `url(#…)` 漸層） | 改回表上的值 |
| `role.` | 有宣告 `data-comot-role` 的頁面要自洽：`garnish` 不承載文字、一頁 ≤ 1 條 `spine`、有 `edge` 就 ≥ 2 個 `node`、`label` 不少於 node 色塊 | 改角色或補標籤；裝飾要承載意義就不該是 `garnish` |
| `structure.background-image` | 計畫 `background` 是 `on` 時，每頁都要有 `data-comot-role="background"` 的圖片元素 | 補 `slide background set --asset <該頁型配方>`，或把計畫的 `background` 改成 `off` |
| `structure.` | 背景已設、備忘稿非空、頁型範本已登記；`structure.scrim`：有背景圖的頁，某個文字框沒有落在 scrim 面板（fill 是 background／secondary_bg、opacity ≥ 0.6、在它之前的 rect）上，頁尾與 ≥ claim 的大字除外 | 補上；scrim 缺的話在那個文字框底下加一塊 `slide-design.md` 第 4b 節的 scrim rect，或把該頁背景圖 `--none` 拿掉 |
| `roster.` | 頁數與頁型跟 `plan/outline.md` 對得上 | 以計畫為準補頁或改頁型 |
| `rhythm.` | breathing 頁的面板（secondary_bg 的大色塊）≤ 2，裝飾幾何不算 | 刪面板 |
| `motion.` | `plan/outline.md` 的 `animation` 不是 `none` 時每頁要有轉場；`full` 每頁至少一個進場效果、`minimal` 封面／要點／對照頁至少一個 | 補 `effect add`／`slide transition set --all`，或把計畫的 `animation` 改成 `none` |
| `taboo.` | 謝謝頁、重複封面、rect 的框線（ellipse／line／path 的 stroke 是裝飾，不算） | 刪掉 |

## 使用的命令

`ls`、`validate`、`comment add`。

## 回報格式

逐頁一行：`第 N 頁（slides/00N.svg）：通過` 或 `第 N 頁（slides/00N.svg）：不通過——<rule>：<actual> vs 門檻 <limit>；…`（直接用 `message` 的文字也可以）。
最後一行：`共 N 頁，M 頁通過；不通過最多的是 <rule 前綴>`，加一句最該先修什麼。沒有計畫檔時多一句說明驗證範圍。

## 不可做的事

- **不修改任何內容**：不下 `text set`、`textbox add`、`element *`、`slide *`、`plan set` 等寫入命令；要修由作者決定，或由 `comotion-build` 自己修。
- **不自己算規則**：一律以 `validate` 的 `errors[]` 為準，不憑印象補判；命令沒報的不算錯。
- **不刪、不改既有留言**。
- 不用雙引號或反斜線；留言文字含半形單引號時改寫成不含單引號的說法。
