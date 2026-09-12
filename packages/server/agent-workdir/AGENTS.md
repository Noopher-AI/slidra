# CoMotion Agent 工作手冊

這份文件鋪設在你（agent）的工作目錄裡，是穩定不變的長期指引；每次對話開頭收到的編輯規約只講會變的東西（識別碼、引號規則），其餘都在這裡與 `reference/`，隨時用原生的檔案讀取能力回來查。

每次啟動 `co-motion serve` 都會用套件內建的版本整個重鋪這個工作目錄；你在這裡做的任何改動都不會被保留，筆記請留在對話裡。

## CoMotion 是什麼

CoMotion 是一個簡報編輯工具。作者在瀏覽器裡的圖形編輯器操作簡報，你（agent）用 `co-motion` 命令操作同一份簡報——兩邊改的是同一個檔案，不是各自的副本。一份簡報的每一張投影片都是一份合法的 SVG，SVG 本身就是成品；除了 SVG 之外，沒有更權威的表示法在它背後。

## 環境與限制

編輯規約已經講了：只能跑 `co-motion` 命令、不能寫檔、不能接重導向、參數只有裸 token 與單引號兩種寫法。這裡補三件它沒講的：

- 命令因為格式被擋時，你收到的是「使用者拒絕了這次工具使用」這種訊息，看起來像作者按了拒絕，其實是格式問題——檢查引號與重導向，不要問作者為什麼拒絕。
- 色碼一定要用單引號（`'#3366FF'`，`#` 不在裸 token 允許的符號裡）。
- 含有半形單引號 `'` 的文字，命令列完全表達不出來——在對話裡告訴作者這段文字打不進去，請他換一種寫法，不要靜默改寫。

## 命令參考

`co-motion` 完整的命令清單——每個命令的名稱、參數與一句用途——在 [`reference/commands.md`](reference/commands.md)。動手前先查那份參考，不要用編輯規約裡的兩個範例去猜其他命令的語法。

版面、字級、配色角色、動畫與驗證規則一律依 [`reference/slide-design.md`](reference/slide-design.md)，敘事模式與節奏依 [`reference/modes.md`](reference/modes.md)，可匯入的開源字型依 [`reference/fonts.md`](reference/fonts.md)。設計規則的驗證交給 `co-motion validate` 命令，不要自己心算。

## 虛擬檔案結構

一份簡報是這樣的一組虛擬路徑，你只能用 `co-motion` 命令讀寫它們：

- `project.json`：簡報的中繼資料（名稱、畫布尺寸、投影片清單、內嵌字型）。
- `slides/00N.svg`：每一頁投影片，索引從 1 開始，檔名補零到三位（第 2 頁是 `slides/002.svg`）。整頁寫入用 `slide add --svg`／`slide set --svg`，規則見 `reference/slide-design.md` 第 0 節。
- `assets/`：匯入的圖片、影片、音訊等媒體。你不能寫檔，但 `asset import --svg` 可以從命令列內容直接建立一張 SVG 資產（背景圖就是這樣來的）。
- `fonts/`：簡報內嵌的字型檔案。
- `templates/00N.svg`：`template add` 存下來的可重複使用範本；範本路徑一律用 `template list` 回傳的 `file` 欄位，名稱與檔名不是同一件事。
- `plan/outline.md`、`plan/design-spec.md`：這份簡報的逐頁計畫與設計規格，固定就這兩個檔名。檔案開頭是一個 ```` ```json ```` 圍欄（機器可讀），其後是 markdown 正文。只能用 `plan set` 寫、`cat` 讀、`plan delete` 刪；`validate` 與確認視窗都讀它。

## SVG 約定重點

- 每一個可編輯的圖元都包在 `<g id="el-…" data-comot-name="…">` 容器裡；裸圖元會被大多數命令拒絕，並要求先跑 `convert`。
- 元素識別碼一律從 `co-motion` 的回傳或 `cat` 的結果讀出來，動手前先 `cat` 那一頁。
- 備忘稿存在 `<metadata><comot:notes>` 裡，只能用 `cat` 讀。
- 留言存在 `<metadata><comot:comments>` 裡，`comment list` 讀、`comment add` 寫、`comment delete` 刪。
- 動畫效果存在 `<metadata><comot:effects>` 裡，排列順序就是播放順序。`effect list` 在這張投影片沒有任何效果時結束碼是非零——這代表「沒有動畫」，不是錯誤。

## 工作慣例

- 改動任何一頁之前，先 `co-motion cat <presentation-id> slides/00N.svg` 讀一次目前的內容。
- 你這一輪回覆裡下的所有命令，會被合併成作者按一次 undo 就能整段復原的一個群組——所以一個要求在同一輪做完；`undo`／`redo` 動到的是與作者共用的同一條歷史，不拿來試錯。
- 留言處理完就 `comment delete` 刪掉；做不到的留言保留原文，在對話裡就那一則提問。
- 一次只做一頁，做完確認過再做下一頁；使用者一次要求做多頁時，中途出錯才知道停在哪裡。
- 同一份簡報上的 `co-motion` 命令由 CLI 自己排隊執行，平行下多條命令安全但不會比較快；一次一條、看完結果再下下一條，出錯時才知道是哪一條。

## Skills

每一個 skill 的完整步驟都在你工作目錄的 `.agents/skills/<名稱>/SKILL.md`（Claude Code 讀的是同一份內容的 `.claude/skills/<名稱>/SKILL.md`）。目錄名、`SKILL.md` 的 `name`、作者打的斜線命令三者完全一致。**只要作者的訊息以 `/comotion-<名稱>` 開頭，就代表他要你照那個 skill 做**：先讀該 `SKILL.md`，再照裡面的步驟執行，斜線後面的文字就是這個 skill 的輸入。

三個素材庫（`style-kit`、`background-kit`、`layout-kit`）是 `plan` 與 `build` 正常流程的一部分：計畫階段從風格庫適配配色與背景配方，建置階段逐頁從版面庫挑版面。三個庫都是「目錄是起點，不是白名單」——可以改、可以混、也可以自己生。

| 作者打的 | skill | 什麼時候用 |
|---|---|---|
| `/comotion-plan` | `comotion-plan` | 把大綱規劃成逐頁計畫與設計規格，寫進 `plan/` 後等作者在確認視窗拍板 |
| `/comotion-build` | `comotion-build` | 依確認過的計畫一頁寫一份 SVG、套動畫、登記範本，`validate` 修到 0 錯誤 |
| `/comotion-new-slide` | `comotion-new-slide` | 加一頁講某件事 |
| `/comotion-validate` | `comotion-validate` | 跑 `co-motion validate` 並通讀錯字與動畫順序，把每個問題釘成留言，只留言不動手 |
| `/comotion-reshape` | `comotion-reshape` | 逐則處理釘選留言，改完刪留言 |
| `/comotion-animate` | `comotion-animate` | 為指定頁或整份加上依序揭露的動畫與轉場 |
| `/comotion-style` | `comotion-style` | 統一整份的字級、顏色與字型，或把某頁樣式套到全部 |
| `/comotion-notes` | `comotion-notes` | 依每頁內容補上口語化的備忘稿，可指定時長 |
| `/comotion-table` | `comotion-table` | 把貼上的 Markdown 表格在指定頁做成表格 |
| `/comotion-chart` | `comotion-chart` | 用一組數列在指定頁做出圖表，可選雙軸與堆疊 |
| `/comotion-style-kit` | `comotion-style-kit` | 從風格庫挑一種寫進 `plan/design-spec.md` |
| `/comotion-background-kit` | `comotion-background-kit` | 從背景庫挑一種配方建成資產並套到頁面 |
| `/comotion-layout-kit` | `comotion-layout-kit` | 從版面庫挑一種排某一頁 |
