# SVG 作者指南：「編輯／科技」視覺語言

這份文件是 agent **一頁寫一份 SVG** 的依據：舞台骨架、字級表、配色、六種頁型的完整 SVG 範例、每種頁型的動畫腳本、挑頁型與密度規則，以及最後用 `co-motion validate` 驗收。`comotion-plan` 用第 2、3、6、7 節寫 `plan/design-spec.md` 與挑頁型；`comotion-build` 用第 1、4、4b、5 節做頁面；`comotion-new-slide` 在有計畫時照同一套做一頁。簡報已經有範本或設計過的頁面時，**沿用既有的，不要用這份指南蓋掉它**。

所有數字以 **1280×720** 畫布為準（`co-motion new` 的預設）。畫布不是 1280×720 時，先 `cat project.json` 讀出 `canvas.width`，算出 `k = width ÷ 1280`，把所有座標、寬度、半徑、字級都乘以 k（1920×1080 就是 ×1.5），`viewBox` 也要寫成畫布尺寸。

## 0. 怎麼把一頁 SVG 寫進簡報

- 新頁：`co-motion slide add <presentation-id> --svg '<整頁 SVG>'`；要插在第 n 頁之後就加 `--at n`。整頁覆寫：`co-motion slide set <presentation-id> slides/00N.svg --svg '<整頁 SVG>'`。
- **引號規則**：整段 SVG 用單引號包住，裡面**只能用雙引號**當屬性引號，整段**不能出現任何半形單引號** `'`（命令列打不進去）；文字裡的 `&` 寫成 `&amp;`、`<` 寫成 `&lt;`。
- 寫入時 CoMotion 會：檢查根節點是 `<svg>`、補或核對 `viewBox`；把裸圖元包進 `<g>`、補 id、把 `transform` 搬上容器；拒絕 `<script>`／`<foreignObject>`；把**文字框宣告**轉成真正的文字框（下一段）。`<defs>`、漸層、濾鏡、clipPath、`path` 都可以用。
- 成功回傳 `data.elementIds`（文件順序的所有元素 id）。**自己給 id**（`el-<語意>`，同一頁內不重複），動畫腳本才對得上；`data-comot-name` 給人看，照給。
- 頁面底色不寫在 SVG 裡，寫完後 `co-motion slide style set <presentation-id> slides/00N.svg --background <該頁型指定的角色色碼>`。

### 文字框宣告

**所有會被讀的文字**都用文字框宣告寫，才會自動換行、能加清單、可被就地編輯、被 `validate` 驗到：

```xml
<text id="el-bullets" data-comot-name="要點" data-comot-text-width="1120" x="80" y="176"
      font-size="24" font-weight="400" fill="<text>"
      data-comot-text-align="left" data-comot-list="bullet bullet bullet">第一條
第二條
第三條</text>
```

- `x`／`y` 是文字框**左上角**（不是基線）。文字框高度＝行數 × 1.45 × 字級；排垂直位置用這條算。
- 內容以換行分段，一段一條要點；`data-comot-list` 每段一個 token（`bullet`／`number`／`none`）。
- `font-family` 省略（Noto Sans TC 是唯一內嵌字型）；字重只用 400 與 700；`data-comot-text-align` ∈ left／center／right。
- 內容只能是純文字，**不要自己放 `<tspan>`**。
- 沒有 `data-comot-text-width` 的裸 `<text>` 只有一個用途：章節頁的浮水印大字（第 4.2 節），那是裝飾不是內容。

## 1. 舞台骨架

每一頁共用的固定元素；**內容頁**（章節頁、要點頁、對照頁、大數字頁）都放，**封面與結語頁不放頁尾**：

| 元素 | 寫法 |
|---|---|
| 舞台大圓（右上、刻意出血） | **在背景圖裡**（第 4b 節每個配方都內含）。只有計畫 `background: off` 時才把 `<ellipse id="el-orb" cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>` 放進頁面 SVG（章節頁與大數字頁不放） |
| 頁尾線 | `<line id="el-footer-rule" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>` |
| 頁尾簡報名（左下） | 文字框宣告 x=80 y=668 w=600 字級 18 muted，內容 `{{ presentation_name }}` |
| 頁碼（右下） | 文字框宣告 x=800 y=668 w=400 字級 18 muted 靠右，內容 `{{ slide_number }} / {{ slide_total }}`（寬度要放得下模板字串本身，換行是以字面量算的） |

**背景類型的裝飾一律不進頁面 SVG**：大圓、光暈、色團、光束、對角線、格線、光點——這些只出現在背景圖資產裡。頁面 SVG 只放內容元素、scrim 與頁尾；`background: off` 時才照各頁型的說明補回去。不要自己發明新的裝飾幾何。

- 內容區 x 80～1200、y 72～648；標題頂端固定 y=72、左緣固定 x=80，整份不漂移。這幾個邊界來自 `design-spec.layout`（`side_margin` / `bottom_margin` / `footer_margin`），不是寫死的常數——`validate` 依它驗溢出，改畫布或改錨點時整份一起換。頁面內的間距一律取自 `layout.gutter` 與 `layout.spacing` 的級距，不要每頁自己發明數字。
- 裝飾幾何（圓、線、path）**可以超出畫布**，這是刻意的出血；文字框不可以。
- `{{ … }}` 是動態文字，顯示時才代換成實際值，`cat` 讀回看到的是字面。

## 2. 字級表

一份簡報每個角色只用一個字級；同一角色在不同頁上不得忽大忽小。`comotion-plan` 把這張表寫進 `plan/design-spec.md` 的 `type_scale`。

| 角色（type_scale 鍵） | 字級 | 字重 | 顏色 | 用在 |
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

```json
"type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 }
```

## 3. 配色

每份簡報**只選一組**，七個角色都從表裡取；作者指定了顏色或風格就照作者。挑法：技術、產品、數據類 → A；報告、教學、一般商務 → B；品牌、故事、人文類 → C；金融、永續、醫療類 → D。判斷不了就用 B。下面所有 SVG 範例裡的 `<role>` 都要換成該組的色碼。

| 角色 | A 深色科技 | B 淺色簡潔 | C 暖色編輯 | D 墨綠沉穩 | 在這套語言裡用在 |
|---|---|---|---|---|---|
| background | `#101418` | `#FFFFFF` | `#FBF7F0` | `#0F2A2A` | 頁面底色；結語頁的文字色 |
| secondary_bg | `#1B2129` | `#F3F4F6` | `#F1E9DC` | `#163838` | 章節頁底色、卡片與面板、VS 圓 |
| primary | `#4F8DFF` | `#1F3A93` | `#8C2F39` | `#7FD1B9` | 舞台大圓、光暈、骨架色條、左欄頂線、結語頁滿版底 |
| accent | `#F5B942` | `#E4572E` | `#B45309` | `#F2C14E` | 大數字、短棒與底線、對角線、細環、卡片編號、章節編號、結語小標與方塊 |
| secondary_accent | `#6DD3A5` | `#2A9D8F` | `#3D5A80` | `#9DB4C0` | 對照頁右欄頂線 |
| text | `#F4F6F8` | `#1F1A1A` | `#2B2422` | `#F2F5F4` | 主要文字 |
| muted | `#9AA7B4` | `#6B7280` | `#6E635F` | `#A7B8B6` | 副標、來源、頁尾、章節浮水印 |

- 文字顏色只用 text 與 muted，例外：大數字與粗體標籤（卡片編號、章節編號、結語小標、VS）用 accent；結語頁全部文字用 background。內文與副標用強調色會過不了對比度，`validate` 會擋。
- 色塊與線條的顏色只用 primary／accent／secondary_accent／secondary_bg／background；半透明靠 `opacity`，不要調色。

## 3b. 元素角色：每個元素是為了什麼而存在

座標可以為內容調整，但**每個元素扮演的角色不能含糊**。在元素上宣告 `data-comot-role`，`validate` 就能在不管座標的前提下檢查這一頁的結構是否成立。

| 角色 | 意思 | 典型元素 |
|---|---|---|
| `field` | 關係發生的區域 | 卡片底、欄位面板、色帶 |
| `node` | 一個語意單位 | 每張卡片、對照的每一欄、流程的每一站 |
| `spine` | 這一頁的閱讀主軸 | 章節頁的骨架色條、時間軸的主線 |
| `edge` | 必要的連接 | 因果箭頭、依賴線 |
| `label` | 附著在某個 owner 上的文字 | 卡片裡的要點字、節點名稱 |
| `garnish` | 關係成立**之後**才加的裝飾 | 底線、小方塊、強調短棒 |

- **角色是選用的**：沒宣告角色的頁面驗法完全不變。宣告了就要自洽。
- `background` 是 CLI 自己寫在背景圖容器上的，作者不要手寫。
- `validate` 會擋的四件事：`garnish` 不可以是文字框（裝飾不承載意義）；一頁最多一條 `spine`；有 `edge` 就至少要有兩個 `node`；`label` 的數量不得少於當作色塊的 `node`（沒有標籤的節點不是語意單位）。
- 文字框宣告上的 `data-comot-role` 會被帶到正規化後的元素上；寫了不在表上的角色會直接被 `slide add --svg` 拒絕。

## 4. 六種已知解（完整 SVG）

**這一節不是版型目錄，是六個已知解的完整寫法。** 挑版面的流程在第 6 節：先定關係，再選解法——這六份只覆蓋 `membership`／`contrast`／`none` 三種關係的其中一種解，`order`／`parent`／`link`／`overlap` 要用第 3b 節的角色自己組。**相鄰兩頁不要用同一個解**（`validate` 的 `rhythm.repeated-shape` 會抓）。

**這一節的範例是起點，不是規格。** 欄寬比例、卡片高度、要不要把三張卡片合併成一塊面板、標題擺左上還是壓在色塊上——都可以為了這一頁的內容調整。不變的只有三件事：不越過 `design-spec.layout` 的安全區、字級與顏色取自字級表與配色、間距取自 `layout.gutter` 與 `layout.spacing` 的級距。為了貼合範例而把話講不清楚是本末倒置；無緣無故偏離它也沒有意義。

每種頁型一份可直接貼的 SVG（範例文字是示意，替換成計畫裡的關鍵詞；`<role>` 換成配色）。每一頁只講一個想法；文字比範例多就縮短或拆頁，不縮字級。

### 4.1 封面（cover，anchor）

背景 `background`。氣氛（兩顆出血的半透明大圓、一條對角 accent 細線）全部在背景圖裡（第 4b 節「柔焦色團」配方內含），頁面 SVG 只放內容與 scrim——裝飾不是元素，作者在編輯器裡就不會誤選到它們。大標是大綱裡最強的一句主張。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect id="el-bar" data-comot-name="強調短棒" x="80" y="216" width="64" height="6" fill="<accent>"/>
<text id="el-title" data-comot-name="大標" data-comot-text-width="1000" x="80" y="248" font-size="72" font-weight="700" fill="<text>">人與 agent 共編
的簡報工具</text>
<text id="el-subtitle" data-comot-name="副標" data-comot-text-width="560" x="80" y="480" font-size="28" fill="<muted>">2026 Q3 產品說明</text>
<text id="el-meta" data-comot-name="日期講者" data-comot-text-width="600" x="80" y="612" font-size="18" fill="<muted>">Noopher AI · 2026-09</text>
</svg>
```

### 4.2 章節頁（section，anchor）

背景 `secondary_bg`。左側 primary 骨架色條，右下 320 字級的章節編號浮水印（**裸 `<text>`**，不是文字框：它是裝飾），章節名壓在左中。只有小節名、沒有要點的小節才長成章節頁。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect id="el-spine" data-comot-name="骨架色條" x="0" y="0" width="16" height="720" fill="<primary>"/>
<text id="el-watermark" data-comot-name="章節浮水印" x="1200" y="640" font-size="320" font-weight="700" fill="<muted>" opacity="0.18" text-anchor="end">02</text>
<text id="el-label" data-comot-name="章節編號" data-comot-text-width="400" x="80" y="248" font-size="28" font-weight="700" fill="<accent>">02</text>
<text id="el-section-title" data-comot-name="章節名" data-comot-text-width="760" x="80" y="304" font-size="56" font-weight="700" fill="<text>">核心概念</text>
<line id="el-footer-rule" data-comot-name="頁尾線" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>
<text id="el-footer-name" data-comot-name="頁尾簡報名" data-comot-text-width="600" x="80" y="668" font-size="18" fill="<muted>">{{ presentation_name }}</text>
<text id="el-footer-page" data-comot-name="頁碼" data-comot-text-width="400" x="800" y="668" font-size="18" fill="<muted>" data-comot-text-align="right">{{ slide_number }} / {{ slide_total }}</text>
</svg>
```

浮水印寫完後 `co-motion element style set <presentation-id> slides/00N.svg el-watermark opacity 0.18`（若寫入時 opacity 沒被保留）。

### 4.3 要點頁（bullets，dense）

背景 `background`。3～5 張橫向卡片，每張是「面板 + accent 編號 + 一行關鍵詞」三個元素；卡片從 y=176 起、高 72、間距 16（第 n 張的 y = 176 + (n−1) × 88；編號 y 再 +20、關鍵詞 y 再 +19）。4 張最後一張 y=440，5 張 y=528，都在頁尾線之上。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<text id="el-title" data-comot-name="頁標題" data-comot-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="<text>">簡報是最常重做的文件</text>
<rect id="el-underline" data-comot-name="標題底線" x="80" y="136" width="56" height="4" fill="<accent>"/>
<rect id="el-card-1" data-comot-name="卡片 1" x="80" y="176" width="1120" height="72" fill="<secondary_bg>"/>
<text id="el-num-1" data-comot-name="編號 1" data-comot-text-width="64" x="104" y="196" font-size="28" font-weight="700" fill="<accent>">01</text>
<text id="el-point-1" data-comot-name="要點 1" data-comot-text-width="960" x="200" y="195" font-size="24" fill="<text>">團隊最常做、最常重做的文件</text>
<rect id="el-card-2" data-comot-name="卡片 2" x="80" y="264" width="1120" height="72" fill="<secondary_bg>"/>
<text id="el-num-2" data-comot-name="編號 2" data-comot-text-width="64" x="104" y="284" font-size="28" font-weight="700" fill="<accent>">02</text>
<text id="el-point-2" data-comot-name="要點 2" data-comot-text-width="960" x="200" y="283" font-size="24" fill="<text>">AI 當外掛，產出的人改不動</text>
<rect id="el-card-3" data-comot-name="卡片 3" x="80" y="352" width="1120" height="72" fill="<secondary_bg>"/>
<text id="el-num-3" data-comot-name="編號 3" data-comot-text-width="64" x="104" y="372" font-size="28" font-weight="700" fill="<accent>">03</text>
<text id="el-point-3" data-comot-name="要點 3" data-comot-text-width="960" x="200" y="371" font-size="24" fill="<text>">人改過的，AI 下一輪又蓋掉</text>
<line id="el-footer-rule" data-comot-name="頁尾線" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>
<text id="el-footer-name" data-comot-name="頁尾簡報名" data-comot-text-width="600" x="80" y="668" font-size="18" fill="<muted>">{{ presentation_name }}</text>
<text id="el-footer-page" data-comot-name="頁碼" data-comot-text-width="400" x="800" y="668" font-size="18" fill="<muted>" data-comot-text-align="right">{{ slide_number }} / {{ slide_total }}</text>
</svg>
```

### 4.4 對照頁（compare，dense）

背景 `background`。兩塊等寬等重的面板，左頂線 primary、右頂線 secondary_accent，中間一顆 accent 細環的 VS 圓；每欄 2～4 條、條數盡量一樣多。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<text id="el-title" data-comot-name="頁標題" data-comot-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="<text>">傳統工具 vs CoMotion</text>
<rect id="el-underline" data-comot-name="標題底線" x="80" y="136" width="56" height="4" fill="<accent>"/>
<rect id="el-panel-left" data-comot-name="左面板" x="80" y="176" width="520" height="360" fill="<secondary_bg>"/>
<rect id="el-topline-left" data-comot-name="左頂線" x="80" y="176" width="520" height="4" fill="<primary>"/>
<text id="el-head-left" data-comot-name="左欄標" data-comot-text-width="472" x="104" y="204" font-size="28" font-weight="700" fill="<text>">傳統工具</text>
<text id="el-body-left" data-comot-name="左欄內文" data-comot-text-width="472" x="104" y="260" font-size="22" fill="<text>" data-comot-list="bullet bullet bullet">母片繼承
專有格式
AI 只能建議</text>
<rect id="el-panel-right" data-comot-name="右面板" x="680" y="176" width="520" height="360" fill="<secondary_bg>"/>
<rect id="el-topline-right" data-comot-name="右頂線" x="680" y="176" width="520" height="4" fill="<secondary_accent>"/>
<text id="el-head-right" data-comot-name="右欄標" data-comot-text-width="472" x="704" y="204" font-size="28" font-weight="700" fill="<text>">CoMotion</text>
<text id="el-body-right" data-comot-name="右欄內文" data-comot-text-width="472" x="704" y="260" font-size="22" fill="<text>" data-comot-list="bullet bullet bullet">範本複製後獨立
開放 SVG
agent 直接下命令</text>
<ellipse id="el-vs-circle" data-comot-name="VS 圓" cx="640" cy="356" rx="36" ry="36" fill="<secondary_bg>" stroke="<accent>" stroke-width="3"/>
<text id="el-vs" data-comot-name="VS" data-comot-text-width="72" x="604" y="336" font-size="28" font-weight="700" fill="<accent>" data-comot-text-align="center">VS</text>
<line id="el-footer-rule" data-comot-name="頁尾線" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>
<text id="el-footer-name" data-comot-name="頁尾簡報名" data-comot-text-width="600" x="80" y="668" font-size="18" fill="<muted>">{{ presentation_name }}</text>
<text id="el-footer-page" data-comot-name="頁碼" data-comot-text-width="400" x="800" y="668" font-size="18" fill="<muted>" data-comot-text-align="right">{{ slide_number }} / {{ slide_total }}</text>
</svg>
```

### 4.5 大數字頁（number，breathing）

背景 `background`。140 字級的數字置中，下方一行說明；來源可省。數字四周的光暈與細環是背景類型的裝飾，`background` 是 `on` 時由背景圖負責氣氛，頁面 SVG 不放；只有計畫 `background: off` 時才把下面三行補在 `el-number` 之前：

```xml
<ellipse id="el-halo-1" data-comot-name="外光暈" cx="640" cy="330" rx="300" ry="300" fill="<primary>" opacity="0.10"/>
<ellipse id="el-halo-2" data-comot-name="內光暈" cx="640" cy="330" rx="220" ry="220" fill="<primary>" opacity="0.05"/>
<ellipse id="el-ring" data-comot-name="強調細環" cx="640" cy="330" rx="150" ry="150" fill="none" stroke="<accent>" stroke-width="3" opacity="0.7"/>
```

**數字只能來自作者的大綱**。沒有數字、只有一句主張時，數字列改成字級 48（`claim`）、fill text、≤ 2 行、y=264，說明列 y=432。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<text id="el-number" data-comot-name="大數字" data-comot-text-width="1120" x="80" y="216" font-size="140" font-weight="700" fill="<accent>" data-comot-text-align="center">12 分鐘</text>
<text id="el-caption" data-comot-name="說明" data-comot-text-width="920" x="180" y="440" font-size="28" fill="<text>" data-comot-text-align="center">從大綱到可上台的初稿</text>
<text id="el-source" data-comot-name="來源" data-comot-text-width="1120" x="80" y="600" font-size="18" fill="<muted>" data-comot-text-align="center">第一批試用團隊的平均時間</text>
<line id="el-footer-rule" data-comot-name="頁尾線" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>
<text id="el-footer-name" data-comot-name="頁尾簡報名" data-comot-text-width="600" x="80" y="668" font-size="18" fill="<muted>">{{ presentation_name }}</text>
<text id="el-footer-page" data-comot-name="頁碼" data-comot-text-width="400" x="800" y="668" font-size="18" fill="<muted>" data-comot-text-align="right">{{ slide_number }} / {{ slide_total }}</text>
</svg>
```

### 4.6 結語頁（closing，anchor）

背景 **`primary` 滿版**（`slide style set --background <primary>`），全部文字用 `background` 色，小標 accent，右下一個 accent 方塊。結語是一句帶得走的結論或下一步，**不是「謝謝」、不是聯絡方式、不是封面再放一次**；大綱沒有結論就不做結語頁。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<text id="el-label" data-comot-name="結語小標" data-comot-text-width="400" x="80" y="200" font-size="22" font-weight="700" fill="<accent>">下一步</text>
<text id="el-claim" data-comot-name="結論" data-comot-text-width="1000" x="80" y="248" font-size="48" font-weight="700" fill="<background>">開放 beta 給 50 個團隊
收集從零開始的真實案例</text>
<text id="el-next" data-comot-name="下一步說明" data-comot-text-width="1000" x="80" y="520" font-size="24" fill="<background>">2026 Q4 開始收案</text>
<rect id="el-square" data-comot-name="強調方塊" x="1104" y="544" width="96" height="96" fill="<accent>"/>
</svg>
```

## 4b. 背景圖：由你產生的 SVG 圖片，放在頁面最底層

背景圖是一張獨立的 SVG 資產，用 `slide background set` 放在頁面**最底層**（容器 `id="el-background"`、`data-comot-role="background"`、鎖定，作者拖不動、`validate` 不驗它）。它把頁面的氣質再往上拉一層，但**不承載意義**：拿掉它，頁面的意思一個字都不少。計畫 `plan/outline.md` 的 `background` 是 `off` 時，整份都不放。

### 哪些頁型放、放多濃

| 頁型 | 預設配方 | `--opacity` |
|---|---|---|
| 封面 | 柔焦色團 | 0.9 |
| 章節頁 | 對角光束 | 0.7 |
| 大數字頁 | 漸層網格 | 0.8 |
| 結語頁 | 柔焦色團 | 0.6（結語頁底色是 primary，色團會變成同色系的層次） |
| 要點頁、對照頁 | 點陣格線 | 0.5（淡版；內容區的卡片與面板本身就是 scrim） |

一份簡報**只用一種配方**（封面與結語可以共用色團、內容頁共用一種），同配方同配色只建一個資產，所有頁面重用同一個路徑。

### 四種配方（完整 SVG，色碼用角色佔位）

**所有裝飾幾何（舞台大圓、封面的兩顆大圓與對角線、光束、點陣）都住在背景圖裡，不放進頁面 SVG**——頁面 SVG 只有內容元素與 scrim，作者在編輯器裡不會誤選到裝飾，換一張背景就換整個氣氛。每一份都是 1280×720、只用 `<defs>` 漸層、`<pattern>` 與基本圖元，沒有 `<filter>`（渲染便宜、縮圖與匯出都一致）。**左半與中央（x 80～760、y 72～648）一律保持暗與安靜**，亮部只在右緣與右下，這是文字區能不加 scrim 就讀得清楚的前提。把 `<role>` 換成 design-spec 的色碼；四組配色都適用。

**漸層網格**（右下一團 primary 光暈、64px 淡格線、三顆 accent 光點；適合大數字頁）：

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<radialGradient id="bg-wash" cx="1.05" cy="1.05" r="0.9">
<stop offset="0" stop-color="<primary>" stop-opacity="0.32"/>
<stop offset="0.5" stop-color="<primary>" stop-opacity="0.1"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0"/>
</radialGradient>
<radialGradient id="bg-fade" cx="0.15" cy="0.4" r="0.9">
<stop offset="0" stop-color="<background>" stop-opacity="1"/>
<stop offset="0.5" stop-color="<background>" stop-opacity="0.6"/>
<stop offset="1" stop-color="<background>" stop-opacity="0"/>
</radialGradient>
<pattern id="bg-grid" width="64" height="64" patternUnits="userSpaceOnUse">
<path d="M64 0H0V64" fill="none" stroke="<primary>" stroke-width="1" opacity="0.18"/>
</pattern>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-wash)"/>
<rect width="1280" height="720" fill="url(#bg-grid)"/>
<rect width="1280" height="720" fill="url(#bg-fade)"/>
<circle cx="1180" cy="120" r="3" fill="<accent>" opacity="0.9"/>
<circle cx="1052" cy="248" r="2" fill="<accent>" opacity="0.6"/>
<circle cx="1244" cy="376" r="2" fill="<accent>" opacity="0.5"/>
  <ellipse cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>
</svg>
```

**對角光束**（三道由右上斜向左下的光束，primary 兩道、accent 一道，左側用徑向漸層壓暗；適合章節頁）：

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-beam-1" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<primary>" stop-opacity="0"/>
<stop offset="0.5" stop-color="<primary>" stop-opacity="0.22"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0"/>
</linearGradient>
<linearGradient id="bg-beam-2" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<accent>" stop-opacity="0"/>
<stop offset="0.5" stop-color="<accent>" stop-opacity="0.14"/>
<stop offset="1" stop-color="<accent>" stop-opacity="0"/>
</linearGradient>
<radialGradient id="bg-beam-fall" cx="0.2" cy="0.5" r="0.8">
<stop offset="0" stop-color="<background>" stop-opacity="1"/>
<stop offset="0.45" stop-color="<background>" stop-opacity="0.7"/>
<stop offset="1" stop-color="<background>" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M520 720 L1280 -40 L1280 200 L760 720 Z" fill="url(#bg-beam-1)"/>
<path d="M820 720 L1280 260 L1280 420 L980 720 Z" fill="url(#bg-beam-2)"/>
<path d="M300 720 L1280 -240 L1280 -140 L400 720 Z" fill="<primary>" opacity="0.06"/>
<rect width="1280" height="720" fill="url(#bg-beam-fall)"/>
  <ellipse cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>
</svg>
```

**點陣格線**（32px 點陣，中央被壓暗只留邊緣、右上一抹 primary、一條 accent 垂直細線；適合要點頁與對照頁的淡版）：

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-dots" width="32" height="32" patternUnits="userSpaceOnUse">
<circle cx="16" cy="16" r="2" fill="<muted>" opacity="0.75"/>
</pattern>
<radialGradient id="bg-dots-mask" cx="0.3" cy="0.45" r="0.75">
<stop offset="0" stop-color="<background>" stop-opacity="1"/>
<stop offset="0.5" stop-color="<background>" stop-opacity="0.7"/>
<stop offset="1" stop-color="<background>" stop-opacity="0"/>
</radialGradient>
<linearGradient id="bg-dots-edge" x1="0" y1="1" x2="1" y2="0">
<stop offset="0.6" stop-color="<secondary_bg>" stop-opacity="0"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0.32"/>
</linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-dots-edge)"/>
<rect width="1280" height="720" fill="url(#bg-dots)"/>
<rect width="1280" height="720" fill="url(#bg-dots-mask)"/>
<line x1="1040" y1="0" x2="1040" y2="720" stroke="<accent>" stroke-width="1" opacity="0.35"/>
  <ellipse cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>
</svg>
```

**柔焦色團**（三個重疊的徑向漸層色團：primary 在右上、accent 在右下、secondary_accent 在右緣；不用 `<filter>` 模糊，靠漸層本身柔化；適合封面與結語頁）：

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<radialGradient id="bg-blob-1" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="<primary>" stop-opacity="0.55"/>
<stop offset="0.45" stop-color="<primary>" stop-opacity="0.2"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0"/>
</radialGradient>
<radialGradient id="bg-blob-2" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="<accent>" stop-opacity="0.4"/>
<stop offset="0.5" stop-color="<accent>" stop-opacity="0.12"/>
<stop offset="1" stop-color="<accent>" stop-opacity="0"/>
</radialGradient>
<radialGradient id="bg-blob-3" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="<secondary_accent>" stop-opacity="0.3"/>
<stop offset="1" stop-color="<secondary_accent>" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<ellipse cx="1120" cy="140" rx="560" ry="420" fill="url(#bg-blob-1)"/>
<ellipse cx="1000" cy="640" rx="480" ry="320" fill="url(#bg-blob-2)"/>
<ellipse cx="1300" cy="480" rx="360" ry="300" fill="url(#bg-blob-3)"/>
  <ellipse cx="1120" cy="120" rx="460" ry="460" fill="<primary>" opacity="0.12"/>
  <ellipse cx="1320" cy="440" rx="300" ry="300" fill="<primary>" opacity="0.06"/>
  <line x1="760" y1="720" x2="1280" y2="200" stroke="<accent>" stroke-width="2" opacity="0.6"/>
</svg>
```

### 有背景圖時的 scrim 規則

背景圖再暗也會降低小字的對比，所以 `validate` 的 `structure.scrim` 會要求：**頁面有背景圖時，每個文字框（頁尾除外）都要完全落在一塊「scrim 面板」上**——一個在文件順序上位於它之前、fill 是 `background` 或 `secondary_bg`、`opacity` 缺省或 ≥ 0.6 的 rect。字級 ≥ `claim`（48）的大字例外：封面大標、章節名、大數字、結語主張不需要 scrim，配方保證那些區域是暗的。

- **要點頁、對照頁**：卡片（`el-card-n`）與面板（`el-panel-left/right`）本來就是 scrim，標題在 y 72～130 沒有面板——加一條標題 scrim：`<rect id="el-scrim-title" data-comot-name="標題底" x="64" y="64" width="1152" height="88" fill="<background>" opacity="0.7"/>`，放在標題之前。
- **封面**：副標與日期講者要一條 scrim：`<rect id="el-scrim-sub" data-comot-name="副標底" x="64" y="468" width="576" height="184" fill="<background>" opacity="0.65"/>`，放在 `el-subtitle` 之前（寬度只到 x=640，避開右側大圓，scrim 才不會在亮部露出一塊灰板；副標因此限寬 560）。
- **章節頁**：accent 標籤（28）要 scrim：`<rect id="el-scrim-label" data-comot-name="標籤底" x="64" y="224" width="432" height="56" fill="<secondary_bg>" opacity="0.7"/>`。
- **大數字頁**：說明（28）與來源（18）要 scrim：`<rect id="el-scrim-caption" data-comot-name="說明底" x="160" y="436" width="960" height="212" fill="<background>" opacity="0.65"/>`，放在 `el-caption` 之前。
- **結語頁**：標籤（22）與下一步（24）要 scrim，fill 用 `<primary>`（該頁底色）：`<rect id="el-scrim-next" data-comot-name="下一步底" x="64" y="188" width="1032" height="60" fill="<primary>" opacity="0.7"/>` 與 `<rect id="el-scrim-label" … x="64" y="488" width="1032" height="56" fill="<primary>" opacity="0.7"/>`。

scrim 是面板，喘息頁（章節、大數字）的 `rhythm.breathing-cards` 只數 `secondary_bg` 且 ≥ 200×80 的 rect，上面這些 `background` 色或小尺寸的 scrim 不會被算進去；章節頁那條用了 `secondary_bg` 但高度只有 56，同樣不算。

### 命令順序

1. 同配方同配色只做一次：`co-motion asset import <presentation-id> --svg '<背景 SVG>' --name bg-mesh-a.svg`（檔名只能用英數、`-`、`_`，副檔名 `.svg`；同名已存在會被拒絕，換個名字或先刪）。回傳 `data.path` 是 `assets/bg-mesh-a.svg`。
2. 照第 4 節寫該頁：`co-motion slide add <presentation-id> --svg '<整頁 SVG>'`（含上面的 scrim rect）。
3. `co-motion slide background set <presentation-id> slides/00N.svg --asset assets/bg-mesh-a.svg --opacity 0.7`；要拿掉就 `--none`。
4. 動畫照第 5 節；**背景圖不加任何效果**，它從第一格就在。

`--svg` 的引號規則跟第 0 節一樣：整段單引號包住、裡面只用雙引號、不能有半形單引號。漸層的 `id`（`bg-…`）只在那張資產內有效，不會跟頁面元素的 `el-…` 撞名。

## 5. 動畫腳本

**一次點擊＝講者講一件事，不是畫一個元素。** 一頁需要幾個 `on-click`，由這一頁要分幾段講決定；同一段話裡的東西（標題與它的底線、卡片與卡片裡的編號與字、數字與它的說明）一起進場，用 `with-previous`。裝飾幾何與背景圖**完全不加效果**——它們不承載意義，沒有可以講的那一步。

計畫 `animation`：`full`（預設，逐段揭露）、`minimal`（整頁一次到齊，只留一個 on-click）、`none`（不加）。

**同一段裡的元素先 `element group` 成一個群組，再對群組下一個效果**，不要一長串 `with-previous`：群組是邏輯單位，作者拖一下整段一起動，動畫也只要一次（`element group` 會清掉成員既有的效果，所以一定先 group 再套動畫）。下表的 `with-previous` 只在沒有群組時才需要。

每頁寫完 SVG、分好群組後下 `co-motion effect add <presentation-id> slides/00N.svg <元素 id> --family enter --effect <效果> --start <時機> --duration <秒>`。整份做完只下一次轉場：`co-motion slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3 --all`（`animation` 為 `none` 時不下）。

| 頁型 | full 的講述步驟 | minimal |
|---|---|---|
| 封面 | **1 步**：`el-title` fly-up on-click 0.5，`el-subtitle`／`el-meta` fade with-previous 0.4 | 同 full |
| 章節頁 | **1 步**：`el-label` fade on-click 0.3，`el-section-title` fly-up with-previous 0.5 | 同 full |
| 要點頁 | **1＋N 步**：`el-title` fly-up on-click 0.5（`el-underline` with-previous 0.3）；之後**每張卡片一步**——`el-card-n` fade on-click 0.3，`el-num-n`／`el-point-n` with-previous 0.3 | **1 步**：標題 on-click，全部要點 with-previous |
| 對照頁 | **3 步**：標題 → 左欄整組（面板、頂線、欄標、內文、`el-vs-circle`／`el-vs` 全部 with-previous）→ 右欄整組 | **1 步**：整頁一起 |
| 大數字頁 | **1 步**：`el-number` zoom on-click 0.5，`el-caption`／`el-source` fade with-previous 0.4 | 同 full |
| 結語頁 | **1 步**：`el-claim` fly-up on-click 0.5，`el-label`／`el-next`／`el-square` with-previous 0.4 | 同 full |

- **一頁的 `on-click` 步驟不超過 5**。要點頁超過 4 條就該拆頁，不是多按幾次。
- 頁尾線、簡報名、頁碼、背景圖、所有裝飾幾何不加效果。
- 可用的 enter 效果只有 `appear`、`fade`、`fly-up`、`fly-left`、`zoom`。

## 6. 先定關係，再選解法

**不要問「這是哪一種頁型」，要問「這一頁的內容之間是什麼關係」。** 關係決定幾何要承載什麼；頁型只是某些關係的已知解的名字。

### 6.1 六種關係

| 關係 | 什麼時候是它 | 幾何要承載的東西 |
|---|---|---|
| `membership` | 並列、歸屬、同一組裡的幾件事 | 共同的場域或重複的單位；**沒有方向** |
| `order` | 順序、步驟、排名、時間 | 一條看得出方向的閱讀路徑：直線／轉折／上升；起點與終點要分得出來 |
| `contrast` | A vs B、之前／之後、選項比較 | 共用的基準線加上分隔；兩邊的不變量要對齊才看得出差異 |
| `parent` | 一件事統轄或分解成幾件 | 層級：縮排、巢狀、尺寸差；根要看得出來 |
| `link` | 依賴、影響、因果、轉換 | 必要的連接；來源與目標要明確，線越少越好 |
| `overlap` | 交集、共用的部分 | 相交的區域，共同區與各自區都要看得出來 |
| `none` | 單一主張、一個數字、一句結論 | 沒有關係要承載——留白與尺寸就是全部 |

**硬規則**：不得只因為「有三個項目」就採用三等分欄位或鏡射對稱。三件並列的事才用等分；三件有先後的事要看得出方向。節點數只影響間距與換行，不構成採用對稱的理由。

### 6.2 一個關係有多種解

同一個關係可以用不同的幾何承載。**相鄰兩頁不要用同一個解**（`validate` 的 `rhythm.repeated-shape` 會抓）。

| 關係 | 可用的解（`blueprint.shape` 就寫這個名字） |
|---|---|
| `membership` | `card-wall`（重複的卡片）／`shared-field`（一塊共同場域內分區，分隔靠留白或細線）／`banded-list`（單欄橫條，靠編號與粗細分層）／`chip-cluster`（大小不一的標籤群） |
| `order` | `spine-path`（一條主軸串起節點）／`stepped`（逐階上升或下降的色塊）／`numbered-run`（大號數字領頭的橫列） |
| `contrast` | `split-panel`（左右兩塊面板）／`shared-axis`（共用一條基準線，兩邊往兩側展開）／`before-after`（上下疊，中間一條分界） |
| `parent` | `indent-tree`（縮排）／`nested-field`（大場域裡放小場域）／`scale-drop`（尺寸逐層變小） |
| `link` | `chain`（依序連接）／`hub`（一個中心放射）／`flow`（來源→轉換→結果） |
| `overlap` | `venn`（相交區域）／`layered`（疊放，共同區在最上層） |
| `none` | `hero-number`（大數字）／`claim-field`（滿版一句話）／`cover-stack`（封面的標題堆疊） |

這張表是**起點不是清單**：頁面需要一個表上沒有的解，就自己組一個，並在 `blueprint.shape` 給它一個描述性的名字。

### 6.3 已知解：六種頁型

第 4 節的六份完整 SVG，是下列組合的**已知解**，可以直接用，但不是唯一答案：

| 頁型 | 解的是什麼 | 對應 |
|---|---|---|
| 封面 | `none` | `cover-stack` |
| 章節頁 | `none` | `claim-field` |
| 要點頁 | `membership` | `card-wall` |
| 對照頁 | `contrast` | `split-panel` |
| 大數字頁 | `none` | `hero-number` |
| 結語頁 | `none` | `claim-field` |

- 計畫的 `type` 欄位是**選填**的：用了已知解就填它（`validate` 會多驗一條該頁型的簽名字級，範本也會登記）；自己組的構圖就不要填，只留 `relationship`。
- `order`、`parent`、`link`、`overlap` **沒有現成的完整範例**——這些關係要自己組，用第 3b 節的角色（`field`／`node`／`spine`／`edge`／`label`）把幾何拼出來。不要因為沒有範例就退回要點頁：退回去等於把有方向的內容講成並列的內容，那是錯的。

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
- 喘息頁（大數字頁、章節頁）**禁止卡片格**：面板（secondary_bg 的大色塊）不超過 2 個；靠留白與大字。
- rect 不加框線（`stroke`）、不加陰影；細環與對角線是 ellipse／line 的 stroke，這是允許的。
- 不做「謝謝」頁、不做只有聯絡方式的頁、不重複封面。
- 不縮字級來塞文字；文字太多就縮短或拆頁。

## 9. 自我檢查：跑 `co-motion validate`

規則與門檻寫在 CLI 裡，不要自己心算：`co-motion validate <presentation-id> [slides/00N.svg]`。結束碼非零代表有錯誤，`data.errors[]` 每一筆有 `slide`、`element`、`rule`、`actual`、`limit`、`message`。有 `plan/design-spec.md` 時字數門檻依它的 `density`；沒有計畫檔時只驗幾何與骨架。

**第一頁閘門**：封面與第一張內容頁做完各跑一次 `validate`；有錯誤先改做法（改短文字、改回表上的字級），確認都是 0 錯誤才做第 3 頁起，不要每頁各修各的。

| rule | 在驗什麼 |
|---|---|
| `text.title-length`、`text.bullet-length`、`text.bullet-lines`、`text.bullet-count`、`text.page-total` | 第 7 節的文字量上限 |
| `focus.single-title` | 一頁只有一個標題角色 |
| `geometry.right-overflow`、`geometry.bottom-overflow`、`geometry.text-overlap` | 文字框右緣 ≤ 1200、下緣 `y + 行數 × 1.45 × 字級 ≤ 648`、同欄文字框不重疊（裝飾幾何可以出血，不驗） |
| `style.font-size`、`style.text-fill`、`style.shape-fill` | 字級在第 2 節的表上；文字色只有 text／muted（大數字與粗體標籤可 accent、結語頁可 background）；色塊色只用配色組的角色、`none` 或 `url(#…)` |
| `structure.background`、`structure.notes`、`structure.template` | 背景已設、備忘稿非空、出現過的頁型都登記了範本 |
| `structure.scrim` | 有背景圖的頁，每個文字框（頁尾與 ≥ claim 的大字除外）都落在一塊 scrim 面板上（第 4b 節） |
| `structure.background-image` | 計畫 `background` 是 `on` 時，每一頁都有背景圖（漏下 `slide background set` 會被這條抓到） |
| `blueprint.*` | 有寫 `blueprint` 的頁面，畫出來的 node 數與 on-click 步數要跟構圖時寫的一致 |
| `rhythm.repeated-shape` | 相鄰兩頁不得用同一個 `blueprint.shape` 解同一種 `relationship`、又是同樣的單位數 |
| `role.*` | 有宣告角色的頁面要自洽：`garnish` 不承載文字、一頁 ≤ 1 條 `spine`、有 `edge` 就 ≥ 2 個 `node`、`label` 不少於 node 色塊（第 3b 節） |
| `roster.page-count`、`roster.page-type` | 頁數與每頁頁型跟 `plan/outline.md` 對得上（每種頁型有它的特徵字級） |
| `rhythm.breathing-cards` | breathing 頁的面板 ≤ 2 |
| `motion.transition`、`motion.enter` | `animation` 不是 `none` 時每頁有轉場；`full` 每頁至少一個進場效果、`minimal` 封面／要點／對照頁至少一個 |
| `taboo.thank-you`、`taboo.duplicate-cover`、`taboo.stroke` | 謝謝頁、重複封面、rect 的框線 |

**整份做完**：`validate` 整份 0 錯誤，`template list` 列得出「封面」「要點頁」等名稱。
