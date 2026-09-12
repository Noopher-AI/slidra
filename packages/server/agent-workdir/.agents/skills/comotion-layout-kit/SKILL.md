---
name: comotion-layout-kit
description: 從 55 種版面裡挑一種來排某一頁，每種都附線框 SVG、槽位的字數預算與角色標記，並聲明它解的是哪一種內容關係；也是 comotion-build 逐頁挑版面的目錄。作者的訊息以 /comotion-layout-kit 開頭、或要你「排版」「換個版面」時用
---

# 版面庫

版面回答的是：**這一頁的內容之間是什麼關係，該用什麼幾何承載**。每一種版面都聲明它解哪一種 `relationship`，並把每個槽位該放多少字、用什麼角色標記講清楚。

**目錄是起點，不是白名單。** 可以改欄數、改比例、混兩種、或自己組——自己組的時候 `blueprint.shape` 給一個描述性的名字。

## 輸入

```
/comotion-layout-kit 三個並排的重點
/comotion-layout-kit 左圖右文 3
/comotion-layout-kit                  ← 依這一頁的 relationship 自己挑
```

- 自由文字是匹配依據：欄數、圖文關係、方向感、參考對象。
- 尾巴的頁碼限定要排哪一頁；沒給就問作者是哪一頁。
- **這一頁的 `relationship` 優先於作者的描述**：描述說「三欄」但關係是 `order` 時，選有方向的解，並在回報裡說明為什麼；作者堅持再照他的。

## 步驟

1. **讀關係**：`comotion cat <presentation-id> plan/outline.md`，取這一頁的 `relationship`。沒有計畫時依內容自己判斷（`reference/slide-design.md` 第 6.1 節）。
2. **讀風格**：`comotion cat <presentation-id> plan/design-spec.md`，取配色、字級表與 `layout` 錨點。版面的座標一律由錨點推導並乘以 `k`；檔案裡的示意數字是用 `side_margin: 80` 的 1280×720 算的。
3. **看上一頁用了什麼**：相鄰兩頁關係相同時必須換一個版面（`rhythm.repeated-shape`）。
4. **讀索引**挑一個，只讀中選的那一個檔：`references/<名字>/<名字>.md`。
5. **對槽位**：把內容塞進槽位表，超過字數預算就改短或減少單位；塞不下就減少單位或拆頁，字級不動。
6. **寫頁面**：依骨架寫整頁 SVG（`slide add --svg` 或 `slide set --svg`），每個語意單位標 `data-comot-role`。線框的**比例可以照抄**（它用真實字級畫，內容填滿安全區 y 176～616）；線框的**顏色與文字不抄**——顏色一律取自 `design-spec` 的配色角色，「圖片」「node 1」這類示意文字換成這一頁真正的內容，灰色與 `#CCCCCC` 邊框不進投影片。背景類型的裝飾（大圓、光暈、格線）是背景圖的事，版面裡不放。
7. **寫回 blueprint**：`shape` 填這個版面的名字，`nodes`／`steps` 填實際值。
8. **檢查**：`comotion validate <presentation-id> slides/00N.svg` 要 0 錯誤。

## 55 種版面

**先看關係，再看名字。** 索引照關係分組——這一頁的 `relationship` 決定你該看哪一組，作者的描述只在組內幫你挑。

### `membership`（並列／歸屬）

| 編號 | 名字 | 一句話 | 單位數 |
|---|---|---|---|
| 01 | `card-wall` | 等高橫條卡片垂直排列，最中性的並列 | 3–5 |
| 04 | `shared-field` | 全部放在同一塊場域，靠分隔線分開 | 3–6 |
| 05 | `banded-list` | 單欄橫條，底色交替分層 | 3–5 |
| 06 | `chip-cluster` | 大小不一的標籤散成一群 | 5–12 |
| 22 | `image-left` | 左半滿高圖，右半文字 | 1 + 2–4 |
| 24 | `image-grid` | 等大的圖片格陣，各配一行說明 | 3–6 |
| 26 | `kpi-row` | 一排大數字並列，各配一個標籤 | 3–4 |
| 30 | `split-thirds` | 三個等寬直欄，各放多行 | 3 |
| 49 | `infographic` | 平行直欄，每欄一個圖示加極簡標籤 | 2–5 |
| 50 | `map` | 地理輪廓加標記點與圖例 | 2–6 |
| 34 | `image-mosaic` | 主圖配幾張小圖的馬賽克，有主次 | 4–7 |
| 40 | `chart-small-multiples` | 同一種圖表重複多格，形狀可比較 | 4–9 |
| 43 | `table-full` | 一張表格佔滿內容區，用來查 | 1 表 |
| 45 | `spec-sheet` | 左圖右規格表，產品頁的標準解 | 1 圖 + 4–8 |
| 37 | `video-grid` | 幾段短片並排，各配一行說明 | 2–4 |

### `order`（順序）

| 編號 | 名字 | 一句話 | 單位數 |
|---|---|---|---|
| 03 | `spine-path` | 一條主軸串起節點，看得出方向與端點 | 3–5 |
| 07 | `numbered-run` | 大編號領頭，說明橫排在旁 | 3–4 |
| 08 | `stepped` | 逐階升高的色塊，高度就是訊息 | 3–5 |
| 29 | `timeline-vertical` | 垂直主軸，節點在軸上說明在右 | 4–7 |
| 46 | `cycle` | 閉環，箭頭回到起點 | 3–6 |
| 47 | `funnel` | 上寬下窄，寬度就是量 | 3–5 |

### `contrast`（對比）

| 編號 | 名字 | 一句話 | 單位數 |
|---|---|---|---|
| 02 | `split-panel` | 左右等寬面板，共用基準線 | 2 |
| 17 | `before-after` | 上下兩塊，中間一條分界 | 2 |
| 18 | `shared-axis` | 中央基準軸，兩邊往左右展開 | 2 |
| 28 | `matrix-2x2` | 兩軸切出四象限 | 4 |
| 33 | `image-pair-compare` | 兩張圖並排，中間一條分界 | 2 |
| 38 | `chart-pair` | 兩張圖表並排，共用同一組尺度 | 2 |
| 44 | `table-highlight` | 表格裡標出一欄，並說明為什麼 | 1 表 + 1 |

### `parent`（統轄／分解）

| 編號 | 名字 | 一句話 | 單位數 |
|---|---|---|---|
| 12 | `indent-tree` | 縮排的層級清單 | 1 + 3–6 |
| 13 | `nested-field` | 大場域裡包小場域 | 1 + 2–4 |
| 14 | `scale-drop` | 尺寸逐層變小，大小即層級 | 3–4 |
| 48 | `pyramid` | 下寬上窄的層級堆疊 | 3–5 |

### `link`（依賴／因果）

| 編號 | 名字 | 一句話 | 單位數 |
|---|---|---|---|
| 09 | `chain` | 節點用箭頭依序連起，強調因果 | 3–5 |
| 10 | `hub` | 中心一個，其餘放射連回 | 1 + 3–6 |
| 11 | `flow` | 來源 → 轉換 → 結果，中間最大 | 3–5 |

### `overlap`（交集）

| 編號 | 名字 | 一句話 | 單位數 |
|---|---|---|---|
| 15 | `venn` | 相交的圓，交集被標示出來 | 2–3 |
| 16 | `layered` | 錯開疊放的方塊，共同區在最上 | 2–4 |

### `none`（單一主張）

| 編號 | 名字 | 一句話 | 單位數 |
|---|---|---|---|
| 19 | `hero-number` | 一個大數字置中，下面一句說明 | 1 |
| 20 | `claim-field` | 一句話佔滿版面，其餘留白 | 1 |
| 21 | `cover-stack` | 標題副標日期由上而下貼左緣 | 1 |
| 23 | `image-full-bleed` | 整頁一張圖，文字壓在 scrim 上 | 1 |
| 25 | `quote-block` | 一段引用佔據版面，出處在下 | 1 |
| 27 | `chart-focus` | 圖表佔主要空間，旁邊一句結論 | 1 |
| 31 | `media-stage` | 影片或音訊佔舞台中央，上方說明要看什麼 | 1 |
| 32 | `image-caption-strip` | 大圖配下方一條說明帶 | 1 |
| 35 | `image-overlay-card` | 滿版圖上壓一張文字卡片 | 1 |
| 36 | `video-side-notes` | 左影片右觀看重點 | 1 + 2–4 |
| 39 | `chart-annotated` | 圖表拉出註解線，指出看哪裡 | 1 |
| 41 | `audio-waveform` | 波形帶配逐字重點 | 1 |
| 42 | `audio-quote` | 引用配一條可播的窄波形 | 1 |

### 直式與方形畫布

這五個**不是 16:9**，各自標了畫布尺寸。挑到它們時要先 `presentation canvas set` 設好畫布，而且字級直接照檔案的槽位表，不用 `k` 換算——那個規則只在同比例時成立。

| 編號 | 名字 | 畫布 | 一句話 |
|---|---|---|---|
| 51 | `vertical-stack` | 1080×1920 | 主張在上、圖在中、重點在下，手機一屏看完 |
| 52 | `vertical-list` | 1242×1660 | 直式編號清單，捲動式的知識貼文 |
| 53 | `vertical-cover` | 1080×1920 | 上半滿版圖、下半標題的直式封面 |
| 54 | `square-quote` | 1080×1080 | 方形引用，最適合被轉發的單張 |
| 55 | `square-kpi` | 1080×1080 | 方形數字卡 |

### 依素材找版面

**素材類版面（22–27、31–45）都需要真實的素材**：`image-*` 要匯入的圖片、`video-*`／`media-stage` 要影片（`element insert video --media assets/<檔名>`，外部平台用 `--embed`）、`audio-*` 要音檔、`chart-*` 要一組數據、`table-*`／`spec-sheet` 要欄位內容、`quote-block`／`audio-quote` 要真實的引用，`kpi-row`／`hero-number` 的數字只能來自作者。素材不存在時換一個不需要素材的版面，等素材到了再 `slide set --svg` 換回來——灰色佔位框與編出來的數字都不是版面。

| 手上有什麼 | 可用的版面 |
|---|---|
| 一張圖 | 22 `image-left`、23 `image-full-bleed`、32 `image-caption-strip`、35 `image-overlay-card` |
| 多張圖 | 24 `image-grid`（等重）、34 `image-mosaic`（有主次）、33 `image-pair-compare`（兩張比較） |
| 一段影片 | 31 `media-stage`（純播）、36 `video-side-notes`（邊播邊講） |
| 多段短片 | 37 `video-grid` |
| 一段音檔 | 41 `audio-waveform`（有重點要對照）、42 `audio-quote`（一句原話） |
| 一組數據 | 27 `chart-focus`、39 `chart-annotated`（有關鍵點）、26 `kpi-row`（幾個指標） |
| 兩組數據 | 38 `chart-pair` |
| 多組同型數據 | 40 `chart-small-multiples` |
| 一張表 | 43 `table-full`、44 `table-highlight`（要推薦其中一欄） |
| 產品圖＋規格 | 45 `spec-sheet` |
| 循環、漏斗、金字塔、地理分布 | 46 `cycle`、47 `funnel`、48 `pyramid`、50 `map` |

## 回報格式

先一行：「第 N 頁：<版面名字>（解 <關係>）——<一句話>，<單位數> 個單位、<步數> 步」。接著逐槽位一行：槽位名、放了什麼、幾個字（超過預算要標出來）。最後一行列出兩個備選版面。
