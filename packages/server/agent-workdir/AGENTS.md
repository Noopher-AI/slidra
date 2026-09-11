# CoMotion Agent 工作手冊

這份文件鋪設在你（agent）的工作目錄裡，是穩定不變的長期指引——不像每次對話開頭收到的編輯規約，這份文件不需要每輪對話重講一次，你可以隨時用原生的檔案讀取能力回來查。

每次啟動 `co-motion serve` 都會用套件內建的版本整個重鋪這個工作目錄；你在這裡做的任何改動都不會被保留，也不應該嘗試在這裡留筆記給自己或使用者。

## CoMotion 是什麼

CoMotion 是一個簡報編輯工具。作者在瀏覽器裡的圖形編輯器操作簡報，你（agent）用 `co-motion` 命令操作同一份簡報——兩邊改的是同一個檔案，不是各自的副本。一份簡報的每一張投影片都是一份合法的 SVG，SVG 本身就是成品，不是拿去轉檔的中間產物；除了 SVG 之外，沒有更權威的表示法在它背後。

## 環境與限制

- 你只能執行 `co-motion` 開頭的命令，其他任何 shell 命令（包含 `grep`、`jq`、管線、`&&`、`;`）都會被直接拒絕執行，不會詢問作者。
- 你不能直接寫入任何檔案；嘗試寫檔一律被拒絕，錯誤訊息會告訴你該改用哪個 `co-motion` 命令。
- 你只拿得到這份簡報的識別碼，永遠拿不到它在這台機器上的真實路徑，也不需要用到路徑——每個 `co-motion` 命令的第一個參數都是這個識別碼。
- 命令的每個參數只能是「裸 token」（英數字與 `_ . / : = , @ + -`，或任何非 ASCII 文字）或「單引號字串」`'...'` 兩種寫法之一。色碼一定要用單引號（`'#3366FF'`，`#` 不在裸 token 允許的符號裡）。絕對不要使用雙引號或反斜線，一律會被拒絕。
- 含有半形單引號 `'` 的文字，命令列完全表達不出來——不要靜默丟棄或改寫成別的字，要在對話裡告訴作者這段文字打不進去，請他換一種寫法。

## 命令參考

編輯規約只示範少數幾個命令的語法。`co-motion` 完整的命令清單——每個命令的名稱、參數與一句用途——在 [`reference/commands.md`](reference/commands.md)。動手前先查那份參考，不要用編輯規約裡的少數範例去猜其他命令的語法。

版面、字級、配色與各種頁型的座標一律依 [`reference/slide-design.md`](reference/slide-design.md)，敘事模式與節奏依 [`reference/modes.md`](reference/modes.md)，可匯入的開源字型依 [`reference/fonts.md`](reference/fonts.md)；`comotion-plan`、`comotion-build`、`comotion-new-slide` 都會指到它們。設計規則的驗證交給 `co-motion validate` 命令，不要自己心算。

## 虛擬檔案結構

一份簡報是這樣的一組虛擬路徑，你只能用 `co-motion` 命令讀寫它們：

- `project.json`：簡報的中繼資料（名稱、畫布尺寸、投影片清單）。
- `slides/00N.svg`：每一頁投影片，索引從 1 開始，檔名補零到三位（第 2 頁是 `slides/002.svg`）。
- `assets/`：匯入的圖片、影片、音訊等媒體檔案。你不能寫檔，但可以用 `asset import <id> --svg '<SVG 圖>' --name <檔名>.svg` 從命令列內容直接建立一張 SVG 資產（背景圖就是這樣來的），再用 `slide background set <id> <slide-path> --asset assets/<檔名>.svg` 把它以鎖定的滿版圖片放在該頁最底層；配方與 scrim 規則見 `reference/slide-design.md` 的「背景圖」一節。
- `fonts/`：簡報內嵌的字型檔案。
- `templates/00N.svg`：`template add` 存下來的可重複使用範本；範本路徑一律用 `template list` 回傳的 `file` 欄位，不要用範本名稱自己拼路徑（名稱與檔名不是同一件事）。
- `slides/00N.svg` 可以整頁寫入：`slide add --svg '<整頁 SVG>'` 建新頁、`slide set <slide-path> --svg '<整頁 SVG>'` 整頁覆寫；寫入時會正規化、拒絕 `<script>`／`<foreignObject>`，並把帶 `data-comot-text-width` 的裸 `<text>`（文字框宣告，內容直接換行分段）轉成真正的文字框——文字一定要走這個宣告才能就地編輯、加清單、被 `validate` 驗到。版面規範見 `reference/slide-design.md`。
- `plan/outline.md`、`plan/design-spec.md`：這份簡報的逐頁計畫與設計規格，固定就這兩個檔名。檔案開頭是一個 ```` ```json ```` 圍欄（機器可讀：狀態、模式、每頁的頁型與節奏、確認題目；配色、密度、字級表），其後是 markdown 正文。只能用 `plan set` 寫、`cat` 讀、`plan delete` 刪；`validate` 與確認視窗都讀它。

## SVG 約定重點

- 每一個可編輯的圖元都包在 `<g id="el-…" data-comot-name="…">` 容器裡；裸圖元（沒有 `<g>` 包住的 `<text>` 等）會被大多數命令拒絕，並要求先跑 `convert`。
- 元素識別碼一律是 `co-motion` 產生的，不要自己猜或編——動手前先 `cat` 那一頁把 id 讀出來。
- 備忘稿存在 `<metadata><comot:notes>` 裡，只能用 `cat` 讀，沒有專門的讀取命令。
- 留言存在 `<metadata><comot:comments>` 裡，`comment list` 讀、`comment add` 寫、`comment delete` 刪。
- 動畫效果存在 `<metadata><comot:effects>` 裡，效果的排列順序就是播放順序。`effect list` 在這張投影片沒有任何效果時結束碼是非零——這代表「沒有動畫」，不是錯誤，不要重試也不要當成故障回報。

## 工作慣例

- 改動任何一頁之前，先 `co-motion cat <presentation-id> slides/00N.svg` 讀一次目前的內容，不要憑記憶或猜測下手。
- 你這一輪回覆裡下的所有命令，會被合併成作者按一次 undo 就能整段復原的一個群組——所以一個要求要在同一輪做完，不要拆成好幾輪回覆；也不要把 `undo`／`redo` 拿來試錯，那動到的是與作者共用的同一條歷史。
- 每做完一個動作，用固定格式回報：頁碼、動到的元素、做了什麼。
- 留言處理完就 `comment delete` 刪掉；做不到的留言保留原文，不要刪，並在對話裡就那一則提問。
- 不要猜識別碼、不要自己拼路徑——都從 `co-motion` 的回傳或 `cat` 的結果讀出來。
- 一次只做一頁，做完確認過再做下一頁；使用者一次要求做多頁時，中途出錯才知道停在哪裡。
- 同一份簡報上的 `co-motion` 命令由 CLI 自己排隊執行（每個命令持有這份簡報的鎖直到結束），所以你平行下多條命令是安全的，只是它們會一條接一條跑，不會比較快；一次一條、看完結果再下下一條，出錯時才知道是哪一條。

## Skills

下面每一個 skill 的完整步驟，都放在你工作目錄的 `.agents/skills/<名稱>/SKILL.md`（Claude Code 讀的是同一份內容的 `.claude/skills/<名稱>/SKILL.md`）。
每個 skill 的名稱都以 `comotion-` 開頭，目錄名、`SKILL.md` 的 `name`、作者打的斜線命令三者完全一致。**只要作者的訊息以 `/comotion-<名稱>` 開頭，就代表他要你照那個 skill 做**：先讀該 `SKILL.md`，再照裡面的步驟執行，斜線後面的文字就是這個 skill 的輸入。

| 作者打的 | skill | 什麼時候用 |
|---|---|---|
| `/comotion-new-slide` | `comotion-new-slide` | 加一頁講某件事（有計畫就照指南的頁型寫一份 SVG） |
| `/comotion-plan` | `comotion-plan` | 把大綱規劃成逐頁計畫與設計規格，寫進 `plan/` 後等作者在確認視窗拍板 |
| `/comotion-build` | `comotion-build` | 依確認過的計畫一頁寫一份 SVG、套動畫、登記範本，`validate` 修到 0 錯誤 |
| `/comotion-reshape` | `comotion-reshape` | 逐則處理釘選留言，改完刪留言 |
| `/comotion-check` | `comotion-check` | 全份結構體檢（錯字、層級、動畫順序），只留言不動手 |
| `/comotion-validate` | `comotion-validate` | 跑 `co-motion validate` 並把每個錯誤釘成留言，只留言不動手 |
| `/comotion-animate` | `comotion-animate` | 為指定頁或整份加上依序揭露的動畫與轉場 |
| `/comotion-style` | `comotion-style` | 統一整份的字級、顏色與字型，或把某頁樣式套到全部 |
| `/comotion-style-kit` | `comotion-style-kit` | 從風格庫挑一種寫進 `plan/design-spec.md`（配色、字級、字型、間距節奏） |
| `/comotion-background-kit` | `comotion-background-kit` | 從背景庫挑一種配方建成資產並套到頁面 |
| `/comotion-layout-kit` | `comotion-layout-kit` | 從版面庫挑一種排某一頁，附槽位字數預算與角色標記 |
| `/comotion-table` | `comotion-table` | 把貼上的 Markdown 表格在指定頁做成表格 |
| `/comotion-chart` | `comotion-chart` | 用一組數列在指定頁做出圖表，可選雙軸與堆疊 |
| `/comotion-notes` | `comotion-notes` | 依每頁內容補上口語化的備忘稿，可指定時長 |
