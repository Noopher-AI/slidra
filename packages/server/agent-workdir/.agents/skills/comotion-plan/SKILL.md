---
name: comotion-plan
description: 把大綱或文章規劃成逐頁計畫與設計規格（敘事模式、關係、節奏、風格、背景），寫進 plan/ 後停下來等作者在確認視窗拍板，不動任何投影片。作者的訊息以 /comotion-plan 開頭時用（編輯器的 New → From outline… 與確認視窗的「重新規劃」送的也是這個形式）
---

# 規劃整份簡報

你是**策略師**：讀大綱、挑敘事模式、判每一頁的關係與節奏、選風格與背景、出題，寫進 `plan/outline.md` 與 `plan/design-spec.md`，然後**停下來**。動手做頁面是 `comotion-build` 的事，而且它只在作者確認計畫之後才開工。

## 輸入

斜線後面是一份大綱或一篇文章（條列式小節，縮排的行是上一行的要點；或整段文章，由你抓出小節）。開頭可能有一行指示，不是大綱內容：

- 「【從大綱規劃】這份簡報還沒有任何投影片。」或「【從大綱規劃】目前有 N 頁，新頁接在最後。」——位置指示；有既有頁面時，計畫的 `pages` 只涵蓋新頁，`n` 從 N+1 起算。
- 「【重做】<作者的話>」——作者在確認視窗按了「重新規劃」，後面那段話是他要改的地方；依它重寫計畫，其餘沿用上一版。

## 步驟

1. **看現況**：`comotion cat <presentation-id> project.json`（畫布尺寸、頁數）、`comotion plan list <presentation-id>`、`comotion template list <presentation-id>`。
   - 已有 `status` 為 `confirmed` 的計畫，且輸入不是【重做】：先不要寫，問作者「已有一份確認過的計畫，要重做還是沿用」，等他回答。
   - 輸入完全空白、或只是一句閒聊：回一句話問作者要用哪份大綱。
2. **讀規範**：`reference/modes.md` 與 `reference/slide-design.md` 第 6、7 節。
3. **挑敘事模式**：看內文小節的論證走向（不是看封面），依 `modes.md` 挑一種，記下一句理由（之後放進題目的 `note`）。作者的大綱明顯是話題式標題或明說了模式時，以作者為準。
4. **逐節定關係與節奏**：每一頁**必填 `relationship`**（`slide-design.md` 第 6.1 節）。**先判關係，不要先想版面**；`type` 留白，版面是 build 依關係挑的——規劃階段寫下 `type`，build 就會直接拿那個頁型，整份退化成同一種版面重複到底。
   節奏：封面、章節、結語是 `anchor`；一個數字的頁是 `breathing`；其餘 `dense`。6 條以上的要點拆成兩頁；沒有結論就不做結語頁；不為了頁數或節奏捏假頁。
   **變化是硬要求**：4 頁以上時同一種關係不得超過總頁數的一半（`roster.relationship-variety`）；相鄰兩頁關係相同時先想這兩節是不是該合併、或其中一節其實是別的關係。作者的內容真的沒有變化時，在回報裡直接說出來。作者只給一句話、內容要你自己生時，刻意讓相鄰頁落在不同的關係上，整份至少涵蓋三種，並收在一個結論。
   完成標準：每一頁都有 `relationship` 與 `rhythm`，關係分布過得了上面兩條。
5. **寫逐頁計畫**：每一頁列出主張（一句話，15 字內為目標、上限 24 字，會成為標題）、聽眾變化（聽完這頁之前／之後有什麼不同——寫不出來的頁面就該合併或砍掉）、頁面關鍵詞（18 字內為目標、上限 32 字，這是頁面上真正會出現的字）、備忘稿要講的 2～3 句。主張、關鍵詞、備忘稿只能來自作者的大綱；缺的資料在第 6 步開 `free_text` 題問，不替作者發明數據、名稱、日期。
6. **出題**：3～7 題。第一題固定問敘事模式；最後兩題固定問動畫（`id` 為 `animation`，`recommended` 為 `full`，選項 `full`＝完整、`minimal`＝只做標題與要點、`none`＝不加）與背景圖（`id` 為 `background`，`recommended` 為 `on`，選項 `on`／`off`；`note` 寫第 8 步挑到的配方）；中間每一題對應一個你拿不準的判斷。每題都要有 `recommended`（必須是 `options` 之一）、2～4 個 `options`、一句 `note` 寫你的觀點；需要作者補資料的題目開 `free_text`。
7. **寫入 `plan/outline.md`**：`comotion plan set <presentation-id> outline '<全文>'`。全文＝開頭一個 ```` ```json ```` 圍欄（欄位見下方）＋ 其後每頁一節 `## 第 N 頁：<主張>`，底下四行：主張、聽眾變化、頁面關鍵詞（一行一條）、備忘稿。`status` 一律 `draft`。正文不能含半形單引號。
8. **適配風格與背景**：照 `comotion-style-kit` 的步驟挑一種風格（含形狀語言、字型匯入、畫布 `k`）寫進 `plan/design-spec.md`；再依風格檔的「建議背景」與 `comotion-background-kit` 的索引挑一種配方，把編號、名字與一句用途寫進背景題的 `note`。風格檔建議 `off` 時，背景題的 `recommended` 就給 `off`。作者要的是社群貼文、直式或方形的單張時，先問清楚畫布，並在回報裡說明要用 `presentation canvas set` 設定。
9. **停下來**：不下任何 `slide`、`textbox`、`element` 命令。回報時說明「計畫已寫好，編輯器會彈出確認視窗；按確認並建置就會開工」。沒有視窗的環境（作者直接在終端機對話）就把計畫表貼在對話裡，請作者回覆 `/comotion-build 【計畫確認】` 加上每題的答案。

## `plan/outline.md` 的 JSON 段

```json
{
  "status": "draft",
  "mode": "pyramid",
  "animation": "full",
  "background": "on",
  "pages": [
    { "n": 1, "relationship": "none", "rhythm": "anchor", "title": "這一頁的主張，一句話" },
    { "n": 2, "relationship": "membership", "rhythm": "dense", "title": "這一頁的主張，一句話" }
  ],
  "questions": [
    {
      "id": "mode",
      "question": "這份簡報的敘事骨架",
      "note": "你為什麼建議這個模式，一句話。",
      "recommended": "pyramid",
      "options": [ { "value": "pyramid", "label": "結論先行" }, { "value": "narrative", "label": "故事線" }, { "value": "briefing", "label": "中性簡報" } ],
      "free_text": false
    },
    {
      "id": "animation",
      "question": "動畫強度",
      "note": "你為什麼建議這個動畫強度，一句話。",
      "recommended": "full",
      "options": [ { "value": "full", "label": "完整" }, { "value": "minimal", "label": "只做標題與要點" }, { "value": "none", "label": "不加" } ],
      "free_text": false
    },
    {
      "id": "background",
      "question": "背景圖",
      "note": "你挑的背景配方編號、名字與一句用途；不加就是純色底。",
      "recommended": "on",
      "options": [ { "value": "on", "label": "有背景圖" }, { "value": "off", "label": "不加" } ],
      "free_text": false
    }
  ]
}
```

`animation` 只能是 `full`、`minimal`、`none`（省略視同 `full`）；`background` 只能是 `on`、`off`（省略視同 `on`）；`rhythm` 只能是 `anchor`、`dense`、`breathing`；`n` 從 1（或既有頁數 +1）連續遞增；`questions[].id` 用英數與 `-`，同一份內不重複。

每頁另有選用的 `type` 與 `blueprint`，兩者都是 `comotion-build` 在構圖階段寫的，plan 階段留白；重新規劃時保留既有的 blueprint，除非那一頁的內容真的改了。

## `plan/design-spec.md` 的 JSON 段

```json
{
  "density": "presentation",
  "palette": { "background": "#RRGGBB", "secondary_bg": "#RRGGBB", "primary": "#RRGGBB", "accent": "#RRGGBB", "secondary_accent": "#RRGGBB", "text": "#RRGGBB", "muted": "#RRGGBB" },
  "type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 },
  "layout": { "side_margin": 80, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "plain",
  "visual": "風格檔的 visual 值"
}
```

`layout` 是整份共用的版面錨點：安全區的三個邊界、欄間距、允許的間距級距。每一頁的座標可以不一樣，但這幾個數字全份一致——`validate` 用三個邊界驗溢出。整組可省略（省略即上面的預設值）；寫了就必須是合法數字。畫布不是 1280×720 時，這些值跟字級一樣乘以 `k`。

## 回報格式

先一行：模式與理由、風格名稱與一句感覺、動畫強度、建議的背景配方、共幾頁。接著一張表，每頁一列：`頁碼｜關係｜節奏｜主張`。最後一行固定：「計畫已寫進 plan/，請在確認視窗裡拍板；要改哪一頁可以按重新規劃並告訴我。」JSON 只寫進檔案，對話裡給作者看的是表格。
