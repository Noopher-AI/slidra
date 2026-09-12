# `.comot` 檔案格式規格

## 這份文件的地位

這份文件是 `.comot` 容器格式與 `~/.comotion/`（`COMOTION_HOME`）工作區佈局的唯一規範性文件。TypeScript 引擎已刪除（[E4.T12]）——Rust 是現在唯一的實作，本文件即它的唯一依據；`formatVersion` 4 與 1→4 遷移規則已由 Rust 版落地。

`docs/adr/` 記錄的是決策史（為什麼當初這樣選），本文件記錄的是目前與未來的結構性事實。兩者衝突時以本文件為準。

## 容器佈局

`.comot` 是一個 zip 檔，沒有壓縮層級的契約（現行實作用 `fflate` 的 `level: 6`，這是實作選擇，不是格式的一部分，Rust 版可以用任何壓縮層級或甚至不壓縮）。

必要目錄——`slides/`、`assets/`、`fonts/` 三個目錄即使沒有任何檔案也必須在 zip 裡有自己的 entry（即使是空目錄的 entry）。這三個目錄名稱固定，`打包`（`pack`）時保證存在，`解壓`（`open`）後也會補建缺少的目錄。

其他可能出現的位置：

- `templates/`：可選。範本（`template add` 產生）與 `slides/` 同構，一份 `.svg` 一個範本，檔名不強制格式（現行實作用流水號，例如 `templates/001.svg`）。
- `assets/data/`：`asset import --as csv` 的資料資產落點，與一般媒體共用 `assets/` 目錄但是子目錄，序號空間與 `assets/` 下的媒體檔互不干擾。

解壓安全規則（`unpack_container`，`crates/comotion/src/container.rs`）：**先全量驗證，再落地**。zip 裡的每一個 entry 路徑，只要是絕對路徑，或解析後會落在目標目錄之外（也就是含有能跳出目標目錄的 `..` 片段），整個壓縮檔就被拒收——不做部分解壓、不做路徑清洗、不嘗試修正。任何一步失敗（entry 路徑不合法、`project.json` 缺失或格式錯誤、`formatVersion` 太新），已經寫出的目標目錄會被整個刪除，不留下半成品。

## `project.json`

`.comot` 唯一的中繼資料檔，UTF-8 JSON，鍵值如下：

| 欄位 | 型別 | v3 必填性 | v4 必填性 | 驗證規則 |
|---|---|---|---|---|
| `formatVersion` | `number` | 必填 | 必填 | 必須是 `number`；型別錯誤即整份拒收。大於本版支援的最大值時拒絕開啟（見下方「`formatVersion`」一節） |
| `name` | `string` | 必填 | 必填 | 必須是 `string` |
| `canvas` | `{ width: number; height: number }` | 必填 | 必填 | 物件，`width`／`height` 兩個子欄位都必須是 `number` |
| `slides` | `string[]` | 必填 | 必填 | 必須是陣列，且每一項都是字串（虛擬路徑）；空陣列（`[]`）結構上合法——「還沒有投影片」是簡報可以合法存在的狀態 |
| `fonts` | `FontEntry[]` | **選填** | **必填**（v4 起，鍵必須存在；`[]` 合法） | 每個 `FontEntry` 是 `{ file, family, license, licenseFile, source }`，五個欄位都必須是 `string`；`file`／`licenseFile` 不得以 `/` 開頭、不得含 `..` 路徑片段；`family` 在陣列內不得重複 |
| `templates` | `(string \| TemplateEntry)[]` | 選填 | **必填為物件陣列**（v4 起不再接受裸字串，見下方「`formatVersion`」） | v3：裸字串與 `{ file, name }` 物件可以混在同一陣列（升級中途的合法狀態，不是錯誤）；`file` 同樣禁絕對路徑與 `..`；`name` 若為物件形式必須是字串 |
| `transition` | `string` | 選填（LEGACY） | **不得出現** | 只有 v2 以下的檔案會有這個欄位；`formatVersion` 2→3 遷移時讀取後刪除；v4 起這個鍵出現即為格式錯誤 |

`TemplateEntry` = `{ file: string; name: string }`（`file` 是容器內虛擬路徑，`name` 是使用者看到的顯示名稱，允許重複）。

`FontEntry` = `{ file: string; family: string; license: string; licenseFile: string; source: string }`（見「`fonts/`」一節）。

**未知欄位一律保留、不拒絕**（前向相容；一個較舊的實作打開一份較新版本寫出、帶有它看不懂欄位的 `project.json` 時，不因為多出的欄位而報錯）。

**寫出格式凍結**：`JSON.stringify(value, null, 2) + "\n"`，即 2 空格縮排、檔尾恰好一個換行；鍵的原始順序保留（Rust 版用 `serde_json` 的 `preserve_order` feature + 2 空格縮排即可位元相容）。

## `slides/` 與 `templates/`

每個 `.svg` 檔本身就是成品，不是要再轉檔的中間格式（ADR-0001）。可編輯的圖元包在 `<g id="el-…" data-comot-name="…">` 容器裡（ADR-0012）；裸圖元（沒有 `<g>` 包住的 `<text>` 等）視為不合規。

- **元素 id 格式**：`el-` 前綴 + 12 個字元的 base64url（`generateOpaqueId()`：9 個隨機位元組 base64url 編碼後恰好 12 字元；`generateElementId()` 再加上 `el-` 前綴）。純亂數產生，id 本身不可解碼出任何路徑或語意（ADR-0004）。
- **容器的兩個已知例外**（ADR-0012 amendment）：圖表容器與表格容器不是「包一或多個圖元的 `<g>`」，而是各自的資料元素 + 渲染結果組合，細節見下方「圖表容器」與「表格容器」兩節。

`data-comot-*` 屬性總表（目前 repo 內實際出現的完整集合，`grep -rhoP 'data-comot-[a-zA-Z-]+' crates/comotion/src`）：

| 屬性 | 用在哪裡 | 意義 |
|---|---|---|
| `data-comot-name` | 每個元素容器 `<g>` | 使用者可見的顯示名稱（`element name set`），不影響 id |
| `data-comot-type` | 圖表／表格容器 `<g>` | 標記容器走哪一種例外形狀，目前值有 `chart`、`table` |
| `data-comot-lock` | 元素容器 `<g>` | 鎖定狀態（`element lock`／`unlock`）；`--force` 可繞過鎖定寫入 |
| `data-comot-clipboard` | 內部使用 | 剪貼簿序列化交換格式的標記屬性 |
| `data-comot-media` | 媒體元素（image／video／audio） | 標記元素攜帶的媒體種類 |
| `data-comot-embed` | 媒體元素 | 是否內嵌（依 `element insert` 的 `--embed`） |
| `data-comot-source` | 內部使用 | 追蹤某內容片段的來源標記 |
| `data-comot-list` | 段落 `<tspan>`／文字節點 | 清單樣式（`text list set`）：`bullet`／`number`／`none` |
| `data-comot-list-marker` | 清單項目 | 該項目實際渲染出的標記文字（例如 `•`、`1.`） |
| `data-comot-text-align` / `data-comot-text-width` / `data-comot-text-height` | 文字框 | 文字框排版計算的快取／標記屬性 |
| `data-comot-break` | `<tspan>` | 標記這個 tspan 後面是一個「硬換行」（原文有 `\n`），與軟換行（單純換行顯示但原文無 `\n`）區分 |
| `data-comot-type="table"`、`data-comot-cols`、`data-comot-rows`、`data-comot-header`、`data-comot-theme` | 表格容器 `<g>` | 見下方「表格容器」 |
| `data-comot-cell`、`data-comot-span`、`data-comot-repeat`、`data-comot-generated`、`data-comot-align` | 表格儲存格 `<g>` | 見下方「表格容器」 |

（此表以目前程式碼實際使用到的屬性為準，逐項精確驗證規則以對應的 `crates/comotion/src` 模組——`element/text.rs`、`element/edit.rs`、`table/model.rs`、`chart/model.rs`——為權威來源；本表是總覽，不是每個屬性驗證規則的完整重述。）

### 背景圖元素（#303 §13）

一張投影片最多有一個頂層容器帶 `data-comot-role="background"`：固定 `id="el-background"`、`data-comot-name="背景圖"`、`data-comot-lock="true"`，內容是一個滿版的 `<image href="../assets/…" x="0" y="0" width="畫布寬" height="畫布高" [opacity]>`，位置在 `<metadata>` 之後、所有其他元素之前（最底層）。由 `slide background set` 寫入／替換／移除；`slide add --svg`／`slide set --svg` 的內容若已含這個容器，原樣保留並補鎖。`validate` 不對它套用任何幾何、樣式、禁忌規則，只用它的存在決定是否檢查 `structure.scrim`。

## `<metadata>` 內的 `comot:*`

**只有下面這 6 種標籤活在 `<svg>` 的 `<metadata>` 子節點裡**：`comot:effects`（包 `comot:effect`）、`comot:transition`、`comot:notes`、`comot:comments`（包 `comot:comment`）。命名空間 URI 統一為 `https://co-motion.dev/ns`（`EFFECTS_NS` 常數，`NOTES_NS`／`TRANSITION_NS`／`COMMENTS_NS` 皆取同一個字面值）。

> 圖表的 `<comot:chart>`（包 `comot:series`、`comot:categories`）與表格的 `<comot:source>`，雖然也叫 `comot:*`、也用同一個命名空間，**並不在 `<metadata>` 裡**，而是分別直接掛在圖表／表格自己的 `<g>` 容器底下（ADR-0012 amendment 的例外形狀）。這點容易被誤讀成十種標籤都在 `<metadata>` 底下，實際上不是——見下面「圖表容器」與「表格容器」兩節。

### `<comot:effects>` / `<comot:effect>`

```xml
<metadata>
  <comot:effects xmlns:comot="https://co-motion.dev/ns">
    <comot:effect target="el-p5-b" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>
  </comot:effects>
</metadata>
```

`comot:effect` 屬性表：

| 屬性 | 型別／值域 | 必填性 |
|---|---|---|
| `target` | 字串，指向同一張投影片內某元素（或群組 `<g>`）的 id | 必填 |
| `family` | `enter \| emphasis \| exit \| path \| media` | 必填 |
| `effect` | 依 `family` 而定的固定清單：`enter` → `appear \| fade \| fly-up \| fly-left \| zoom`；`emphasis` → `pulse \| spin \| grow`；`exit` → `disappear \| fade-out \| zoom-out`；`path` → `path`；`media` → `play \| pause` | 必填 |
| `start` | `on-click \| with-previous \| after-previous` | 必填 |
| `duration` | 非負秒數 | 選填，缺席時 `media` family 預設 `0`，其餘 family 預設 `0.6` |
| `delay` | 非負秒數 | 選填，缺席時預設 `0` |
| `d` | SVG path 語法字串 | 只有 `family="path"` 時才有意義；只要 XML 上有這個屬性就逐字保留，不驗證、不使用其值（即使出現在其他 family 上也一樣保留） |

`duration`／`delay` 屬性**存在但為空字串**（例如 `duration=""`）視為非法秒數；屬性**缺席**才取預設值——這是兩件不同的事。清單裡第一項的 `start` 必須是 `on-click`，否則視為簡報已損毀。

### `<comot:transition>`

```xml
<metadata>
  <comot:transition xmlns:comot="https://co-motion.dev/ns"
                     enter="fade" enter-duration="0.3" exit="none" exit-duration="0.5"/>
</metadata>
```

一張投影片的 `<metadata>` 內最多一組 `<comot:transition>`；出現兩組以上視為簡報已損毀。屬性：`enter`／`exit` ∈ `none | fade | slide | zoom`；`enter-duration`／`exit-duration` 為非負秒數。**缺席時的預設值**（沒有 `<comot:transition>` 元素，或元素存在但個別屬性缺席）：`enter: { effect: "none", duration: 0.6 }`、`exit: { effect: "none", duration: 0.5 }`。

### `<comot:notes>`

```xml
<metadata>
  <comot:notes xmlns:comot="https://co-motion.dev/ns">記得先自我介紹</comot:notes>
</metadata>
```

純文字內容（XML 轉義），空字串是清空備忘稿的合法寫法（不是省略元素）。

### `<comot:comments>` / `<comot:comment>`

```xml
<metadata>
  <comot:comments xmlns:comot="https://co-motion.dev/ns">
    <comot:comment id="c-01" target="el-p1-title" author="作者" created="2026-09-01T00:00:00.000Z">這頁的標題要不要再大一點？</comot:comment>
  </comot:comments>
</metadata>
```

`comot:comment` 屬性：`id`（不透明字串）、`target`（元素 id 或字面值 `page` 代表整頁）、`author`（選填）、`created`（ISO 8601 時間戳，寫入時產生，之後不再變動——`comment edit` 只改內容不改 `created`）。內容是留言文字本身。

## 圖表容器

ADR-0012 amendment 的第一個例外形狀：一個 `data-comot-type="chart"` 容器裡恰好一個 `<comot:chart>`（資料）加一個內嵌的渲染結果 `<svg>`（畫面），不是「一或多個圖元」。

```xml
<g id="el-chart1" data-comot-type="chart" transform="translate(691.2 115.2)">
  <comot:chart xmlns:comot="https://co-motion.dev/ns"
               type="bar" stacked="false" axes="single" palette="brand"
               legend="bottom" grid="true" labels="true"
               x-title="" y-title="" width="480" height="320">
    <comot:series name="營收" values="100,120,140" axis="left"/>
    <comot:categories values="Q1,Q2,Q3"/>
  </comot:chart>
  <svg width="480" height="320" viewBox="0 0 480 320">...</svg>
</g>
```

`<comot:chart>` 屬性：`type` ∈ `bar|hbar|line|area|pie|donut`；`stacked` ∈ `true|false`（字面字串，只有 `bar|hbar|area` 三種類型的堆疊才有實質效果）；`axes` ∈ `single|dual`；`palette` ∈ `brand|cool|warm`；`legend` ∈ `none|bottom|right`；`grid`／`labels` ∈ `true|false`；`x-title`／`y-title` 為字串（缺席視為空字串）；`width`／`height` 為正數，必填。子節點：一或多個 `<comot:series>`（`name` 字串、`values` 逗號分隔數字列、`axis` ∈ `left|right`、`color` 選填 `#RRGGBB`）；恰好一個 `<comot:categories>`（`values` 逗號分隔字串列）。`<comot:chart>` 不貢獻 `getBBox()`；元素的邊界框只由內嵌 `<svg>` 的 `width`/`height` 決定，渲染結果只由 `chart` 命令族重畫產生，其他命令（`element style set` 等）一律拒絕直接碰觸這個容器內部。

## 表格容器

ADR-0012 amendment 的第二個例外形狀：一個 `data-comot-type="table"` 容器包一個可選的 `<comot:source>`（資料綁定宣告）加多個 `<g data-comot-cell="r,c">` 儲存格——**沒有專屬的 `<comot:table>` 元素**。

```xml
<g id="el-t1" data-comot-type="table" data-comot-cols="200 300 240"
   data-comot-rows="44 40" data-comot-header="1" data-comot-theme="dark"
   transform="translate(x y)">
  <comot:source xmlns:comot="https://co-motion.dev/ns" src="assets/data/sales.csv"/>
  <g data-comot-cell="0,0" transform="translate(0 0)">
    <rect x="0" y="0" width="200" height="44" fill="#EEEEEE"/>
    <text x="8" y="28" fill="#000000" font-weight="700"><tspan>總計</tspan></text>
  </g>
  ...
</g>
```

容器屬性：`data-comot-cols`／`data-comot-rows` 為以空白分隔的正數列（欄寬／列高，使用者單位）；`data-comot-header` = `"1"` 代表有標題列；`data-comot-theme` ∈ `dark|light|zebra`（缺席時預設 `dark`）。`<comot:source>` 選填，出現時 `src` 是 `assets/` 下 CSV 檔的虛擬路徑（`table bind` 綁定的來源，`table refresh` 讀它重新整理）；一個表格容器最多一個 `<comot:source>`。

儲存格 `<g data-comot-cell="row,col">`：`row`/`col` 0-based；`data-comot-span="rowSpan,colSpan"` 選填（缺席等同 `1,1`）；`data-comot-repeat="row"` 標記這是綁定表格的模板列（永遠搭配 `display="none"`，一個表格最多一列是模板列）；`data-comot-generated="1"` 標記這格內容是 `table bind`/`table refresh` 從 CSV 自動產生；`data-comot-align` ∈ `left|center|right`（缺席預設 `left`）。文字內容在 `<text><tspan>...</tspan></text>` 裡；儲存格底色是 `<rect>` 的 `fill`（`none` 或 `#RRGGBB`）與可選 `fill-opacity`（0 到 1）；文字顏色是 `<text>` 的 `fill`（必須是 `#RRGGBB`）；字重是 `<text>` 的 `font-weight`（100 到 900 的整百）。**表格網格必須被儲存格完整覆蓋，不得有洞，合併範圍不得重疊**（`validateTableModel` 的結構不變式）。

## `plan/`

`plan/` 是簡報自己的計畫檔目錄（#303，ADR-0018），固定兩個檔名：`plan/outline.md`（狀態 `status: draft|confirmed`、敘事模式、逐頁 `pages`、要問作者的 `questions`、選填的 `animation`）與 `plan/design-spec.md`（`density`、六角色 `palette`、`type_scale`、選填的 `visual`）。每份檔案以一個 ```` ```json ```` 圍欄開頭——那是機器可讀段，`plan set` 寫入前解析並驗欄位——其後是給人與 agent 看的 markdown 正文。只能經 `plan set|list|delete` 寫、經 `cat` 讀；計畫不是投影片內容，不進 undo 歷史。目錄可以不存在。

### 文字框宣告不是儲存格式

`slide add --svg`／`slide set --svg` 接受一種**輸入形式**：直接放在根 `<svg>` 底下、帶 `data-comot-text-width` 的裸 `<text>`（內容以換行分段，可帶 `data-comot-list`、`data-comot-text-align`）。寫入時它一律被換成 `slides/` 一節描述的真正文字框結構（`<g data-comot-text-width data-comot-text-height transform>` 包 `<text>` 與 `<tspan>`）；`.comot` 裡永遠不會存到一個帶 `data-comot-text-width` 的裸 `<text>`。

## `fonts/`

`project.json.fonts` 登記這份簡報內嵌了哪些字型，`FontEntry` 五欄位：`file`（容器內相對路徑，例如 `fonts/NotoSansTC-Presentation.ttf`，不得以 `/` 開頭或含 `..`）、`family`（SVG `font-family` 引用值，這份簡報裡的唯一鍵，不得重複）、`license`（人類可讀授權名稱）、`licenseFile`（授權全文的容器內相對路徑）、`source`（字型取得來源）。同一顆字型被多張投影片引用時共用同一筆 `FontEntry`，不重複打包字型檔本體；SVG 內只存 `font-family` 字串引用。

**單獨開啟一張 SVG 時的降級**（ADR-0016 決定二）：`@font-face` 只在 CoMotion 自己的 wrapper 文件內透過內部路由注入；被外部工具（瀏覽器直接開檔、Illustrator 等）開啟時，`font-family` 依 CSS 字型堆疊規則的效果就是降級成該環境的系統字型——畫面不會壞，但不保證與 CoMotion 內看到的逐像素一致。這是刻意決定，不是缺陷：把字型 base64 內嵌進每張 SVG 的 `@font-face` 會讓一份 N 頁簡報的字型儲存成本變成 N 倍。

## `formatVersion`

`FORMAT_VERSION`（`crates/comotion/src/presentation.rs`）是 **4**，本規格定案的值。`formatVersion` 大於目前建置支援的最大值時整份拒絕開啟。

**v4 只改三項**（不得增減）：

| # | 變更 | v3 | v4 |
|---|---|---|---|
| 1 | `templates` | 接受裸字串或 `{ file, name }` 混用 | **只接受 `{ file, name }` 物件**；出現裸字串即為格式錯誤 |
| 2 | `transition` | 選填 LEGACY 欄位 | **不得出現**；出現即為格式錯誤 |
| 3 | `fonts` | 選填 | **必填**（鍵必須存在；`[]` 是合法值） |

**`fonts` 必填的精確語意**：`project.json` 裡必須有 `fonts` 這個鍵；它的值可以是空陣列 `[]`——這代表「這份簡報沒有內嵌任何字型」，是合法狀態，不是缺欄位。**3→4 遷移時，`fonts` 缺席一律補 `fonts: []`，絕不合成任何字型項目、絕不往容器裡複製任何字型檔。** 理由：`fonts` 的語意是「這個容器裡實際內嵌了哪些字型檔」，硬塞一筆不存在的字型項目等於宣告容器裡有一個實際不存在的檔案；沒有字型的簡報，走 ADR-0016 決定二的降級路徑（單獨開啟時系統字型）即可，這正是那個降級路徑存在的理由。

**完整遷移鏈**（單向，不提供降版；在 `open` 時一次跑完 1→2→3→4，不是惰性、不分批跑）：

| 版本 | 動作 | 觸發時機 |
|---|---|---|
| 1→2 | `templates` 陣列裡的裸字串項升級成 `{ file, name }`，`name` 取檔名去掉副檔名（basename 去 `.svg`） | v4 起改為在 `open` 時**實體**升級並落地（現行 TypeScript 版本是讀取時正規化、下次寫入才落地——v4 起因為裸字串不再合法，必須在 open 當下就落地，不能等下一次寫入） |
| 2→3 | 讀取 `project.json.transition`：若值恰為字面字串 `"fade"`，為每一張**還沒有** `<comot:transition>` 的投影片寫入 `enter: { effect: "fade", duration: 0.4 }`、`exit: { effect: "none", duration: 0.5 }`（保留舊版「整份淡入」的視覺效果）；其他任何值（`undefined`、`"none"`、`""`、未知字串）一律不遷移、不寫入任何東西。動作完成後刪除 `transition` 欄位，`formatVersion` 改為 3 | `open`（`unpackContainer` 內，每次開啟都跑一次，遷移只在 `formatVersion < 3` 時發生） |
| 3→4 | `fonts` 缺席時補 `fonts: []`；`templates` 若仍含裸字串則升級為物件（1→2 沒處理到的防禦性補漏）；確認 `transition` 欄位已不存在（1→2→3 應已清除，此處是防禦） | `open` |

**repo 現況**（供 Rust 開發時測試 fixture 參考）：目前 27 份 `project.json` fixture 全部是 `formatVersion: 1`；其中 24 份沒有 `fonts` 欄位（3→4 遷移的 `fonts: []` 補值路徑會覆蓋這 24 份）；只有一份有 `templates` 且已是物件形狀；**沒有任何一份帶有 `transition` 欄位**——也就是說 2→3 遷移的 `"fade"` 分支在現有 repo fixture 裡完全沒有被覆蓋到，Rust 實作 3→4 遷移鏈時，需要自己造一份帶 `transition: "fade"` 且投影片沒有 `<comot:transition>` 的測試檔，才能驗到這條分支。

## `~/.comotion/`（`COMOTION_HOME`）

`resolveCoMotionHome()` 的解析規則：`process.env.COMOTION_HOME` 若設定就用它，否則預設 `~/.comotion`；**每次呼叫都重新讀取環境變數，不快取**（測試可以把它指到臨時目錄）。

```
<COMOTION_HOME>/
├── projects.json              # 登記檔
├── work/<id>/                 # 解壓後的工作目錄（= .comot 的內容）
├── history/<id>/
│   ├── stack.json
│   └── snapshots/<snapshotId> # 原始位元組，不做任何編碼轉換
└── clipboard/<id>.json        # 每個 id 一份，「只能在同一份簡報內貼上」的機制本身
```

四個位置缺一不可地列在這裡：`projects.json`、`work/<id>/`、`history/<id>/`、`clipboard/<id>.json`。

### `projects.json`

登記檔，鍵是不透明 presentation id，值是 `RegistryEntry`：

```ts
interface RegistryEntry {
  workDir: string;       // 對應 work/<id>/ 的實際路徑
  sourcePath?: string;   // open 或「就地重開」最後讀取的 .comot 路徑；較舊的登記項可能沒有這欄
  savedAt?: number;      // work 目錄的 mtime 快照讀數，不是 Date.now()——見下方說明
}
```

`savedAt` 刻意不是 `Date.now()` 時間戳：比較兩個不同時鐘來源（`Date.now()` 與檔案系統 `mtime`）在某些檔案系統上會因為解析度不同而誤判，這裡改成用同一個 `stat`-based 量測方式前後比較，消除跨時鐘誤差。

寫入方式：整份序列化後先寫到同目錄下的暫存檔（`.projects.json.<12 hex>.tmp`），成功後 `rename` 覆蓋正式檔——`rename` 在同一個檔案系統上是原子操作，寫入中途失敗或磁碟滿了都不會讓 `projects.json` 停在半寫入狀態。只有「檔案不存在」（ENOENT）視為「登記檔還是空的」，其他任何讀取失敗（JSON 損毀、權限錯誤、任何 I/O 錯誤）都是明確報錯，不會靜默當成空登記——那會讓所有已開啟過的簡報一夕之間全部找不到。

### `history/<id>/stack.json`

```jsonc
{
  "undo": [ { "groupId": "…", "entries": [ { "virtualPath": "slides/001.svg", "snapshotId": "…" } ] } ],
  "redo": [ /* 同上結構 */ ],
  "openGroup": null            // 或一個 HistoryGroup（尚未提交的進行中群組）
}
```

三個頂層鍵固定：`undo`、`redo`、`openGroup`——缺任何一個都視為檔案已損毀（只有「檔案不存在」讀成空堆疊）。`HistoryGroup` = `{ groupId: string; entries: HistoryEntry[] }`；`HistoryEntry` = `{ virtualPath: string; snapshotId: string | null }`。`snapshotId` 為 `null` 代表這筆 entry 記錄的是該路徑的**建立**（例如匯入的新素材），undo 時的動作是**刪除該檔案**，而不是還原成某個舊內容，因為建立之前這個路徑根本不存在。`snapshotId` 非 null 時，其值是 `generateOpaqueId()` 產生的識別碼（同一個產生器，恰好 12 字元 base64url），對應 `history/<id>/snapshots/<snapshotId>` 底下的一份原始位元組快照。

寫入方式與 `projects.json` 相同：temp 檔 + `rename` 原子寫入，內容是 `JSON.stringify(stack, null, 2) + "\n"`。讀取時做完整結構驗證，只有 ENOENT 視為空堆疊，其他任何情況（JSON 損毀、缺鍵、型別不對、I/O 錯誤）一律視為「復原歷史已損毀」並報錯，不嘗試部分讀取或修復。

`UNDO_STACK_CAP = 50`：undo 堆疊超過 50 個 group 時，丟棄最舊的一個 group，並刪除它引用的所有 snapshot 檔案，避免無上限增長（沒有「關閉簡報」的動作可以觸發清理，所以這個上限是唯一的止血機制）。

### `clipboard/<id>.json`

每個 presentation id 一份獨立檔案，位置在 `work/<id>/` 之外（打包 `.comot` 時絕不會把剪貼簿內容一起打包進去）。這個「一個 id 一份檔案」的檔案佈局，本身就是「只能在同一份簡報內貼上」規則的完整實作機制——沒有額外的檢查程式碼，貼上時就是讀這個檔案，讀不到就是沒有東西可貼。

## 已知待改（本規格不修，逐條寫明現況與原因）

這些是目前程式碼裡已知但刻意先不修的既有狀態，Rust 版**維持現況**，不在本次規格內修正：

- **`xmlns:comot` 是逐區塊宣告，不是在 `<svg>` 根宣告一次。** 每一個 `comot:*` 根區塊（`<comot:effects>`、`<comot:transition>`、`<comot:notes>`、`<comot:comments>`、`<comot:chart>`、`<comot:source>`）各自帶自己的 `xmlns:comot="https://co-motion.dev/ns"` 宣告，而不是共用 `<svg>` 根元素上宣告一次的版本。
- **一份 SVG 可以有多個 `<metadata>` 區塊。** 目前的讀寫邏輯允許這種情況並且能正確處理，但這不是刻意設計出的規範，只是現況。
- **歷史遺留的命名空間錯誤會被就地修正。** 舊版 `element-clipboard.ts` 的貼上路徑曾經寫出錯誤的 `xmlns:comot="https://schemas.comotion.app/effects"`（正確值應為 `https://co-motion.dev/ns`）；讀取端（`effects/edit.ts` 的 `withCorrectedNamespace`）偵測到這個錯誤值或缺席時會就地改寫成正確值。這個修正邏輯保留，因為歷史檔案可能還帶著這個錯誤命名空間。
