---
name: comotion-plan
description: 把大綱或文章規劃成逐頁計畫與設計規格（敘事模式、頁型、節奏、配色、字級），寫進 plan/ 後停下來等作者在確認視窗裡拍板，不動任何投影片
---

# 規劃整份簡報

你是策略師。這個 skill 只做**計畫**：讀大綱、挑敘事模式、決定每一頁的頁型與主張、選配色與字級，寫進 `plan/outline.md` 與 `plan/design-spec.md`，然後**停下來**。動手做頁面是 `comotion-build` 的事，而且它只在作者確認計畫之後才會開工。

## 觸發語

作者的訊息以 `/comotion-plan` 開頭。編輯器的 `New → From outline…` 送出的也是這個形式。

## 輸入格式

斜線後面是一份大綱或一篇文章（條列式小節，縮排的行是上一行的要點；或整段文章，由你抓出小節）。輸入的**開頭**可能有一行指示，不是大綱內容，不要排進計畫：

- 「【從大綱規劃】這份簡報還沒有任何投影片。」或「【從大綱規劃】目前有 N 頁，新頁接在最後。」——位置指示；有既有頁面時，計畫的 `pages` 只涵蓋新頁，`n` 從 N+1 起算。
- 「【重做】<作者的話>」——作者在確認視窗按了「重新規劃」，後面那段話是他要改的地方；依它重寫計畫，其餘沿用上一版。

## 步驟

1. **看現況**：`co-motion cat <presentation-id> project.json`（畫布尺寸、頁數）、`co-motion plan list <presentation-id>`、`co-motion template list <presentation-id>`。
   - 已有 `status` 為 `confirmed` 的計畫，且輸入不是【重做】：**先不要寫**，在對話裡問作者「已有一份確認過的計畫，要重做還是沿用」，等他回答。
   - 輸入完全空白、或只是一句閒聊：不要猜，回一句話問作者要用哪份大綱。
2. **讀規範**：用你原生的檔案讀取能力讀工作目錄裡的 `reference/modes.md` 與 `reference/slide-design.md`（第 2、3、6、7 節）。
3. **挑敘事模式**：看內文小節的論證走向（不是看封面），依 `modes.md` 挑一種，並記下一句理由——這句理由之後要放進題目的 `note`。作者的大綱明顯是話題式標題或明說了模式時，以作者為準。
4. **逐節挑頁型與節奏**：第一層主題當封面（`cover`，`anchor`）；其餘每個小節依 `slide-design.md` 第 6 節的對照表決定頁型（並列要點→`bullets`、A vs B→`compare`、一個數字或一句主張→`number`、只有小節名→`section`）；最後一節是結論或下一步才做 `closing`。節奏：封面、章節、結語是 `anchor`；`number` 頁是 `breathing`；其餘 `dense`。6 條以上的要點拆成兩頁；沒有結論就不做結語頁；**不為了頁數或節奏捏假頁**。
5. **寫逐頁計畫**：每一頁列出主張（一句話，以 15 字內為目標、上限 24 字，會成為標題）、聽眾變化（聽完這頁之前／之後有什麼不同——寫不出來的頁面就該合併或砍掉）、頁面關鍵詞（以 18 字內為目標、上限 32 字，這是頁面上真正會出現的字）、備忘稿要講的 2～3 句（作者要點的完整版，**不得虛構任何數據、名稱、日期**）。
6. **出題**：3～7 題，第一題固定問敘事模式，最後兩題固定問動畫（`id` 為 `animation`，`recommended` 為 `full`，選項 `full`＝完整、`minimal`＝只做標題與要點、`none`＝不加）與背景圖（`id` 為 `background`，`recommended` 為 `on`，選項 `on`＝有背景圖、`off`＝不加；`note` 說明會用哪種配方）；中間每一題對應一個你拿不準的頁型判斷（例如「第 5 頁的 12 分鐘要不要做成大數字頁」）或配色。每題都要有 `recommended`（你的建議，必須是 `options` 之一）、2～4 個 `options`、一句 `note` 寫你的觀點；需要作者補資料的題目開 `free_text`。
7. **寫入 `plan/outline.md`**：`co-motion plan set <presentation-id> outline '<全文>'`。全文＝開頭一個 ```` ```json ```` 圍欄（欄位見下方，含 `animation` 預設 `full`、`background` 預設 `on`）＋ 其後每頁一節 `## 第 N 頁：<主張>`，底下四行：主張、聽眾變化、頁面關鍵詞（一行一條）、備忘稿。`status` 一律 `draft`。正文不能含半形單引號 `'`（打不進命令列）。
8. **寫入 `plan/design-spec.md`**：依 `slide-design.md` 第 3 節挑**一組**配色（作者指定了顏色或風格就照作者）、密度預設 `presentation`、字級表照第 2 節（`cover` 是 72；畫布不是 1280×720 時每個字級乘以 `k = width ÷ 1280`）、`layout` 錨點（沿用預設即可，畫布不同時乘以 `k`）、`visual` 固定 `editorial-tech`，`co-motion plan set <presentation-id> design-spec '<全文>'`。正文寫一句為什麼選這組配色與這個密度。
9. **停下來**：不下任何 `slide`、`textbox`、`element` 命令。回報時說明「計畫已寫好，編輯器會彈出確認視窗；按確認並建置就會開工」。沒有視窗的環境（作者直接在終端機對話）就把計畫表貼在對話裡，請作者回覆 `/comotion-build 【計畫確認】` 加上每題的答案。

## `plan/outline.md` 的 JSON 段

```json
{
  "status": "draft",
  "mode": "pyramid",
  "animation": "full",
  "background": "on",
  "pages": [
    { "n": 1, "type": "cover", "rhythm": "anchor", "title": "從大綱到上台只要 12 分鐘" },
    { "n": 2, "type": "bullets", "rhythm": "dense", "title": "簡報是最常重做的文件" }
  ],
  "questions": [
    {
      "id": "mode",
      "question": "這份簡報的敘事骨架",
      "note": "內文先鋪問題、再給數據與下一步，結論先行最省聽眾時間。",
      "recommended": "pyramid",
      "options": [ { "value": "pyramid", "label": "結論先行" }, { "value": "narrative", "label": "故事線" }, { "value": "briefing", "label": "中性簡報" } ],
      "free_text": false
    },
    {
      "id": "animation",
      "question": "動畫強度",
      "note": "逐步揭露能讓聽眾跟著你的節奏看，發表場合建議完整。",
      "recommended": "full",
      "options": [ { "value": "full", "label": "完整" }, { "value": "minimal", "label": "只做標題與要點" }, { "value": "none", "label": "不加" } ],
      "free_text": false
    },
    {
      "id": "background",
      "question": "背景圖",
      "note": "封面與結語用柔焦色團、內容頁用淡版點陣格線，由我用 SVG 產生；不加就是純色底。",
      "recommended": "on",
      "options": [ { "value": "on", "label": "有背景圖" }, { "value": "off", "label": "不加" } ],
      "free_text": false
    }
  ]
}
```

`animation` 只能是 `full`、`minimal`、`none`（省略視同 `full`）；`background` 只能是 `on`、`off`（省略視同 `on`）。`type` 只能是 `cover`、`section`、`bullets`、`compare`、`number`、`closing`；`rhythm` 只能是 `anchor`、`dense`、`breathing`；`n` 從 1（或既有頁數 +1）連續遞增；`questions[].id` 用英數與 `-`，同一份內不重複。

每頁另有一個**選用的 `blueprint` 物件**（`relationship`／`nodes`／`steps`），那是 `comotion-build` 在構圖階段寫的，**plan 階段不要寫**；重新規劃時也不要把既有的 blueprint 刪掉，除非那一頁的內容真的改了。

## `plan/design-spec.md` 的 JSON 段

```json
{
  "density": "presentation",
  "palette": { "background": "#101418", "secondary_bg": "#1B2129", "primary": "#4F8DFF", "accent": "#F5B942", "secondary_accent": "#6DD3A5", "text": "#F4F6F8", "muted": "#9AA7B4" },
  "type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 },
  "layout": { "side_margin": 80, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "visual": "editorial-tech"
}
```

`layout` 是**整份共用的版面錨點**：安全區的三個邊界、欄間距、以及允許的間距級距。這份簡報每一頁的座標都可以不一樣，但**這幾個數字全份一致**——`validate` 用三個邊界驗溢出，`gutter` 與 `spacing` 是 build 排版時唯一該取用的間距來源（不要每頁自己發明數字）。整組可省略，省略時就是上面這些預設值；寫了就必須是合法數字，打錯會直接報錯。畫布不是 1280×720 時，這些值跟字級一樣乘以 `k`。

## 使用的命令

`cat`、`plan list`、`plan set`、`template list`。

## 回報格式

先一行：模式與理由、配色組、動畫強度、有無背景圖、共幾頁。接著一張表，每頁一列：`頁碼｜頁型｜節奏｜主張`。最後一行固定：「計畫已寫進 plan/，請在確認視窗裡拍板；要改哪一頁可以按重新規劃並告訴我。」

## 不可做的事

- **不做任何投影片**：這個 skill 只寫 `plan/`，`slide add`、`textbox add`、`element insert` 等一律不碰；建置是 `comotion-build` 的事。
- **不覆蓋已確認的計畫**：`status` 是 `confirmed` 時先問作者，除非輸入是【重做】。
- **不虛構內容**：主張、關鍵詞、備忘稿只能來自作者的大綱；缺的資料用 `free_text` 題目問，不要編。
- **不把 JSON 貼進對話**：作者看的是表格與視窗，JSON 只寫進檔案。
- **不做「謝謝」頁、不重複封面、不為湊頁數拆或捏頁面**。
- 正文與題目文字不可含半形單引號；有就改寫。
