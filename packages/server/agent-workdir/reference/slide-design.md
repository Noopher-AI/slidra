# SVG 作者指南：「編輯／科技」視覺語言

這份文件是 agent **一頁寫一份 SVG** 的依據：舞台骨架、字級表、配色、元素角色、一份語法示範與六個已知解的骨架、動畫腳本、挑關係與密度規則，以及最後用 `co-motion validate` 驗收。`comotion-plan` 用第 2、3、6、7 節寫 `plan/design-spec.md` 與挑頁型；`comotion-build` 用第 1、4、4b、5 節做頁面；`comotion-new-slide` 在有計畫時照同一套做一頁。簡報已經有範本或設計過的頁面時，**沿用既有的，不要用這份指南蓋掉它**。

所有數字以 **1280×720** 畫布為準（`co-motion new` 的預設）。

**同比例的畫布（16:9）**：先 `cat project.json` 讀出 `canvas.width`，算出 `k = width ÷ 1280`，把所有座標、寬度、半徑、字級都乘以 k（1920×1080 就是 ×1.5），`viewBox` 寫成畫布尺寸。

**不同比例的畫布**（直式、方形、A4）：**`k` 不適用**。寬度縮了但高度可能是兩倍多，照 `k` 縮放會得到一頁擠在上方、字又太小的版面。這些畫布用版面庫裡專門為它們畫的版面（51–55），字級直接照那些檔案的槽位表——直式內容通常在手機上近距離看，字要比 16:9 更大，不是更小。

| 畫布 | 尺寸 | 用途 |
|---|---|---|
| 16:9 | 1280×720（或 1920×1080） | 簡報、會議、螢幕 |
| 4:3 | 1024×768 | 傳統投影機、學術場合 |
| 3:4 | 1242×1660 | 圖文知識貼文 |
| 1:1 | 1080×1080 | 方形貼文、語錄卡 |
| 9:16 | 1080×1920 | 限時動態、短影音封面 |
| A4 | 1240×1754 | 列印海報、單張文件 |

畫布用 `co-motion presentation canvas set <id> --width <w> --height <h>` 設定，而且要在**建第一頁之前**設好。

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

## 4. 語法示範與六種已知解的骨架

這一節**不給可以直接貼上的完整頁面**。版面是每一頁自己的決定（流程在第 6 節）；這裡只給兩樣東西：一份示範「一頁合格的 SVG 在語法上長什麼樣」，以及六個已知解的骨架，讓你知道它們的結構，而不是照抄它們的座標。

### 4.0 語法示範（唯一一份完整 SVG）

這一頁只為了示範寫法：文字框怎麼宣告、角色怎麼標、頁尾三件怎麼放、scrim 疊在誰前面。**它不是版面建議**——內容頁不會長這樣。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect id="el-scrim-title" data-comot-name="標題底" data-comot-role="field" x="80" y="64" width="1120" height="88" fill="<background>" opacity="0.7"/>
<text id="el-title" data-comot-name="頁標題" data-comot-role="label" data-comot-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="<text>">標題是這一頁的主張</text>
<g id="el-unit-1" data-comot-role="node"><rect x="80" y="176" width="1120" height="72" fill="<secondary_bg>"/></g>
<text id="el-point-1" data-comot-name="要點 1" data-comot-role="label" data-comot-text-width="960" x="200" y="195" font-size="24" fill="<text>">一行關鍵詞，不加句號</text>
<line id="el-footer-rule" data-comot-name="頁尾線" x1="80" y1="656" x2="1200" y2="656" stroke="<muted>" stroke-width="1" opacity="0.4"/>
<text id="el-footer-name" data-comot-name="頁尾簡報名" data-comot-text-width="600" x="80" y="668" font-size="18" fill="<muted>">{{ presentation_name }}</text>
<text id="el-footer-page" data-comot-name="頁碼" data-comot-text-width="400" x="800" y="668" font-size="18" fill="<muted>" data-comot-text-align="right">{{ slide_number }} / {{ slide_total }}</text>
</svg>
```

從這一份要帶走的**語法事實**（不是版面事實）：

- 文字一律是 `<text data-comot-text-width=…>` 宣告，內容直接換行分段，不要自己放 `<tspan>`；`<role>` 是配色角色的佔位，寫入前換成 design-spec 的色碼。
- 每個元素有 `id` 與 `data-comot-name`（作者在編輯器裡看到的名字），語意元素再加 `data-comot-role`（第 3b 節）。
- scrim 就是一塊在被墊文字**之前**出現的 rect；它同時可以是那段內容的 `field`。
- 頁尾三件（線、`{{ presentation_name }}`、`{{ slide_number }} / {{ slide_total }}`）的座標是全份固定的骨架（第 1 節），內容頁都放，封面與結語不放。
- 座標與尺寸取自 `design-spec.layout` 的安全區與間距級距——上面的 80／1120／656 是 `side_margin: 80` 時的值，錨點不同就跟著換。

### 4.1–4.6 六種已知解的骨架

這六個是第 6.3 節那張表的另一面：知道它們的結構，才知道什麼時候該用、什麼時候該自己組。**骨架只說有哪些角色、誰墊著誰、垂直節奏怎麼走；座標、比例、尺寸由這一頁的內容決定。**

| 已知解 | 關係 | 骨架 |
|---|---|---|
| **封面**（`cover-stack`） | `none` | accent 短棒 `garnish` → 大標（`cover` 字級，≤ 2 行）→ 副標（`subtitle`）→ 日期講者（`caption`）。四件由上而下貼左緣堆疊，垂直間距取 `layout.spacing` 的大級距。**不放頁尾。** |
| **章節頁**（`claim-field`） | `none` | 左緣 primary `spine` 色條（滿高）→ 章節編號 `label`（`subtitle` 字級、accent）→ 章節名 `label`（`section` 字級）壓在左中。右下可放一個**裸 `<text>`** 的大號編號浮水印（不是文字框，它是 `garnish`，`opacity` 0.18）。放頁尾。 |
| **要點頁**（`card-wall`） | `membership` | 標題 `label` → accent 底線 `garnish` → N 個 `node`，每個 `node` 是一塊 `field` 加上編號 `label` 與一行關鍵詞 `label`。N 個 node 等高、等間距垂直排列（沒有方向，所以節奏必須均勻）。放頁尾。 |
| **對照頁**（`split-panel`） | `contrast` | 標題 `label` → accent 底線 `garnish` → 左右兩個 `node`，各自是一塊等寬等高的 `field` ＋ 頂線 `garnish`（左 primary、右 secondary_accent）＋ 欄標 `label` ＋ 內文 `label`。兩欄的條數與基準線要對齊，差異才看得出來。中間可放一顆 VS 圓（`node` 之間的分界，不是 `garnish`）。放頁尾。 |
| **大數字頁**（`hero-number`） | `none` | 大數字 `label`（`number` 字級，置中）→ 說明 `label`（`caption`／`subtitle` 字級，置中）→ 來源 `label`（`caption`，可省）。**數字只能來自作者的大綱**；沒有數字、只有一句主張時，改用 `claim` 字級、fill `text`、≤ 2 行。放頁尾。 |
| **結語頁**（`claim-field`） | `none` | 底色**滿版 `primary`**（`slide style set --background <primary>`），全部文字用 `background` 色 → 小標 `label`（accent）→ 結論 `label`（`claim` 字級，≤ 2 行）→ 下一步 `label`。右下一個 accent 方塊 `garnish`。結語是一句帶得走的結論，**不是「謝謝」、不是聯絡方式、不是封面再放一次**；大綱沒有結論就不做。**不放頁尾。** |

- 骨架沒有給座標是刻意的：**同一個骨架在不同內容下本來就該有不同比例**。三條短要點與三條長要點的卡片高度不會一樣。
- 用了其中一個骨架時，把對應的名字寫進 `blueprint.shape`（表格第一欄的括號），並把 `type` 一併寫回計畫（第 6.3 節）。
- `order`／`parent`／`link`／`overlap` 沒有骨架，用第 3b 節的角色自己組——`spine` 拉出方向、`node` 沿著它排、`edge` 連接必要的兩端。

## 4b. 背景圖：由你產生的 SVG 圖片，放在頁面最底層

背景圖是一張獨立的 SVG 資產，用 `slide background set` 放在頁面**最底層**（容器 `id="el-background"`、`data-comot-role="background"`、鎖定，作者拖不動、`validate` 不驗它）。它把頁面的氣質再往上拉一層，但**不承載意義**：拿掉它，頁面的意思一個字都不少。計畫 `plan/outline.md` 的 `background` 是 `off` 時，整份都不放。

### 哪一頁放哪一種、放多濃

分派看**節奏**（`rhythm`），不看頁型——節奏說的正是這一頁要多安靜或多滿。

| `rhythm` | 這一頁是什麼 | 預設配方 | `--opacity` |
|---|---|---|---|
| `anchor` | 定錨頁：封面、章節、結語 | 柔焦色團 | 0.9（頁面底色是 `primary` 時降到 0.6，色團會變成同色系的層次） |
| `breathing` | 喘息頁：一個數字、一句主張 | 漸層網格 | 0.8 |
| `dense` | 資訊頁：有多個語意單位 | 點陣格線 | 0.5（淡版；內容區的 `field` 本身就是 scrim） |

想要更強的方向感時（`order` 關係的頁面），`anchor` 與 `breathing` 可以改用「對角光束」——光束本身有方向，配並列的內容會說錯話。

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

背景圖再暗也會降低小字的對比，所以 `validate` 的 `structure.scrim` 會要求：**頁面有背景圖時，每個文字框（頁尾除外）都要完全落在一塊「scrim 面板」上**——一個在文件順序上位於它之前、fill 是 `background` 或 `secondary_bg`、`opacity` 缺省或 ≥ 0.6 的 rect。字級 ≥ `claim`（48）的大字例外：大標、章節名、大數字、結語主張不需要 scrim，配方保證那些區域是暗的。

**怎麼滿足它，是這一頁的構圖決定，不是查表：**

- **已經有 `field` 的頁面**（卡片、面板、共同場域）——`field` 本身就是 scrim，只要它的 fill 是 `background`／`secondary_bg`、opacity ≥ 0.6，落在上面的 `label` 就過了。這是最自然的做法：**先想這段文字屬於哪個 `field`，而不是先想要加哪一塊 scrim**。
- **落在 `field` 之外的文字**（標題、頁間說明、來源）——替它加一塊 scrim rect：涵蓋該文字框的四邊、放在它之前、fill 取 `background` 或 `secondary_bg`（頁面底色是 `primary` 時取 `primary`）、`opacity` 0.65～0.7。寬高由那個文字框決定，不是固定值。
- **scrim 不要越過亮部**：配方保證左半與中央（x 80～760、y 72～648）是暗的，亮部在右緣與右下。一塊延伸到亮部的 scrim 會在那裡露出一片灰板——寧可讓文字框窄一點。
- **不需要 scrim 就不要加**：`claim` 級以上的大字、以及頁尾，都在規則的例外裡。多加一塊面板會讓喘息頁變擁擠。

scrim 是面板，但喘息頁的 `rhythm.breathing-cards` 只數 `secondary_bg` 且 ≥ 200×80 的 rect——用 `background` 色、或尺寸小於這個的 scrim 不會被算進去。

### 命令順序

1. 同配方同配色只做一次：`co-motion asset import <presentation-id> --svg '<背景 SVG>' --name bg-mesh-a.svg`（檔名只能用英數、`-`、`_`，副檔名 `.svg`；同名已存在會被拒絕，換個名字或先刪）。回傳 `data.path` 是 `assets/bg-mesh-a.svg`。
2. 寫該頁：`co-motion slide add <presentation-id> --svg '<整頁 SVG>'`（含上面的 scrim rect；語法照第 4.0 節）。
3. `co-motion slide background set <presentation-id> slides/00N.svg --asset assets/bg-mesh-a.svg --opacity 0.7`；要拿掉就 `--none`。
4. 動畫照第 5 節；**背景圖不加任何效果**，它從第一格就在。

`--svg` 的引號規則跟第 0 節一樣：整段單引號包住、裡面只用雙引號、不能有半形單引號。漸層的 `id`（`bg-…`）只在那張資產內有效，不會跟頁面元素的 `el-…` 撞名。

## 5. 動畫腳本

**一次點擊＝講者講一件事，不是畫一個元素。** 一頁需要幾個 `on-click`，由這一頁要分幾段講決定（就是 `blueprint.steps`）。

計畫 `animation`：`full`（預設，逐段揭露）、`minimal`（整頁一次到齊，只留一個 on-click）、`none`（不加）。

### 5.1 效果下在群組上，不下在具名元素上

先把同一段話裡的元素 `element group` 成一個群組，**再對群組 id 下一個效果**。群組就是動畫的錨點——一段一個錨點，一個錨點一個效果。不要去記某個元素叫什麼名字，也不要串一長串 `with-previous`。

```
co-motion effect add <presentation-id> slides/00N.svg <群組 id> --family enter --effect <效果> --start on-click --duration <秒>
```

- `element group` 會清掉成員既有的效果，所以**一定先 group 再套動畫**。
- 整份做完只下一次轉場：`co-motion slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3 --all`（`animation` 為 `none` 時不下）。

### 5.2 哪些東西不進動畫（靠角色判斷）

| 角色 | 進動畫？ |
|---|---|
| `node`（連同它的 `field`／`label`，通常已在同一個群組裡） | ✅ 每段一個 `on-click` |
| `spine` | ✅ 跟它串起的第一段一起（`with-previous`），或自成第一步 |
| `edge` | ✅ 跟它連接的後一個 node 一起 |
| `garnish` | ❌ **絕不加效果**。裝飾是關係成立之後才加的，沒有可以講的那一步 |
| `background`（背景圖） | ❌ 絕不加效果 |
| 頁尾線、簡報名、頁碼 | ❌ 不加效果 |

**判斷依據是角色，不是元素叫什麼名字。** 沒有標角色又看起來像裝飾的東西（純色塊、線、圓）一律不加。

### 5.3 強度

| `animation` | 做法 |
|---|---|
| `full` | 每個講述步驟一個 `on-click`，步數等於 `blueprint.steps` |
| `minimal` | 整頁只有一個 `on-click`（第一個群組），其餘 `with-previous` |
| `none` | 不加效果，也不下轉場 |

- **一頁的 `on-click` 步驟不超過 5**。超過就該拆頁，不是多按幾次。
- 可用的 enter 效果只有 `appear`、`fade`、`fly-up`、`fly-left`、`zoom`。選哪一個看內容：並列用 `fade`、有方向的用 `fly-left`／`fly-up`、單一焦點用 `zoom`。

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

第 4 節列出骨架的那六個，是下列組合的**已知解**——知道結構就好，不是照抄的對象，更不是唯一答案：

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
| `blueprint.required` | 計畫 `confirmed` 之後，每一頁都必須寫下 `blueprint` |
| `role.required` | `relationship` 不是 `none` 的頁面，至少要標出一個 `node` |
| `role.garnish-animated` | `garnish` 不得有任何進場效果（第 5.2 節） |
| `roster.relationship-variety` | 4 頁以上時，同一種 `relationship` 不得超過半數 |
| `role.*` | 有宣告角色的頁面要自洽：`garnish` 不承載文字、一頁 ≤ 1 條 `spine`、有 `edge` 就 ≥ 2 個 `node`、`label` 不少於 node 色塊（第 3b 節） |
| `roster.page-count`、`roster.page-type` | 頁數與每頁頁型跟 `plan/outline.md` 對得上（每種頁型有它的特徵字級） |
| `rhythm.breathing-cards` | breathing 頁的面板 ≤ 2 |
| `motion.transition`、`motion.enter` | `animation` 不是 `none` 時每頁有轉場；`full` 每頁至少一個進場效果、`minimal` 封面／要點／對照頁至少一個 |
| `taboo.thank-you`、`taboo.duplicate-cover`、`taboo.stroke` | 謝謝頁、重複封面、rect 的框線 |

**整份做完**：`validate` 整份 0 錯誤，`template list` 列得出「封面」「要點頁」等名稱。
