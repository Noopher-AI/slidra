# SVG 作者指南

這份文件是 agent **一頁寫一份 SVG** 的依據：舞台骨架、字級表、配色角色、元素角色、一份語法示範、動畫腳本、關係與密度規則，以及最後用 `slidra validate` 驗收。`slidra-plan` 用第 6、7 節寫計畫；`slidra-build` 與 `slidra-new-slide` 用第 0～5 節做頁面。簡報已經有範本或設計過的頁面時，**沿用既有的，不要用這份指南蓋掉它**。

三個素材庫各管一段：配色與字級表在 `slidra-style-kit`、背景配方在 `slidra-background-kit`、版面與槽位在 `slidra-layout-kit`。這份指南只寫它們之間共用的規則。

所有數字以 **1280×720** 畫布為準（`slidra new` 的預設）。

**同比例的畫布（16:9）**：先 `cat project.json` 讀出 `canvas.width`，算出 `k = width ÷ 1280`，把所有座標、寬度、半徑、字級都乘以 k（1920×1080 就是 ×1.5），`viewBox` 寫成畫布尺寸。

**不同比例的畫布**（直式、方形、A4）：**`k` 不適用**。這些畫布用版面庫裡專門為它們畫的版面（51–55），字級直接照那些檔案的槽位表——直式內容通常在手機上近距離看，字要比 16:9 更大。

| 畫布 | 尺寸 | 用途 |
|---|---|---|
| 16:9 | 1280×720（或 1920×1080） | 簡報、會議、螢幕 |
| 4:3 | 1024×768 | 傳統投影機、學術場合 |
| 3:4 | 1242×1660 | 圖文知識貼文 |
| 1:1 | 1080×1080 | 方形貼文、語錄卡 |
| 9:16 | 1080×1920 | 限時動態、短影音封面 |
| A4 | 1240×1754 | 列印海報、單張文件 |

畫布用 `slidra presentation canvas set <id> --width <w> --height <h>` 設定，而且要在**建第一頁之前**設好。

## 0. 怎麼把一頁 SVG 寫進簡報

- 新頁：`slidra slide add <presentation-id> --svg '<整頁 SVG>'`；要插在第 n 頁之後就加 `--at n`。整頁覆寫：`slidra slide set <presentation-id> slides/00N.svg --svg '<整頁 SVG>'`。
- **引號規則**：整段 SVG 用單引號包住，裡面**只能用雙引號**當屬性引號，整段**不能出現任何半形單引號** `'`（命令列打不進去）；文字裡的 `&` 寫成 `&amp;`、`<` 寫成 `&lt;`。
- 寫入時 Slidra 會：檢查根節點是 `<svg>`、補或核對 `viewBox`；把裸圖元包進 `<g>`、補 id、把 `transform` 搬上容器；拒絕 `<script>`／`<foreignObject>`；把**文字框宣告**轉成真正的文字框（下一段）。`<defs>`、漸層、濾鏡、clipPath、`path` 都可以用。
- 成功回傳 `data.elementIds`（文件順序的所有元素 id）。**自己給 id**（`el-<語意>`，同一頁內不重複），動畫腳本才對得上；`data-slidra-name` 給人看，照給。
- 頁面底色不寫在 SVG 裡，寫完後 `slidra slide style set <presentation-id> slides/00N.svg --background <該頁指定的角色色碼>`。

### 寫入閘門：送出前自己先過這一遍

`slide add --svg`／`slide set --svg` **會先驗這一頁，沒過就整頁拒收**（回傳列出每一條沒過的規則，什麼都不會被寫進去）。擋的都是「只能整頁重寫才修得好」的東西——與其讓它寫進去、待會兒再整頁重寫一次，不如現在就對。**這不是作者按了拒絕**，是這一頁還沒達標。

送出前照著算一遍：

1. **文字框會不會撞在一起**：文字框高度 ＝ 行數 × 1.45 × 字級，`y + 高度` 就是底。**行數要自己估**——寬度除以字級估得出一行放幾個字，中文字寬約等於字級、英數約 0.5 倍。下一個文字框的 `y` 必須大於上一個的底。（這次最常犯的錯：標題以為一行、實際折成兩行，副標就被壓住了。）
2. **會不會出界**：文字框右緣 `x + 寬度` ≤ 1200（×k）、底 ≤ 648（×k）；頁尾那兩個 18 級的例外，可到 700（×k）。
3. **字級與顏色**：字級只能是字級表上的值，文字色只有 text／muted（大數字與粗體標籤可 accent、結語頁可 background），色塊只用配色角色、`none` 或 `url(#…)`。
4. **一頁一個標題**：只有一個文字框用標題級字級。
5. **文字量**：標題、每條要點的長度與條數、整頁總字數都在第 7 節的表上。
6. **角色要自洽**：`relationship` 不是 `none` 的頁至少一個 `node`；`label` 要有歸屬、`spine` 一頁一條、`edge` 兩端要接到 node、`garnish` 不承載意義（第 3b 節）。
7. **圖片指得到**：`href` 寫 `../assets/<檔名>`，檔名照 `ls <presentation-id> assets` 或 `asset import` 的回傳；資產不存在就先匯入。
8. **有背景圖時**：每個文字框（頁尾與 ≥ claim 的大字除外）都要落在一塊 scrim 面板上（第 4b 節）。

**不在這裡擋**、寫進去之後再補命令即可的：轉場與進場效果、頁面底色、背景圖、備忘稿、範本登記、`blueprint`。這些缺了 `validate` 會報，但不影響這一頁寫得進去。

### 文字框宣告

**所有會被讀的文字**都用文字框宣告寫，才會自動換行、能加清單、可被就地編輯、被 `validate` 驗到：

```xml
<text id="el-bullets" data-slidra-name="要點" data-slidra-text-width="1120" x="80" y="176"
      font-size="24" font-weight="400" fill="<text>"
      data-slidra-text-align="left" data-slidra-list="bullet bullet bullet">第一條
第二條
第三條</text>
```

- `x`／`y` 是文字框**左上角**（不是基線）。文字框高度＝行數 × 1.45 × 字級；排垂直位置用這條算。
- 內容以換行分段，一段一條要點；`data-slidra-list` 每段一個 token（`bullet`／`number`／`none`）。
- `font-family` 只能寫簡報已內嵌的家族（`Noto Sans TC` 內建；其他照 `reference/fonts.md` 匯入）；字重只用 400 與 700；`data-slidra-text-align` ∈ left／center／right。
- 內容只能是純文字，`<tspan>` 由 Slidra 自己產生。
- 沒有 `data-slidra-text-width` 的裸 `<text>` 只有一個用途：章節頁的浮水印大字，那是裝飾不是內容——而且要標 `data-slidra-role="garnish"` 說明它是裝飾，否則寫入會被拒（沒標的裸 `<text>` 一律當成「文字掉了文字框」）。

## 1. 舞台骨架

每一頁共用的固定元素；**內容頁**（章節頁、要點頁、對照頁、大數字頁）都放，**封面與結語頁不放頁尾**：

| 元素 | 寫法 |
|---|---|
| 頁尾線 | `<line id="el-footer-rule" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>` |
| 頁尾簡報名（左下） | 文字框宣告 x=80 y=668 w=600 字級 18 muted，內容 `{{ presentation_name }}` |
| 頁碼（右下） | 文字框宣告 x=800 y=668 w=400 字級 18 muted 靠右，內容 `{{ slide_number }} / {{ slide_total }}`（寬度要放得下模板字串本身，換行是以字面量算的） |

**裝飾幾何（大圓、光暈、色團、光束、對角線、格線、光點）一律住在背景圖資產裡**，頁面 SVG 只放內容元素、scrim 與頁尾。計畫 `background: off` 時才把舞台大圓 `<ellipse id="el-orb" cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>` 放進內容頁的 SVG（章節頁與大數字頁不放）。

- 內容區 x 80～1200、y 72～648；標題頂端固定 y=72、左緣固定 x=80，整份不漂移。這幾個邊界來自 `design-spec.layout`（`side_margin` / `bottom_margin` / `footer_margin`），`validate` 依它驗溢出。頁面內的間距一律取自 `layout.gutter` 與 `layout.spacing` 的級距。
- 裝飾幾何（圓、線、path）**可以超出畫布**，這是刻意的出血；文字框不可以。
- `{{ … }}` 是動態文字，顯示時才代換成實際值，`cat` 讀回看到的是字面。

## 2. 字級表

一份簡報每個角色只用一個字級；同一角色在不同頁上不得忽大忽小。字級的實際數值來自 `plan/design-spec.md` 的 `type_scale`（由 `slidra-style-kit` 的風格檔提供），下表是**角色的意思**：

| 角色（type_scale 鍵） | 預設 | 字重 | 顏色 | 用在 |
|---|---|---|---|---|
| 封面大標（`cover`） | 72 | 700 | text | 封面，≤ 2 行、每行 ≤ 15 字 |
| 章節名（`section`） | 56 | 700 | text | 章節頁 |
| 大數字（`number`） | 140 | 700 | accent | 大數字頁的數字 |
| 大主張（`claim`） | 48 | 700 | text；結語頁用 background | 大數字頁的一句話、結語頁的結論 |
| 頁標題（`title`） | 40 | 700 | text | 要點頁、對照頁 |
| 副標／欄標／卡片編號（`subtitle`） | 28 | 400（副標）／700（欄標、卡片編號、章節編號） | muted（副標）／text（欄標）／accent（編號） | 封面副標、對照頁欄標、要點頁卡片編號、大數字頁說明 |
| 內文（`body`） | 24 | 400 | text | 要點頁關鍵詞、結語頁下一步 |
| 欄內文（`column`） | 22 | 400；結語小標 700 | text；結語小標 accent | 對照頁兩欄內文、結語頁小標 |
| 標籤／來源／頁尾（`caption`） | 18 | 400 | muted | 封面日期講者、資料來源、頁尾 |

## 3. 配色角色

每份簡報**只用一組**七個角色的色碼，來自 `plan/design-spec.md` 的 `palette`（由 `slidra-style-kit` 挑）；作者指定了顏色就照作者。SVG 範例裡的 `<role>` 寫入前都要換成該組的色碼。

| 角色 | 用在 |
|---|---|
| background | 頁面底色；結語頁的文字色 |
| secondary_bg | 章節頁底色、卡片與面板、VS 圓 |
| primary | 骨架色條、左欄頂線、結語頁滿版底、背景圖的大面積 |
| accent | 大數字、短棒與底線、卡片編號、章節編號、結語小標與方塊 |
| secondary_accent | 對照頁右欄頂線；背景圖只給線條與小面積 |
| text | 主要文字 |
| muted | 副標、來源、頁尾、章節浮水印 |

- 文字顏色只用 text 與 muted；例外：大數字與粗體標籤（卡片編號、章節編號、結語小標、VS）用 accent，結語頁全部文字用 background。內文與副標用強調色會過不了對比度，`validate` 會擋。
- 色塊與線條的顏色只用 primary／accent／secondary_accent／secondary_bg／background；半透明靠 `opacity`。

## 3b. 元素角色：每個元素是為了什麼而存在

座標可以為內容調整，但**每個元素扮演的角色不能含糊**。在元素上宣告 `data-slidra-role`，`validate` 就能在不管座標的前提下檢查這一頁的結構是否成立。

| 角色 | 意思 | 典型元素 |
|---|---|---|
| `field` | 關係發生的區域 | 卡片底、欄位面板、色帶 |
| `node` | 一個語意單位 | 每張卡片、對照的每一欄、流程的每一站 |
| `spine` | 這一頁的閱讀主軸 | 章節頁的骨架色條、時間軸的主線 |
| `edge` | 必要的連接 | 因果箭頭、依賴線 |
| `label` | 附著在某個 owner 上的文字 | 卡片裡的要點字、節點名稱 |
| `garnish` | 關係成立**之後**才加的裝飾 | 底線、小方塊、強調短棒 |

- `relationship` 不是 `none` 的頁面至少要標出一個 `node`（`role.required`）。宣告了就要自洽。
- `background` 是 CLI 自己寫在背景圖容器上的，作者不要手寫。
- `validate` 會擋的四件事：`garnish` 不可以是文字框（裝飾不承載意義）；一頁最多一條 `spine`；有 `edge` 就至少要有兩個 `node`；`label` 的數量不得少於當作色塊的 `node`。
- 文字框宣告上的 `data-slidra-role` 會被帶到正規化後的元素上；寫了不在表上的角色會直接被 `slide add --svg` 拒絕。

## 4. 語法示範

這一頁只為了示範寫法：文字框怎麼宣告、角色怎麼標、頁尾三件怎麼放、scrim 疊在誰前面。**它不是版面建議**，版面去 `slidra-layout-kit` 挑。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect id="el-scrim-title" data-slidra-name="標題底" data-slidra-role="field" x="80" y="64" width="1120" height="88" fill="<background>" opacity="0.7"/>
<text id="el-title" data-slidra-name="頁標題" data-slidra-role="label" data-slidra-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="<text>">標題是這一頁的主張</text>
<g id="el-unit-1" data-slidra-role="node"><rect x="80" y="176" width="1120" height="72" fill="<secondary_bg>"/></g>
<text id="el-point-1" data-slidra-name="要點 1" data-slidra-role="label" data-slidra-text-width="960" x="200" y="195" font-size="24" fill="<text>">一行關鍵詞，不加句號</text>
<line id="el-footer-rule" data-slidra-name="頁尾線" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>
<text id="el-footer-name" data-slidra-name="頁尾簡報名" data-slidra-text-width="600" x="80" y="668" font-size="18" fill="<muted>">{{ presentation_name }}</text>
<text id="el-footer-page" data-slidra-name="頁碼" data-slidra-text-width="400" x="800" y="668" font-size="18" fill="<muted>" data-slidra-text-align="right">{{ slide_number }} / {{ slide_total }}</text>
</svg>
```

從這一份要帶走的**語法事實**：

- 每個元素有 `id` 與 `data-slidra-name`，語意元素再加 `data-slidra-role`（第 3b 節）。
- scrim 就是一塊在被墊文字**之前**出現的 rect；它同時可以是那段內容的 `field`。
- 上面的 80／1120／656 是 `side_margin: 80` 時的值，錨點不同就跟著換。

## 4b. 背景圖：由你產生的 SVG 圖片，放在頁面最底層

背景圖是一張獨立的 SVG 資產，用 `slide background set` 放在頁面**最底層**（容器 `id="el-background"`、`data-slidra-role="background"`、鎖定，作者拖不動、`validate` 不驗它、不加動畫）。它把頁面的氣質再往上拉一層，但**不承載意義**：拿掉它，頁面的意思一個字都不少。計畫 `plan/outline.md` 的 `background` 是 `off` 時整份都不放。

配方來自 `slidra-background-kit`（計畫階段已經挑好，寫在背景題的 `note`）；配方檔會說它適合哪種 `rhythm`、建議的 opacity。一份簡報**最多兩種配方**（定錨頁一種、內容頁一種），同配方同色系只建一個資產，所有頁面重用同一個路徑。頁面底色是 `primary` 時（結語頁）opacity 降到 0.6 左右，色團會變成同色系的層次。

### 有背景圖時的 scrim 規則

背景圖再暗也會降低小字的對比，所以 `validate` 的 `structure.scrim` 會要求：**頁面有背景圖時，每個文字框（頁尾除外）都要完全落在一塊「scrim 面板」上**——一個在文件順序上位於它之前、fill 是 `background` 或 `secondary_bg`、`opacity` 缺省或 ≥ 0.6 的 rect。字級 ≥ `claim`（48）的大字例外：大標、章節名、大數字、結語主張不需要 scrim，配方保證那些區域是安靜的。

**怎麼滿足它，是這一頁的構圖決定，不是查表：**

- **已經有 `field` 的頁面**（卡片、面板、共同場域）——`field` 本身就是 scrim，只要它的 fill 是 `background`／`secondary_bg`、opacity ≥ 0.6，落在上面的 `label` 就過了。**先想這段文字屬於哪個 `field`，而不是先想要加哪一塊 scrim**。
- **落在 `field` 之外的文字**（標題、頁間說明、來源）——替它加一塊 scrim rect：涵蓋該文字框的四邊、放在它之前、fill 取 `background` 或 `secondary_bg`（頁面底色是 `primary` 時取 `primary`）、`opacity` 0.65～0.7。寬高由那個文字框決定。
- **scrim 留在安靜區**：配方保證左半與中央（x 80～760、y 72～648）安靜，亮部在右緣與右下。一塊延伸到亮部的 scrim 會在那裡露出一片灰板——寧可讓文字框窄一點。
- `claim` 級以上的大字與頁尾不需要 scrim，多加一塊面板會讓喘息頁變擁擠。

scrim 是面板，但喘息頁的 `rhythm.breathing-cards` 只數 `secondary_bg` 且 ≥ 200×80 的 rect——用 `background` 色、或尺寸小於這個的 scrim 不會被算進去。

### 命令順序

1. 同配方同色系只做一次：`slidra asset import <presentation-id> --svg '<配方 SVG，角色換成色碼>' --name bg-<配方>-<色系>.svg`（檔名只能用英數、`-`、`_`；同名已存在會被拒絕）。回傳 `data.path` 是 `assets/bg-….svg`。
2. 寫該頁：`slidra slide add <presentation-id> --svg '<整頁 SVG>'`（含 scrim rect）。
3. `slidra slide background set <presentation-id> slides/00N.svg --asset <data.path> --opacity <配方建議值>`；要拿掉就 `--none`。
4. 動畫照第 5 節；背景圖從第一格就在。

## 5. 動畫腳本

**一次點擊＝講者講一件事，不是畫一個元素。** 一頁需要幾個 `on-click`，由這一頁要分幾段講決定（就是 `blueprint.steps`）。

計畫 `animation`：`full`（預設，逐段揭露）、`minimal`（整頁一次到齊，只留一個 on-click）、`none`（不加）。

### 5.1 效果下在群組上

先把同一段話裡的元素 `element group` 成一個群組，**再對群組 id 下一個效果**。群組就是動畫的錨點——一段一個錨點，一個錨點一個效果。

```
slidra effect add <presentation-id> slides/00N.svg <群組 id> --family enter --effect <效果> --start on-click --duration <秒>
```

- `element group` 會清掉成員既有的效果，所以**一定先 group 再套動畫**。
- 整份做完只下一次轉場：`slidra slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3 --all`（`animation` 為 `none` 時不下）。

### 5.2 哪些東西進動畫（靠角色判斷）

| 角色 | 進動畫？ |
|---|---|
| `node`（連同它的 `field`／`label`，通常已在同一個群組裡） | ✅ 每段一個 `on-click` |
| `spine` | ✅ 跟它串起的第一段一起（`with-previous`），或自成第一步 |
| `edge` | ✅ 跟它連接的後一個 node 一起 |
| `garnish` | ❌ 裝飾是關係成立之後才加的，沒有可以講的那一步（`role.garnish-animated`） |
| `background`（背景圖）、頁尾線、簡報名、頁碼 | ❌ 從第一格就在 |

**判斷依據是角色，不是元素叫什麼名字。** 沒有標角色又看起來像裝飾的東西（純色塊、線、圓）一律不加。

### 5.3 強度

| `animation` | 做法 |
|---|---|
| `full` | 每個講述步驟一個 `on-click`，步數等於 `blueprint.steps` |
| `minimal` | 整頁只有一個 `on-click`（第一個群組），其餘 `with-previous` |
| `none` | 不加效果，也不下轉場 |

- **一頁的 `on-click` 步驟不超過 5**。超過就該拆頁。
- 可用的 enter 效果只有 `appear`、`fade`、`fly-up`、`fly-left`、`zoom`。並列用 `fade`、有方向的用 `fly-left`／`fly-up`、單一焦點用 `zoom`。

## 6. 先定關係，再選解法

**不要問「這是哪一種頁型」，要問「這一頁的內容之間是什麼關係」。** 關係決定幾何要承載什麼；頁型只是某些關係的已知解的名字。

### 6.1 七種關係

| 關係 | 什麼時候是它 | 幾何要承載的東西 |
|---|---|---|
| `membership` | 並列、歸屬、同一組裡的幾件事 | 共同的場域或重複的單位；**沒有方向** |
| `order` | 順序、步驟、排名、時間 | 一條看得出方向的閱讀路徑：直線／轉折／上升；起點與終點要分得出來 |
| `contrast` | A vs B、之前／之後、選項比較 | 共用的基準線加上分隔；兩邊的不變量要對齊才看得出差異 |
| `parent` | 一件事統轄或分解成幾件 | 層級：縮排、巢狀、尺寸差；根要看得出來 |
| `link` | 依賴、影響、因果、轉換 | 必要的連接；來源與目標要明確，線越少越好 |
| `overlap` | 交集、共用的部分 | 相交的區域，共同區與各自區都要看得出來 |
| `none` | 單一主張、一個數字、一句結論 | 沒有關係要承載——留白與尺寸就是全部 |

**硬規則**：三件並列的事才用等分欄位；三件有先後的事要看得出方向。節點數只影響間距與換行，不構成採用對稱的理由。

### 6.2 一個關係有多種解

同一個關係可以用不同的幾何承載，解法的完整目錄（照關係分組，附槽位表與線框）在 `slidra-layout-kit`。**相鄰兩頁不要用同一個解**（`rhythm.repeated-shape` 會抓）。目錄是起點不是清單：需要目錄上沒有的解就自己組一個，並在 `blueprint.shape` 給它一個描述性的名字。

### 6.3 已知解：六種頁型

下列六個組合是**已知解**：用了它才在計畫填 `type`（`validate` 會多驗一條該頁型的簽名字級，範本也會登記）；自己組的構圖只留 `relationship`。

| `type` | 頁型 | 關係 | `blueprint.shape` | 簽名 | 頁尾 |
|---|---|---|---|---|---|
| `cover` | 封面 | `none` | `cover-stack` | `cover` 字級的大標 | 不放 |
| `section` | 章節頁 | `none` | `claim-field` | `section` 字級的章節名；左緣 primary `spine` 色條 | 放 |
| `bullets` | 要點頁 | `membership` | `card-wall` | `title` 字級標題＋N 個 `node` | 放 |
| `compare` | 對照頁 | `contrast` | `split-panel` | `title` 字級標題＋左右兩個 `node` | 放 |
| `number` | 大數字頁 | `none` | `hero-number` | `number` 字級的數字，**只能來自作者的大綱** | 放 |
| `closing` | 結語頁 | `none` | `claim-field` | 底色滿版 `primary`、全部文字用 `background` 色、`claim` 字級的結論；一句帶得走的結論，不是「謝謝」也不是封面再放一次 | 不放 |

範本名稱：cover→`封面`、section→`章節頁`、bullets→`要點頁`、compare→`對照頁`、number→`大數字頁`、closing→`結語頁`。

`order`、`parent`、`link`、`overlap` 沒有已知解，用版面庫該關係那一組的解或第 3b 節的角色自己組——退回要點頁等於把有方向的內容講成並列的內容。

## 7. 內容密度：頁面只放主張與關鍵詞，說明進備忘稿

頁面是給台下**看**的，不是給人**讀**的；把要點寫成完整句子放上去，頁面就變成講稿。

下表左欄是**寫作目標**，右欄是 `validate` 真正會擋的上限。門檻刻意留得寬——放不下的版面由溢出規則擋掉，字數規則只攔明顯誇張的那種。**沒有超過上限就不要為了更短而把話講不清楚。**

| 項目 | 目標（density = presentation） | `validate` 上限 |
|---|---|---|
| 標題（頁標題、章節名） | 15 字、1 行 | 24 字 |
| 封面大標 | ≤ 2 行，每行 15 字 | 同標題 |
| 每條要點／每張卡片的關鍵詞 | 18 字、**1 行**，不加句號 | 32 字、2 行 |
| 要點條數 | 3～5 條（對照頁每欄 2～4 條） | 2～7 條（每欄 2～6） |
| 一頁的文字總量（所有文字框加總，含卡片編號，不含頁尾與裸文字浮水印；`{{ }}` 不計） | 600 字 | 1000 字 |
| 大數字頁的說明、結語頁的結論 | 24 字 | 32 字 |
| 備忘稿 | 2～5 句，**這裡才放完整句子** | 不驗 |

- 一頁只講一個想法；標題是這一頁的主張（「本季營收成長 23%」），不是話題標籤（「營收」），除非作者的大綱本來就是話題式標題。
- **擴寫的去處是備忘稿**：作者的每一條要點，頁面上以 1 行關鍵詞為目標；講完整的那一兩句寫進 `slide notes set`。先說主張、再說依據、最後接到下一頁；不要念出顏色、位置、元素名。
- 頁面上只放作者給的內容；擴寫是把意思講完整，不是替作者發明數據、名稱、日期。

## 8. 一致性與禁忌

- 同角色同字級、同顏色；標題頂端固定 y=72；左緣固定 x=80；一份簡報只用一組配色。
- **裝飾不承載意義**：拿掉所有圓、線、色塊與背景圖，頁面的意思要一個字都不少；不畫沒有意義的連接線。
- 喘息頁（大數字頁、章節頁）靠留白與大字：面板（secondary_bg 的大色塊）不超過 2 個。
- rect 不加框線（`stroke`）、不加陰影；細環與對角線是 ellipse／line 的 stroke，這是允許的。
- 不做「謝謝」頁、不做只有聯絡方式的頁、不重複封面。
- 文字太多就縮短或拆頁，字級不動。

## 9. 自我檢查：跑 `slidra validate`

規則與門檻寫在 CLI 裡，不要自己心算：`slidra validate <presentation-id> [slides/00N.svg]`。結束碼非零代表有錯誤，`data.errors[]` 每一筆有 `slide`、`element`、`rule`、`actual`、`limit`、`message`。有 `plan/design-spec.md` 時字數門檻依它的 `density`；沒有計畫檔時只驗幾何與骨架（message 尾巴會帶「沒有 plan/ 計畫檔，只驗幾何與骨架」）。

**第一頁閘門**：封面與第一張內容頁做完各跑一次 `validate`；有錯誤先改做法，確認都是 0 錯誤才做第 3 頁起，不要每頁各修各的。

**標 ⛔ 的規則在 `slide add --svg`／`slide set --svg` 寫入時就會擋下整頁**（第 0 節的自檢清單），其餘的是寫入後補命令就能修的。

| rule | 在驗什麼 | 怎麼修 |
|---|---|---|
| ⛔ `text.title-length`、`text.bullet-length`、`text.bullet-lines`、`text.bullet-count`、`text.page-total` | 第 7 節的文字量上限 | 改短、把句子搬進備忘稿；條數超過就拆頁（並用 `plan set outline` 補一頁進計畫） |
| ⛔ `focus.single-title` | 一頁只有一個標題角色 | 合併或拆頁 |
| ⛔ `geometry.right-overflow`、`geometry.bottom-overflow`、`geometry.text-overlap` | 文字框右緣 ≤ 1200、下緣 `y + 行數 × 1.45 × 字級 ≤ 648`、同欄文字框不重疊（裝飾幾何可以出血，不驗） | 縮短文字或減少條數；字級與座標不動 |
| ⛔ `style.font-size`、`style.text-fill`、`style.shape-fill` | 字級在第 2 節的表上；文字色只有 text／muted（大數字與粗體標籤可 accent、結語頁可 background）；色塊色只用配色角色、`none` 或 `url(#…)` | 改回 `type_scale`／`palette` 的值（`element style set`） |
| `structure.background`、`structure.notes`、`structure.template` | 背景已設、備忘稿非空、出現過的頁型都登記了範本 | 補 `slide style set`／`slide notes set`／`template add` |
| ⛔ `structure.scrim` | 有背景圖的頁，每個文字框（頁尾與 ≥ claim 的大字除外）都落在一塊 scrim 面板上（第 4b 節） | 先看那段文字能不能歸進某個 `field`，不能才加一塊 scrim rect，整頁 `slide set --svg` 重寫，再重下背景圖與動畫 |
| `structure.background-image` | 計畫 `background` 是 `on` 時每一頁都有背景圖 | 補 `slide background set --asset`，或把計畫的 `background` 改成 `off` |
| `blueprint.required` | 計畫 `confirmed` 之後每一頁都必須寫下 `blueprint` | 補 `blueprint`（`shape`／`nodes`／`steps`），`plan set outline` 寫回 |
| `blueprint.nodes`、`blueprint.steps` | 畫出來的 node 數與 on-click 步數要跟構圖時寫的一致 | 頁面畫錯就改頁面；構圖想錯就 `plan set outline --force` 改 blueprint 並在回報裡說明 |
| `rhythm.repeated-shape` | 相鄰兩頁不得用同一個 `blueprint.shape` 解同一種 `relationship`、又是同樣的單位數 | 換一種構圖（版面庫同一組有別的解），或把兩頁合併 |
| `rhythm.breathing-cards` | breathing 頁的面板 ≤ 2 | 刪面板 |
| ⛔ `role.required` | `relationship` 不是 `none` 的頁面至少要標出一個 `node` | 替每個語意單位加 `data-slidra-role="node"` |
| `role.garnish-animated` | `garnish` 不得有任何進場效果 | 拿掉那個效果，或這個元素其實是 `node`／`label` |
| ⛔ `role.*` | 第 3b 節的四條自洽規則 | 改角色或補標籤 |
| `roster.page-count`、`roster.page-type` | 頁數與每頁頁型跟 `plan/outline.md` 對得上（每種頁型有它的簽名字級） | 以計畫為準修頁面；計畫本身錯了才改計畫 |
| `roster.relationship-variety` | 4 頁以上時，同一種 `relationship` 不得超過半數 | 回去看內容，找出其實是順序／對比／一個數字的那幾節，改它們的 `relationship` |
| `motion.transition`、`motion.enter` | `animation` 不是 `none` 時每頁有轉場；`full` 每頁至少一個進場效果、`minimal` 封面／要點／對照頁至少一個 | 補 `effect add`／`slide transition set --all` |
| ⛔ `asset.missing` | 頁面引用的圖片／影音在這份簡報裡不存在 | 用 `ls <presentation-id> assets` 對出真正的檔名；資產還沒匯入就先 `asset import` |
| `taboo.thank-you`、`taboo.duplicate-cover`、`taboo.stroke` | 謝謝頁、重複封面、rect 的框線 | 刪掉 |

**整份做完**：`validate` 整份 0 錯誤，`template list` 列得出「封面」「要點頁」等名稱。
