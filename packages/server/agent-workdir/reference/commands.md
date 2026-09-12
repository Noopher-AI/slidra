# `comotion` 命令參考

這份文件涵蓋 `comotion` CLI 目前註冊的每一個命令：名稱、參數、一句用途、一個範例。編輯規約只示範少數幾個命令（`text set`、`comment list`）的引號寫法作為格式範例，其餘命令一律查這裡。

參數寫法（引號、逗號分隔清單等）的完整規則見編輯規約【命令參數怎麼寫】一節，這裡不重複。`<presentation-id>` 一律是你唯一拿得到的簡報識別碼。

## asset import

**參數**：`<presentation-id>` `<source>`（本機檔案路徑，相對路徑相對於 CLI 行程的工作目錄解析；或 `http(s)://` URL）、`--as csv`（選填，宣告這是資料資產而非媒體）；或改給 `--svg '<SVG 圖>'` 與 `--name <檔名.svg>`（從命令列內容建立 SVG 資產，與 `<source>` 互斥，`--name` 只允許英數、底線、連字號，同名已存在會失敗）。
**用途**：把一張圖片／影片／音訊（或宣告 `--as csv` 時的一份資料表）匯入簡報的 `assets/` 目錄，或用 `--svg` 直接寫一張 SVG（例如背景圖配方）進去。
**範例**：`comotion asset import <presentation-id> --svg '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">…</svg>' --name bg-mesh.svg`

## cat

**參數**：`<presentation-id>` `<path>`。
**用途**：讀取某個虛擬路徑的完整內容，等同於直接讀檔的另一種方式。
**範例**：`comotion cat <presentation-id> slides/001.svg`

## chart axis set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `single|dual`、`--right <系列名稱>`（可重複，只在 `dual` 時指定哪些系列畫在右軸）。
**用途**：切換圖表的座標軸模式。
**範例**：`comotion chart axis set <presentation-id> slides/001.svg el-1 dual --right 營收`

## chart create

**參數**：`<presentation-id>` `<slide-path>`、`--type`、`--series`、`--categories`、`--palette`、`--x`、`--y`、`--width`、`--height`（皆選填）。
**用途**：在投影片上新增一個圖表元素。
**範例**：`comotion chart create <presentation-id> slides/001.svg --type bar --x 100 --y 100 --width 400 --height 300`

## chart data set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>`，資料來源三選一：`--categories <c1,c2,...>` 搭配一或多個 `--series 'name=v1,v2,...'`；或 `--csv <本機 CSV 檔案路徑>`；或 `--csv-asset <assets/ 下的 CSV 虛擬路徑>`。
**用途**：設定圖表的類別與數列資料。
**範例**：`comotion chart data set <presentation-id> slides/001.svg el-1 --categories Q1,Q2,Q3 --series '營收=100,120,140'`
> `--csv` 讀的是本機檔案系統路徑（非內嵌 CSV 文字），agent 無法寫檔，這個旗標實務上只有使用者或 CoMotion 本身用得到；agent 請一律用 `--categories`／`--series`。

## chart legend set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<legend>`。
**用途**：設定圖表圖例的顯示方式。
**範例**：`comotion chart legend set <presentation-id> slides/001.svg el-1 bottom`

## chart option set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<key>` `<value>`。
**用途**：設定圖表的單一自訂選項（鍵值對）。
**範例**：`comotion chart option set <presentation-id> slides/001.svg el-1 showGrid true`

## chart palette set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<palette>`、`--color 'name=#RRGGBB'`（可重複，覆寫個別系列顏色）。
**用途**：設定圖表的配色方案。
**範例**：`comotion chart palette set <presentation-id> slides/001.svg el-1 default --color '營收=#3366FF'`

## chart stack set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `on|off`。
**用途**：切換圖表是否堆疊顯示。
**範例**：`comotion chart stack set <presentation-id> slides/001.svg el-1 on`

## chart type set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<type>`。
**用途**：切換圖表類型（例如長條圖、折線圖）。
**範例**：`comotion chart type set <presentation-id> slides/001.svg el-1 line`

## comment add

**參數**：`<presentation-id>` `<slide-path>` `<target>`（元素識別碼或 `page`）`<text>`、`--author`（選填）。
**用途**：對某個元素或整頁新增一則留言。
**範例**：`comotion comment add <presentation-id> slides/001.svg page '這頁的標題要不要再大一點？'`

## comment delete

**參數**：`<presentation-id>` `<slide-path>` `<comment-id>`。
**用途**：刪除一則既有留言。
**範例**：`comotion comment delete <presentation-id> slides/001.svg c-1`

## comment edit

**參數**：`<presentation-id>` `<slide-path>` `<comment-id>` `<text>`。
**用途**：修改一則既有留言的內容。
**範例**：`comotion comment edit <presentation-id> slides/001.svg c-1 '已經改好了'`

## comment list

**參數**：`<presentation-id>` `[slide-path]`（省略則列出全部投影片的留言）。
**用途**：列出留言。
**範例**：`comotion comment list <presentation-id> slides/001.svg`

## convert

**參數**：`<presentation-id>`。
**用途**：把整份簡報轉換成目前的格式規範（全有或全無，沒有單張投影片或 dry-run 的形式）。
**範例**：`comotion convert <presentation-id>`
> 這個命令由使用者或 CoMotion 本身使用，agent 通常用不到。

## font import

**參數**：`<presentation-id>` `<來源路徑或 URL>`、`--family <家族名>`、`--license <授權>`、`--source <出處>`（三個旗標皆必填）、`--license-file <路徑或 URL>`（選填）。
**用途**：把一個字型檔內嵌進簡報，之後 `--font-family` 就能用這個家族名。家族名在一份簡報內不得重複；檔名取自家族名。
**範例**：`comotion font import <presentation-id> https://fonts.example.org/NotoSerifTC-Regular.otf --family 'Noto Serif TC' --license 'SIL Open Font License 1.1' --source 'https://fonts.google.com/noto/specimen/Noto+Serif+TC'`

## effect add

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）、`--family <enter|emphasis|exit|path|media>`、`--effect <效果名稱>`、`--start <on-click|with-previous|after-previous>`（選填）、`--duration`、`--delay`、`--d`、`--index`（皆選填）。
**用途**：對一或多個元素新增一個動畫效果。
**範例**：`comotion effect add <presentation-id> slides/001.svg el-1 --family enter --effect fade`

## effect list

**參數**：`<presentation-id>` `<slide-path>`。
**用途**：列出某張投影片上所有元素的效果（依播放順序）。
**範例**：`comotion effect list <presentation-id> slides/001.svg`

## effect move

**參數**：`<presentation-id>` `<slide-path>` `<index>`（1-based）`up|down`。
**用途**：調整某個效果項在播放順序中的位置。
**範例**：`comotion effect move <presentation-id> slides/001.svg 2 up`

## effect remove

**參數**：`<presentation-id>` `<slide-path>` `<indices>`（1-based，逗號分隔）。
**用途**：移除一或多個效果項。
**範例**：`comotion effect remove <presentation-id> slides/001.svg 1,3`

## effect set

**參數**：`<presentation-id>` `<slide-path>` `<index>`（1-based）、`--effect`、`--start`、`--duration`、`--delay`、`--d`（皆選填）。`--duration`／`--delay`／`--d` 單位是秒。
**用途**：修改一個既有效果項的參數。
**範例**：`comotion effect set <presentation-id> slides/001.svg 1 --duration 0.5`

## element align

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`<direction>`（`left|hcenter|right|top|vcenter|bottom`）。
**用途**：對齊多個元素。
**範例**：`comotion element align <presentation-id> slides/001.svg el-1,el-2 hcenter`

## element copy

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）。
**用途**：複製元素到剪貼簿（不刪除原element）。
**範例**：`comotion element copy <presentation-id> slides/001.svg el-1`

## element cut

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）。
**用途**：剪下元素到剪貼簿並從投影片移除。
**範例**：`comotion element cut <presentation-id> slides/001.svg el-1`

## element delete

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）。
**用途**：刪除一或多個元素。
**範例**：`comotion element delete <presentation-id> slides/001.svg el-1,el-2`

## element distribute

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`<axis>`（`horizontal|vertical`）。
**用途**：讓多個元素在指定軸向上均分間距。
**範例**：`comotion element distribute <presentation-id> slides/001.svg el-1,el-2,el-3 horizontal`

## element duplicate

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）、`--dx`、`--dy`（選填，預設 0）。
**用途**：就地複製一或多個元素，可指定偏移量。
**範例**：`comotion element duplicate <presentation-id> slides/001.svg el-1 --dx 20 --dy 20`

## element group

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）。
**用途**：把多個元素組成一個群組。
**範例**：`comotion element group <presentation-id> slides/001.svg el-1,el-2`

## element insert

**參數**：`<kind>`（`rect|ellipse|line|image|path|video|audio`）`<presentation-id>` `<slide-path>`、依 `kind` 而定的座標／樣式旗標（`--x`、`--y`、`--width`、`--height`、`--x1`、`--y1`、`--x2`、`--y2`、`--d`、`--fill`、`--stroke`、`--stroke-width`、`--href`、`--media`、`--embed`，皆選填）。
**用途**：新增一個形狀／圖片／影音元素。
**範例**：`comotion element insert rect <presentation-id> slides/001.svg --x 0 --y 0 --width 200 --height 100 --fill '#3366FF'`

## element lock

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）。
**用途**：鎖定元素，防止被移動或編輯。
**範例**：`comotion element lock <presentation-id> slides/001.svg el-1`

## element move

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`--dx <數值>` `--dy <數值>`、`--force`（選填）。
**用途**：平移一或多個元素。
**範例**：`comotion element move <presentation-id> slides/001.svg el-1 --dx 10 --dy 0`

## element name set

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`<name>`。
**用途**：設定元素給人看的顯示名稱（不影響識別碼）。
**範例**：`comotion element name set <presentation-id> slides/001.svg el-1 '標題文字'`

## element order

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`<direction>`（`front|back|up|down`）、`--force`（選填）。
**用途**：調整元素的堆疊順序（上下層）。
**範例**：`comotion element order <presentation-id> slides/001.svg el-1 front`

## element paste

**參數**：`<presentation-id>` `<slide-path>`、`--dx`、`--dy`（選填，預設 0）、`--svg-file`（選填，從指定 SVG 檔貼上而非剪貼簿）。
**用途**：從剪貼簿貼上先前複製或剪下的元素。
**範例**：`comotion element paste <presentation-id> slides/001.svg --dx 20 --dy 20`

## element resize

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`--width <數值>` `--height <數值>`、`--anchor <nw|ne|sw|se>`（選填，預設 `nw`）、`--force`（選填）。
**用途**：調整元素尺寸，依錨點縮放。
**範例**：`comotion element resize <presentation-id> slides/001.svg el-1 --width 300 --height 200`

## element rotate

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`--degrees <數值>`、`--force`（選填）。
**用途**：旋轉一或多個元素。
**範例**：`comotion element rotate <presentation-id> slides/001.svg el-1 --degrees 45`

## element scale

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`--factor <數值>`、`--force`（選填）。
**用途**：等比縮放一或多個元素。
**範例**：`comotion element scale <presentation-id> slides/001.svg el-1 --factor 1.5`

## element style set

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）`<attr>` `<value>`、`--force`（選填）。
**用途**：設定元素的一個 SVG 樣式屬性（走白名單，見 ADR-0014）。
**範例**：`comotion element style set <presentation-id> slides/001.svg el-1 fill '#FF0000'`

## element ungroup

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）。
**用途**：解散一個群組。
**範例**：`comotion element ungroup <presentation-id> slides/001.svg group-1`

## element unlock

**參數**：`<presentation-id>` `<slide-path>` `<element-ids>`（逗號分隔）。
**用途**：解除元素鎖定。
**範例**：`comotion element unlock <presentation-id> slides/001.svg el-1`

## ls

**參數**：`<presentation-id>` `[path]`（省略則列出頂層）。
**用途**：列出簡報裡的檔案（模仿 `ls`）。
**範例**：`comotion ls <presentation-id>`

## new

**參數**：`<path>`、`--name`（選填）。
**用途**：建立一份新的 `.comot` 簡報檔。
**範例**：`comotion new ./deck.comot --name 我的簡報`
> 這個命令由使用者或 CoMotion 本身使用，agent 通常用不到。

## open

**參數**：`<path>`。
**用途**：開啟一份既有的 `.comot` 簡報檔，取得後續命令要用的識別碼。
**範例**：`comotion open ./deck.comot`
> 這個命令由使用者或 CoMotion 本身使用，agent 通常用不到。

## pack

**參數**：`<presentation-id>` `<path>`。
**用途**：把已開啟的簡報打包回一份 `.comot` 檔。
**範例**：`comotion pack <presentation-id> ./deck.comot`
> 這個命令由使用者或 CoMotion 本身使用，agent 通常用不到。

## plan delete

**參數**：`<presentation-id>` `[outline|design-spec]`（省略則刪整個 `plan/`）。
**用途**：刪除計畫檔；不進 undo 歷史。
**範例**：`comotion plan delete <presentation-id> outline`

## plan list

**參數**：`<presentation-id>`。
**用途**：列出簡報現有的計畫檔（`plan/outline.md` 帶 `status`、`plan/design-spec.md`）。
**範例**：`comotion plan list <presentation-id>`

## plan set

**參數**：`<presentation-id>` `<name>`（`outline` 或 `design-spec`）`<content>`（檔案全文，開頭是一個 ```` ```json ```` 圍欄，其後接 markdown 正文）、`--force`（選填，只能接在 `<content>` 後面）。
**用途**：寫入 `plan/outline.md` 或 `plan/design-spec.md`；寫入前驗證 JSON 段的欄位，不合就拒絕。讀取用 `cat <presentation-id> plan/outline.md`。不進 undo 歷史。
計畫 `status` 已經是 `confirmed` 時，outline 有一份受保護的欄位：`mode`、`animation`、`background`、既有頁的 `relationship`／`rhythm`／`title`、不能刪頁，以及**已經畫出來的那一頁的 `blueprint`**；改這些要加 `--force`。第一次寫某頁的 `blueprint`、改還沒畫的頁、改 `type`、在最後面加頁都不受限。
**範例**：`comotion plan set <presentation-id> outline '<全文>'`

## presentation canvas set

**參數**：`<presentation-id>` `--width <數值>` `--height <數值>`。
**用途**：設定簡報畫布尺寸。
**範例**：`comotion presentation canvas set <presentation-id> --width 1920 --height 1080`

## redo

**參數**：`<presentation-id>`。
**用途**：重做上一個被復原的變更。
**範例**：`comotion redo <presentation-id>`

## slide add

**參數**：`<presentation-id>`、`--template <範本虛擬路徑>`（選填）、`--svg <整頁 SVG>`（選填，與 `--template` 互斥）、`--at <索引>`（選填，省略則加到最後）。
**用途**：新增一張投影片：空白頁、範本複製，或用 `--svg` 一次寫完整頁（帶 `data-comot-text-width` 的裸 `<text>` 會被轉成真正的文字框；`<defs>`、漸層、`path` 都可以寫；`<script>` 或重複 id 會被拒絕）。`--svg` 成功時 `data.elementIds` 列出每個頂層元素的識別碼。**`--svg` 有寫入閘門**：這一頁的幾何重疊／溢出、文字量、字級與配色、角色自洽、資產路徑、scrim 任何一條沒過就整頁拒收（回傳列出每一條），什麼都不會被寫進去；動畫、備忘稿、範本、`blueprint` 不在這裡擋。清單見 `slide-design.md` 第 0 節。
**範例**：`comotion slide add <presentation-id> --svg '<svg viewBox="0 0 1280 720" style="background-color:#101418"><text id="el-title" data-comot-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="#F4F6F8">標題</text></svg>'`

## slide set

**參數**：`<presentation-id>` `<slide-path>` `--svg <整頁 SVG>`。
**用途**：用一整頁 SVG 覆寫既有的投影片（或範本），ingest 規則同 `slide add --svg`；新 SVG 沒帶 `<metadata>` 時沿用舊頁的備忘稿、留言、效果與轉場。可 undo。
**範例**：`comotion slide set <presentation-id> slides/003.svg --svg '<svg viewBox="0 0 1280 720"><text data-comot-text-width="1120" x="80" y="72" font-size="40">改寫後的標題</text></svg>'`

## slide delete

**參數**：`<presentation-id>` `<slide-path>`。
**用途**：刪除一張投影片。
**範例**：`comotion slide delete <presentation-id> slides/002.svg`

## slide duplicate

**參數**：`<presentation-id>` `<slide-path>`。
**用途**：複製一張投影片，插在原投影片之後。
**範例**：`comotion slide duplicate <presentation-id> slides/001.svg`

## slide move

**參數**：`<presentation-id>` `<slide-path>` `<new-index>`。
**用途**：調整投影片在簡報中的順序。
**範例**：`comotion slide move <presentation-id> slides/003.svg 0`

## slide notes set

**參數**：`<presentation-id>` `<slide-path>` `<text>`。
**用途**：設定投影片的簡報者備忘稿（可為空字串以清空）。
**範例**：`comotion slide notes set <presentation-id> slides/001.svg '記得先自我介紹'`

## slide render

**參數**：`<presentation-id>` `<slide-path>`。
**用途**：把投影片轉成點陣圖供匯出或預覽使用。
**範例**：`comotion slide render <presentation-id> slides/001.svg`
> 這個命令由使用者或 CoMotion 本身使用，agent 通常用不到。

## slide background set

**參數**：`<presentation-id>` `<slide-path>`、`--asset <assets/檔名>`（既有資產）與 `--opacity <0～1>`（選填），或 `--none`。
**用途**：在該頁最底層放一張滿版、鎖定的背景圖（`id="el-background"`，`data-comot-role="background"`），再設一次就是替換；`--none` 移除。背景圖不加動畫效果。
**範例**：`comotion slide background set <presentation-id> slides/002.svg --asset assets/bg-mesh.svg --opacity 0.8`

## slide style set

**參數**：`<presentation-id>` `<slide-path>`、`--background`、`--accent`（至少擇一）。
**用途**：設定投影片的背景色或強調色。
**範例**：`comotion slide style set <presentation-id> slides/001.svg --background '#FFFFFF'`

## slide transition set

**參數**：`<presentation-id>` `<slide-path>`、`--enter`、`--exit`（`none|fade|slide|zoom`，選填）、`--enter-duration`、`--exit-duration`（選填，單位是秒）、`--all`（選填，至少指定一項）。
**用途**：設定投影片切換時的轉場動畫。
**範例**：`comotion slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3`

## table bind

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--source <資料來源>`、`--template-row`（選填）。
**用途**：把表格綁定到一個資料來源，之後可用 `table refresh` 同步。
**範例**：`comotion table bind <presentation-id> slides/001.svg el-1 --source assets/data/sales.csv`

## table cell copy

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--range <儲存格範圍>`。
**用途**：複製表格的一個儲存格範圍。
**範例**：`comotion table cell copy <presentation-id> slides/001.svg el-1 --range A1:B2`

## table cell cut

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--range <儲存格範圍>`。
**用途**：剪下表格的一個儲存格範圍。
**範例**：`comotion table cell cut <presentation-id> slides/001.svg el-1 --range A1:B2`

## table cell paste

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--at <目標儲存格>` `--tsv-file <TSV 檔虛擬路徑>`。
**用途**：把剪貼簿或指定 TSV 檔的內容貼到表格。
**範例**：`comotion table cell paste <presentation-id> slides/001.svg el-1 --at A1 --tsv-file assets/data/clip.tsv`

## table cell set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--row <數值>` `--col <數值>` `--text <文字>`。
**用途**：設定單一儲存格的文字內容。
**範例**：`comotion table cell set <presentation-id> slides/001.svg el-1 --row 0 --col 0 --text '總計'`

## table cell style set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--row` `--col`、`--row-end`、`--col-end`（選填，指定範圍）`<attr>` `<value>`。
**用途**：設定一個或一段儲存格範圍的樣式屬性。
**範例**：`comotion table cell style set <presentation-id> slides/001.svg el-1 --row 0 --col 0 fill '#EEEEEE'`

## table col delete

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--at <欄索引>`。
**用途**：刪除表格的一欄。
**範例**：`comotion table col delete <presentation-id> slides/001.svg el-1 --at 2`

## table col insert

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--at <欄索引>`。
**用途**：在指定位置插入一欄。
**範例**：`comotion table col insert <presentation-id> slides/001.svg el-1 --at 2`

## table col width

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--col <數值>` `--width <數值>`、`--keep-total`（選填）。
**用途**：設定某一欄的寬度。
**範例**：`comotion table col width <presentation-id> slides/001.svg el-1 --col 0 --width 120`

## table create

**參數**：`<presentation-id>` `<slide-path>` `--rows <數值>` `--cols <數值>` `--x <數值>` `--y <數值>`、`--col-width`、`--theme`、`--header <true|false>`（皆選填）。
**用途**：在投影片上新增一個表格。
**範例**：`comotion table create <presentation-id> slides/001.svg --rows 3 --cols 4 --x 100 --y 100`

## table header set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `true|false`。
**用途**：切換表格是否有標題列。
**範例**：`comotion table header set <presentation-id> slides/001.svg el-1 true`

## table merge

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--row <數值>` `--col <數值>`、`--row-span`、`--col-span`（選填）、`--unmerge`（選填）。
**用途**：合併（或取消合併）表格儲存格。
**範例**：`comotion table merge <presentation-id> slides/001.svg el-1 --row 0 --col 0 --row-span 1 --col-span 2`

## table refresh

**參數**：`<presentation-id>` `<slide-path>` `<element-id>`。
**用途**：用 `table bind` 綁定的資料來源重新整理表格內容。
**範例**：`comotion table refresh <presentation-id> slides/001.svg el-1`

## table row delete

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--at <列索引>`。
**用途**：刪除表格的一列。
**範例**：`comotion table row delete <presentation-id> slides/001.svg el-1 --at 2`

## table row insert

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--at <列索引>`。
**用途**：在指定位置插入一列。
**範例**：`comotion table row insert <presentation-id> slides/001.svg el-1 --at 2`

## table set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>`，資料來源三選一：`--from`、`--markdown`、`--markdown-file`。
**用途**：用 Markdown 表格（內嵌文字或檔案）整份覆寫表格內容。
**範例**：`comotion table set <presentation-id> slides/001.svg el-1 --markdown '| A | B |\n|---|---|\n| 1 | 2 |'`

## table theme set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<theme>`。合法值：`dark`、`light`、`zebra`。
**用途**：套用表格配色主題。
**範例**：`comotion table theme set <presentation-id> slides/001.svg el-1 zebra`

## template add

**參數**：`<presentation-id>`、`--from <來源投影片虛擬路徑>`、`--name`（皆選填）。
**用途**：把一張投影片存成可重複使用的範本。
**範例**：`comotion template add <presentation-id> --from slides/001.svg --name '標題頁'`

## template delete

**參數**：`<presentation-id>` `<template-path>`。
**用途**：刪除一個範本。
**範例**：`comotion template delete <presentation-id> templates/001.svg`

## template list

**參數**：`<presentation-id>`。
**用途**：列出簡報所有的範本。
**範例**：`comotion template list <presentation-id>`

## template rename

**參數**：`<presentation-id>` `<template-path>` `<new-name>`。
**用途**：重新命名一個範本。
**範例**：`comotion template rename <presentation-id> templates/001.svg '封面'`

## text list set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--paragraph <數值>` `--kind <bullet|number|none>`、`--force`（選填）。
**用途**：設定某一段文字的清單樣式（項目符號／編號／無）。
**範例**：`comotion text list set <presentation-id> slides/001.svg el-1 --paragraph 0 --kind bullet`

## text set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<new-text>`、`--force`（選填）。
**用途**：修改某個元素的文字內容。
**範例**：`comotion text set <presentation-id> slides/001.svg el-1 '第三季 財報'`

## text style set

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `--range <起點:終點>`、`--font-weight`、`--font-style`（至少擇一）、`--force`（選填）。
**用途**：設定一段文字範圍的字重或字型樣式。
**範例**：`comotion text style set <presentation-id> slides/001.svg el-1 --range 0:3 --font-weight 700`

## textbox add

**參數**：`<presentation-id>` `<slide-path>` `--x <數值>` `--y <數值>` `--width <數值>` `--text <文字>`、`--font-size`、`--font-family`、`--font-weight`、`--fill`、`--align <left|center|right>`（皆選填）。
**用途**：新增一個文字框。
**範例**：`comotion textbox add <presentation-id> slides/001.svg --x 100 --y 100 --width 400 --text '新的文字框'`

## textbox align

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<align>`（`left|center|right`）、`--force`（選填）。
**用途**：設定文字框內文字的對齊方式。
**範例**：`comotion textbox align <presentation-id> slides/001.svg el-1 center`

## textbox width

**參數**：`<presentation-id>` `<slide-path>` `<element-id>` `<width>`、`--force`（選填）。
**用途**：調整文字框的寬度。
**範例**：`comotion textbox width <presentation-id> slides/001.svg el-1 500`

## undo

**參數**：`<presentation-id>`。
**用途**：復原上一個變更。
**範例**：`comotion undo <presentation-id>`

## validate

**參數**：`<presentation-id>` `[slide-path]`（省略則驗整份）。
**用途**：用寫死的設計規則驗證投影片：文字量、一頁一個標題、溢出與重疊、字級與配色是否在 `plan/design-spec.md` 的表上、背景與備忘稿、頁數與頁型是否對得上 `plan/outline.md`、禁忌（謝謝頁、重複封面、框線）。`data.errors` 每項有 `slide`／`element`／`rule`／`actual`／`limit`／`message`；有錯誤時 exit code 是 1（非零代表有發現，不是故障）。沒有計畫檔時只驗幾何與骨架。
**範例**：`comotion validate <presentation-id>`
