# co-motion CLI 規格

這份文件是 `co-motion` 命令列工具的唯一規範性文件。TypeScript 引擎（`packages/core`／`packages/cli`）已刪除（[E4.T12]）——Rust 是現在唯一的實作，本文件即它的唯一依據。並存期曾對三個既有缺口（`asset import` 的 argv、`chart data set --csv -`、`effect list` 的 `data` 形狀）做出定案，這三處已由 Rust 依本規格實作。

`docs/adr/` 記錄的是決策史，本文件記錄的是命令集目前與未來的規範性事實；兩者衝突時以本文件為準。

**相容性等級 2 的凍結範圍**：命令名稱、位置參數的個數與順序、旗標名稱、exit code（成功 0、失敗 1）、`cat`／`ls`／`slide render` 三個 renderer 命令的輸出位元組——這些對 Rust 版必須逐位元組相容。**可變範圍**：其餘命令的成功 `data` JSON 形狀（三個已知缺口的定案，本規格說了算）、`message` 欄位的中文文案（人類可讀文字，從來不是可以模式比對的契約）。

## 定址

- **`<presentation-id>`**：`open` 回傳的不透明識別碼，12 個字元的 base64url 字串（9 個隨機位元組編碼而成）。它不可解碼出任何路徑或語意（ADR-0004）——不要嘗試從它猜出簡報實際存放的檔案系統路徑。
- **`<slide-path>`**：容器內的虛擬路徑，例如 `slides/001.svg`，必須列在該簡報 `project.json` 的 `slides` 陣列，或列在 `templates` 陣列裡（範本用同一組元素命令編輯，定址方式完全相同）。虛擬路徑不得是絕對路徑，不得含 `..` 片段。
- **`<element-id>`**：`el-` 前綴加 12 個字元的 base64url（與 `<presentation-id>` 同一個產生器，只是多了前綴）。
- **多元素定址**：接受 `<element-ids>`（複數）的命令一律是逗號分隔的清單（例如 `el-1,el-2,el-3`），不接受重複以旗標形式指定多次；批次定址仍然是**一步 undo**，不因為批次涉及多個元素而拆成多步。

## 引號與清單

命令列參數只能是「裸 token」（英數字與 `` _ . / : = , @ + - ``，或任何非 ASCII 文字）或「單引號字串」`'...'` 兩種寫法之一。**不使用雙引號，不使用反斜線轉義**。

- **逗號分隔清單**：`--categories Q1,Q2,Q3`、`<element-ids>` 的 `el-1,el-2`——都是同一個位置或旗標內用逗號分隔多個值，不是重複旗標。
- **`name=values` 形式**：`--series '營收=100,120,140'`、`--color '營收=#3366FF'`——等號前是名稱，後面是值（可能本身又是逗號分隔清單）。這種值幾乎一定要用單引號包起來，因為它同時含有 `=` 之外可能出現空白或中文的部分。
- **可重複旗標**：同一個旗標名稱可以在同一次呼叫裡出現多次時（例如 `chart axis set --right <系列名>`、`chart palette set --color 'name=#hex'`），每次出現各自代表一筆，不是覆寫關係。
- **何時一定要加引號**：值裡含有逗號、空白，或中文（含全形標點）時，一定要用單引號包起來，否則 shell 的斷詞規則會把它拆成多個 token 餵給 CLI，而不是 CLI 解析錯誤——這是 shell 引號規則與 CLI 參數解析之間的分界，CLI 本身不負責處理 shell 沒斷好詞的輸入。

## CommandResult

每個命令的 handler 只回傳這個結構，never 直接寫 `process.stdout` 或呼叫 `process.exit`：

```ts
interface CommandResult<Data = unknown> {
  ok: boolean;
  data?: Data;                 // 成功時的結構化 payload；失敗時不存在
  message: string;             // 繁體中文人類可讀文案，永不含真實檔案系統路徑
  failureKind?: "not-found" | "failed";  // 只在失敗時由 dispatch 填入
}
```

- `failureKind` 只有兩個值：**`"not-found"`**——請求的東西被正面證明不存在（未知的 `<presentation-id>`、找不到的虛擬路徑、找不到的元素等）；**`"failed"`**——其他任何原因（I/O 錯誤、驗證失敗、格式錯誤，或任何未來才發明、呼叫者還沒見過的錯誤子類）。分類規則（順序不可交換）：拋出的錯誤若是 `CoMotionNotFoundError`（或其子類）→ `not-found`；若是其他任何 `CoMotionError` 子類 → `failed`；**不是** `CoMotionError` 的例外一律往外拋、不轉換成 `CommandResult`——那是程式錯誤（bug），不是使用者可見的失敗，呼叫端必須讓它繼續中斷執行，不能吞掉。
- `failureKind` **缺席**（即使 `ok === false`）必須讀成「未證明不存在」，映射到 HTTP 語意時要答 500，不是 404——這是故意的保守預設：新發明一種失敗原因時，預設是「大聲失敗」而不是「安靜地誤判成 404」。
- `message` 是繁體中文人類文案，**不是契約**，可能隨時改措辭；呼叫者不得對 `message` 的字串內容做任何模式比對或分支判斷，只能拿來顯示給人看。`message` 永不含真實檔案系統路徑（無論成功或失敗）。
- exit code：成功恆為 `0`，失敗恆為 `1`，沒有第三種 exit code。

## 終端輸出

沒有註冊 renderer 的命令（87 條裡的 84 條）：預設輸出是「狀態行 + JSON」——先印一行 `message`，若 `data !== undefined` 再印一行 `JSON.stringify(data, null, 2)`；`data` 為 `undefined` 時只印狀態行，不印第二行。失敗時印 `message` 到 stderr，不印 JSON。

有 renderer 的三條命令（`cat`、`ls`、`slide render`）：輸出規則見下一節。

**下游 pipe 提早關閉**（例如 `co-motion cat <id> <path> | head`）：這類 one-shot 命令把 EPIPE 視為正常結束，`process.exit(0)`，不視為錯誤。`export`／`serve` **不適用**這條規則——`export` 若在寫出過程中遇到 EPIPE 就 `process.exit(0)`，會把一次沒寫完的匯出謊報成功，所以刻意不裝這個處理。

## Renderer 命令：`cat`、`ls`、`slide render`

只有這三條命令繞過「狀態行 + JSON」的預設輸出，改成印出 `data` 對應的原始位元組：

| 命令 | 輸出規則 |
|---|---|
| `cat` | `data.content` 原封不動地寫到 stdout，**不額外加換行、不加任何包裝**（等同 Unix `cat`：檔案的完整原始位元組，不多不少） |
| `ls` | `data.entries.map(e => e + "\n").join("")`——每個項目一行，沒有總數、沒有 JSON 包裝（等同 Unix `ls` 的最簡形式） |
| `slide render` | 與 `cat` 完全相同的 renderer（`data.content` 原封不動輸出）；`slide render` 是「顯示時態」版的 `cat`：內容在讀出前先把 `{{ slide_number }}`／`{{ slide_total }}`／`{{ presentation_name }}` 這類動態文字代換完成，其餘位元組規則與 `cat` 相同 |

其餘 78 條命令一律 `render: null`，走上一節的預設輸出。

## --json（全域旗標）

`--json` 是新規格定案的全域旗標，由 Rust 入口實作。

- 位置：只能出現在命令名之後（例如 `co-motion cat <id> <path> --json`），不影響任何命令自己的位置參數與旗標解析順序。
- 輸出：單行 compact（無縮排）JSON 加一個換行，欄位順序固定為 `ok, data, message, failureKind`。
- 有 renderer 的命令在 `--json` 下也一律回 JSON，不再走 renderer 的原始位元組輸出；`data.content` 這類原本是原始文字/位元組的欄位，在 `--json` 底下編碼成**原始位元組的 base64**（因為 JSON 字串無法安全承載任意二進位內容）。
- `cat --json` 是唯一允許接受**多個** `<path>` 的形式：`data` 變成 `[{ path, content }]` 陣列，順序與 argv 給的路徑順序相同；**沒有** `--json` 時 `cat` 仍然只接受單一路徑，直出原始 bytes（相容性等級 2 凍結範圍，不因為多路徑需求而改變單路徑行為）。
- 失敗時仍然印 JSON（`ok: false`，含 `failureKind`，不含 `data`），exit code 仍然是 `1`。
- `co-motion serve` 一律視為帶了 `--json`（它的呼叫端是程式，不是終端機使用者，不需要人類可讀的狀態行/renderer 輸出）。

## 「`-`」代表標準輸入

規格定義一組「可代換 stdin」的旗標。入口層（`bin.ts` 的 `main`，Rust 版是 `main.rs` 的對應位置）在呼叫 `dispatch` **之前**檢查：若某個可代換旗標的值恰好是字面字串 `"-"`，就讀取 stdin 的完整內容（UTF-8），把該欄位從「路徑欄位」改寫成同名但不同型別的 `*Text` 欄位，再交給 `dispatch`。`parseArgv` 本身是純函式，不讀 stdin、不做這個代換——代換必須發生在入口層，因為 `serve` 直接呼叫 `registry.dispatch`，完全繞過 `parseArgv`，若代換邏輯放在 argv 層，`serve` 這條路徑就永遠不會做代換。

目前**唯一**的可代換旗標：`chart data set` 的 `--csv`。`co-motion serve` 沒有終端機的 stdin 可讀——handler 若收到未被代換的字面值 `"-"`（也就是透過 `serve` 直接呼叫，繞過了入口層的代換），必須明確回傳失敗，不得把 `"-"` 當成一個檔名去讀。

## 環境變數

- **`CO_MOTION_HOME`**：`.comot` 之外的工作區根目錄，預設 `~/.comotion`。每次呼叫都重新讀取這個環境變數，不快取——同一個行程存活期間改變這個環境變數，下一次呼叫就會生效。佈局細節見 `docs/spec/comot-format.md`。
- **`CO_MOTION_BIN`**：Rust 入口 exec Node（跑 `serve`／`export`）之前，把自己的絕對路徑設進這個環境變數；Node 端任何需要再 spawn `co-motion` 命令的地方，一律用這個環境變數指向的**同一支二進位**，未設定時直接報錯，**不回退去 PATH 尋找 `co-motion`**（架構原則「一個二進位、一個真理」：絕不允許 Node 端不小心 spawn 到系統上另一支版本不同的 `co-motion`）。
- **`CO_MOTION_ID_SEED`**：設定時，id 產生器（`<presentation-id>`／`<element-id>`）改為確定性輸出，僅供測試使用；id 的字面格式（`el-` 前綴 + 12 字元 base64url）不因此改變。**確定性序列的實際演算法不是本規格的契約**，由實作 crate 自行決定——只要求「設定這個環境變數時輸出變成確定性，且格式不變」這一條外顯行為。

## Undo 語意

- **一次操作 = 一條命令 = 一步 undo**（ADR-0002）。批次定址（一條命令同時處理多個 `<element-id>`）仍然只算一步，不因為內部影響多個元素而拆成多步。
- **讀類命令不進歷史**：`cat`、`ls`、`effect list`、`template list`、`comment list`——這些命令不寫檔、不建立歷史群組、不產生 undo 步驟。
- **一個已知的例外**：`presentation canvas set` 雖然會寫入 `project.json`（改變畫布尺寸），但刻意設計成**不佔用任何 undo 步驟**——這是「一次操作一步 undo」規則唯一的例外，理由與畫布尺寸屬於簡報層級而非某一步可回退的內容編輯有關。
- 歷史的實際存放位置與磁碟格式見 `docs/spec/comot-format.md` 的「`~/.comotion/`」一節。

## 不經 registry 的入口：`serve` 與 `export`

`serve`／`export` 這兩個子命令**不算在 88 條命令之內**，也不使用命令條目的格式描述。它們在二進位入口就分流（`packages/server/bin/co-motion-node.js`：`argv[0] === "serve"` 或 `"export"` 時，動態載入 `@co-motion/server` 的 `runServeCli`／`runExportCli` 並直接呼叫），完全不經過 `parseArgv`、不經過 `CommandRegistry`。

Rust 入口的行為：偵測到 `serve`／`export` 時，先把自己的絕對路徑寫入 `CO_MOTION_BIN`，再 `exec` Node 執行 `@co-motion/server` 對應的 CLI 進入點，把 argv、stdin、stdout、stderr、exit code 逐位元組透傳。

## 命令條目格式說明

下面每一條命令固定用 `` ## `<命令名>` `` 作為標題——**H2 加反引號包住完整命令名，行內沒有其他文字**。這是本文件裡唯一允許以反引號開頭的 H2；文件中其他所有 H2（上面的通則各節、下面的附錄）一律不以反引號開頭。這個規則本身也是子集檢查腳本（`scripts/check-reference-subset.mjs`）與 `crates/co-motion/tests/cli_golden.rs` 的 `cli_md_lists_exactly_the_88_rust_dispatched_commands` 測試解析命令清單所依賴的唯一格式（抽取正則固定為 `` /^## `(.+)`$/gm ``）：`serve`／`export` 之所以不能用這個標題格式，正是因為那會讓抽取出的命令數變成 90，與 Rust 註冊的 88 條命令對不上。

每個命令條目固定五個小節，順序不變：

1. **語法**：一行 code block，位置參數用 `<角括號>`，選填旗標用 `[方括號]`，可重複旗標標注「(可重複)」。
2. **參數**：逐一列出每個位置參數與旗標，含型別與必填性；值域是固定集合的一律把集合全部列出，不省略。
3. **成功 `data`**：一段 JSON code block，是真實形狀（不是 `{...}` 這種佔位符）；沒有 payload 的命令寫 `{}`。`cat`、`ls`、`slide render` 三條額外描述 renderer 輸出的位元組規則（已經在上面「Renderer 命令」一節講過，條目內不重複整段，只指向那一節或簡述）。
4. **錯誤情境**：一張表，至少一列，每列是「情境 → `failureKind`」。
5. **範例**：一行可以直接複製貼上執行的命令。

以下 88 條命令依 `CommandRegistry.names()` 的**註冊順序**排列（不是字母順序）：
## `new`

**語法**

```
co-motion new <path> [--name <名稱>]
```

**參數**

- `path`：字串，必填。要建立的 `.comot` 檔案的本機檔案系統路徑（新檔案，不是既有簡報的識別碼——`new` 是唯一直接操作真實檔案系統路徑、不透過 `<presentation-id>` 的命令之一，因為它建立的目標本來就還不是一份「已開啟」的簡報）。
- `--name`：字串，選填。簡報的顯示名稱，寫入 `project.json.name`；省略時預設為「新簡報」。

建立出來的簡報**沒有任何投影片**（`project.json.slides` 是空陣列），只有 `project.json`、內嵌字型與其授權文字（ADR-0018）：第一頁由作者或 agent 之後用 `slide add` 或 `/comotion-outline` 產生，不預先放一張未經設計的佔位頁。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `path` 所在目錄不可寫入，或磁碟寫入失敗 | `failed` |

**範例**

```
co-motion new ./deck.comot --name '我的簡報'
```

## `open`

**語法**

```
co-motion open <path>
```

**參數**

- `path`：字串，必填。既有 `.comot` 檔案的本機檔案系統路徑。

**成功 `data`**

```json
{ "id": "AbCdEfGhIjKl" }
```

`id` 是 12 個字元的 base64url 不透明識別碼（見 `docs/spec/comot-format.md` 的「元素 id 格式」一節，`<presentation-id>` 用同一個產生器），是後續每一條命令的第一個位置參數。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `path` 指向的檔案不存在，或讀取失敗 | `failed` |
| `path` 指向的路徑不是檔案（例如是目錄） | `failed` |
| 檔案不是合法的 zip（`.comot` 已損壞） | `failed` |
| 解壓後的內容缺少可解析的 `project.json`，或 `project.json` 格式不符（見 `docs/spec/comot-format.md`） | `failed` |
| `project.json.formatVersion` 大於此建置支援的最大版本 | `failed` |
| 登記這份簡報時發生磁碟或登記檔（`projects.json`）本身的錯誤 | `failed` |

> 這些情境目前全部歸類為 `failed`，不是 `not-found`——`open` 的輸入是本機檔案系統路徑，不是一個「可能存在也可能不存在的識別碼」，所以沒有語意上的「找不到某個已註冊的東西」的情況；壓縮檔本身損壞、內容不合規都屬於「無法完成這個請求」而非「正面證明某個已知識別碼不存在」。

**範例**

```
co-motion open ./deck.comot
```

## `pack`

**語法**

```
co-motion pack <presentation-id> <path>
```

**參數**

- `presentation-id`：字串，必填，已開啟的簡報識別碼。
- `path`：字串，必填，輸出的 `.comot` 檔案的本機檔案系統路徑；若與 `open` 最初讀取的來源路徑相同，這次 `pack` 同時會把該簡報標記為「已儲存」（`~/.comotion/projects.json` 的 `savedAt` 會更新，見 `docs/spec/comot-format.md`）。輸出到其他任意路徑則單純另存一份，不影響「已儲存」狀態。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `path` 所在目錄不可寫入，或磁碟寫入失敗 | `failed` |

**範例**

```
co-motion pack pres-abc123 ./deck.comot
```

## `cat`

**語法**

```
co-motion cat <presentation-id> <path>
```

**參數**

- `presentation-id`：字串，必填。
- `path`：字串，必填，容器內虛擬路徑（例如 `project.json`、`slides/001.svg`、`assets/photo-1.png`），不是本機檔案系統路徑。

**成功 `data`**

```json
{ "content": "<檔案的完整原始內容>" }
```

`content` 是文字內容（讀出時視為 UTF-8）；終端輸出規則見「Renderer 命令」一節——預設情況下 `data.content` 會原封不動直接印到 stdout，不加換行、不印 `message`、不印 JSON 包裝。只有搭配全域旗標 `--json` 時，才會改成印出整個 `CommandResult` 的 JSON，此時 `data.content` 編碼成 base64（見通則「`--json`」一節）。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `path` 對應不到任何檔案或目錄 | `not-found` |
| `path` 對應到一個目錄而不是檔案 | `not-found` |

**範例**

```
co-motion cat pres-abc123 slides/001.svg
```

## `ls`

**語法**

```
co-motion ls <presentation-id> [path]
```

**參數**

- `presentation-id`：字串，必填。
- `path`：字串，選填，容器內虛擬目錄路徑；省略時列出頂層（`project.json`、`slides/`、`assets/`、`fonts/`，以及選填存在時的 `templates/`）。

**成功 `data`**

```json
{ "entries": ["project.json", "slides", "assets", "fonts"] }
```

`entries` 依目錄底下的實際名稱字典序排序，不分檔案與子目錄。終端輸出規則見「Renderer 命令」一節：預設情況下每個項目各印一行（`entries.map(e => e + "\n").join("")`），沒有總數、沒有 JSON 包裝。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `path` 對應不到任何目錄（含指向一個檔案而非目錄的情形） | `not-found` |

**範例**

```
co-motion ls pres-abc123
co-motion ls pres-abc123 slides
```
## `text set`

**語法**

```
co-motion text set <presentation-id> <slide-path> <element-id> <new-text> [--force]
```

**參數**

- `presentation-id`：字串，必填。要修改的簡報識別碼。
- `slide-path`：字串，必填。虛擬路徑（例如 `slides/001.svg`），可以是 `project.json` 的 `slides` 清單裡的投影片，**也可以是 `templates` 清單裡的範本**（`text set` 不限定只能對已插入的投影片動作）。
- `element-id`：字串，必填。要修改文字的元素 id。
- `new-text`：字串，必填，但**允許空字串 `''`**——空字串是合法值，代表清空該元素的文字內容，不會被當成「參數缺漏」拒絕（只有完全省略這個位置才算缺漏）。多行以 `\n` 分隔會各自轉成一行 `<tspan>`。
- `--force`：布林旗標，選填。只能出現在 `new-text` 之後那個固定位置（第 5 個位置引數）；出現在其他位置或有其他多餘引數都會被視為未知參數而報錯。用來略過「鎖定元素」保護（ADR-0013）——目標元素帶有 `data-comot-lock="true"` 時，一般情況下 `text set` 會拒絕修改，加上 `--force` 才能修改；鎖定狀態本身不會被清除或改變。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應不到任何檔案（含指向目錄的情形） | `not-found` |
| `slide-path` 不在該簡報的 `slides` 或 `templates` 清單裡 | `failed` |
| `new-text` 含有 XML 1.0 不允許的字元（例如控制字元） | `failed` |
| `element-id` 在該投影片裡找不到 | `failed` |
| 目標元素是鎖定的版面骨架，且未加 `--force` | `failed` |
| 目標元素不是文字承載元素，或該元素沒有文字內容可取代 | `failed` |
| 目標是文字框，但其 `data-comot-text-width` 不是合法正數，或宣告的字型未內嵌於簡報（資料已損毀） | `failed` |

**範例**

```
co-motion text set pres-abc123 slides/001.svg el-title '新的標題文字'
co-motion text set pres-abc123 slides/001.svg el-locked '' --force
```

## `text style set`

**語法**

```
co-motion text style set <presentation-id> <slide-path> <element-id> --range <start>:<end> [--font-weight <value>] [--font-style <value>] [--force]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，同 `text set`——可以是已登記的投影片或範本。
- `element-id`：字串，必填，必須是一個**文字框**（帶有 `data-comot-text-width` 的容器），不能是一般 `<text>` 元素。
- `--range <start>:<end>`：必填，格式固定為「非負整數:非負整數」，且 `start` 必須小於 `end`（半開區間 `[start, end)`，以字元為單位，對應文字框內容字串）。格式不符或起訖顛倒在命令解析階段就會直接報錯。
- `--font-weight`：選填字串。合法值為 `normal`、`bold`，或 100 的倍數（`100`–`900`）。`normal` 會**清除**該範圍的 `font-weight` 樣式（不是設成 normal），其他合法值會設定該樣式；旗標整個省略則該範圍的既有樣式維持不變。
- `--font-style`：選填字串。合法值為 `normal`（清除斜體樣式）或 `italic`（設定斜體）；省略則維持不變。
- `--font-weight`、`--font-style` 至少要提供一個，否則在命令解析階段就報錯（不會進入實際執行）。
- `--force`：布林旗標，可出現在參數的任何位置。同 `text set`，用來略過鎖定元素保護。

**成功 `data`**

```json
{ "runs": 3 }
```

`runs` 是套用樣式後，該文字框內容依樣式邊界重新切分出的片段（run）總數。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應不到任何檔案 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡 | `failed` |
| `--font-weight` 的值不是 `normal`、`bold`，也不是 100–900 之間 100 的倍數 | `failed` |
| `--font-style` 的值不是 `normal` 或 `italic` | `failed` |
| `element-id` 在該投影片裡找不到 | `failed` |
| `element-id` 存在，但不是文字框（沒有 `data-comot-text-width`） | `failed` |
| 目標容器不是單一 `<text>` 子元素的合法文字框內容，或該 `<text>` 沒有內容 | `failed` |
| `--range` 的 `end` 超出文字框目前內容的字元長度 | `failed` |
| 目標元素是鎖定的版面骨架，且未加 `--force` | `failed` |

**範例**

```
co-motion text style set pres-abc123 slides/001.svg el-body --range 0:5 --font-weight bold
co-motion text style set pres-abc123 slides/001.svg el-body --range 5:12 --font-style italic --force
```

## `text list set`

**語法**

```
co-motion text list set <presentation-id> <slide-path> <element-id> --paragraph <n> --kind bullet|number|none [--force]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，同 `text set`——可以是已登記的投影片或範本。
- `element-id`：字串，必填，必須是文字框。
- `--paragraph`：必填，非負整數（0-based），對應該文字框內容以 `"\n"` 切分出的段落索引；非負整數格式不符在命令解析階段就報錯。
- `--kind`：必填，固定集合 `bullet`、`number`、`none` 三選一；不在此集合內在命令解析階段就報錯。
- `--force`：布林旗標，可出現在參數任何位置，略過鎖定元素保護。

**成功 `data`**

```json
{ "paragraphs": 4 }
```

`paragraphs` 是該文字框目前內容的段落總數。若指定段落原本就已經是 `none` 且再次設為 `none`，視為合法的無動作（不寫檔、不佔用復原步驟），仍回傳成功與相同的 `paragraphs`。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應不到任何檔案 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡 | `failed` |
| `element-id` 在該投影片裡找不到 | `failed` |
| `element-id` 存在，但不是文字框 | `failed` |
| 目標容器不是合法的單一 `<text>` 內容，或該 `<text>` 沒有內容 | `failed` |
| `--paragraph` 指定的段落編號超出該文字框目前的段落數 | `failed` |
| 目標元素是鎖定的版面骨架，且未加 `--force` | `failed` |

**範例**

```
co-motion text list set pres-abc123 slides/001.svg el-body --paragraph 0 --kind bullet
co-motion text list set pres-abc123 slides/001.svg el-body --paragraph 2 --kind none --force
```

## `textbox add`

**語法**

```
co-motion textbox add <presentation-id> <slide-path> --x <num> --y <num> --width <num> --text <string> [--font-size <num>] [--font-family <string>] [--font-weight <num>] [--fill <string>] [--align left|center|right]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，可以是已登記的投影片或範本。
- `--x`、`--y`：必填，任意有限數字（座標，使用者單位）。
- `--width`：必填，有限數字；四捨五入到小數點後 4 位後必須大於 0（實際寫入檔案的值就是這個四捨五入後的值，換行是依這個值計算）。
- `--text`：必填字串，要放入文字框的內容，會依 `--width` 自動換行。
- `--font-size`：選填有限數字；省略則預設 24（使用者單位）。同 `--width`，四捨五入後必須大於 0。
- `--font-family`：選填字串；省略則預設 `"Noto Sans TC"`，必須是簡報已內嵌的字型家族。
- `--font-weight`：選填有限數字，純粹寫入 `font-weight` 屬性供渲染使用，不做範圍檢查、不影響量測排版。
- `--fill`：選填字串，寫入文字顏色屬性，不做格式檢查。
- `--align`：選填，固定集合 `left`、`center`、`right`；省略預設 `left`。只在**建立當下**決定，之後沒有任何指令能再修改既有文字框的對齊（`textbox align` 是另一個命令，見下）。省略或給 `left` 時完全不寫入 `data-comot-text-align` 屬性。

**成功 `data`**

```json
{ "elementId": "el-a1b2c3", "lines": 3 }
```

`lines` 是依 `--width` 換行後的行數。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應不到任何檔案 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡 | `failed` |
| `--font-family`（或省略時的預設字型）未內嵌於該簡報 | `failed` |
| `--width` 四捨五入到小數點後 4 位後不是大於 0 的數字 | `failed` |
| `--font-size`（或省略時的預設值）四捨五入到小數點後 4 位後不是大於 0 的數字 | `failed` |

**範例**

```
co-motion textbox add pres-abc123 slides/002.svg --x 100 --y 200 --width 400 --text '第一行\n第二行'
co-motion textbox add pres-abc123 slides/002.svg --x 0 --y 0 --width 300 --text '置中標題' --align center --font-size 32
```

## `textbox width`

**語法**

```
co-motion textbox width <presentation-id> <slide-path> <element-id> <width> [--force]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，可以是已登記的投影片或範本。
- `element-id`：字串，必填，必須是既有的文字框。
- `width`：位置引數，必填，任何有限數字字串（只檢查是否為合法數字，不檢查正負）。文字內容不變，只重新依新寬度換行。
- `--force`：只能出現在 `width` 之後那個固定位置；用來略過鎖定元素保護。

**成功 `data`**

```json
{ "lines": 2 }
```

`lines` 是依新寬度重新換行後的行數。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應不到任何檔案 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡 | `failed` |
| `width` 不是大於 0 的數字，或四捨五入到小數點後 4 位後不是大於 0 | `failed` |
| `element-id` 在該投影片裡找不到，或找到但不是文字承載結構 | `failed` |
| `element-id` 存在，但不是文字框（沒有 `data-comot-text-width`） | `failed` |
| 目標元素是鎖定的版面骨架，且未加 `--force` | `failed` |

**範例**

```
co-motion textbox width pres-abc123 slides/002.svg el-a1b2c3 500
co-motion textbox width pres-abc123 slides/002.svg el-locked 250 --force
```

## `textbox align`

**語法**

```
co-motion textbox align <presentation-id> <slide-path> <element-id> <left|center|right> [--force]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，可以是已登記的投影片或範本。
- `element-id`：字串，必填，必須是既有的文字框。
- `align`：位置引數，必填，固定集合 `left`、`center`、`right`；不在此集合內在命令解析階段就報錯。重新設定對齊會連帶依目前寬度重新換行。
- `--force`：只能出現在 `align` 之後那個固定位置；用來略過鎖定元素保護。

**成功 `data`**

```json
{ "lines": 2 }
```

`lines` 是重新對齊、重新換行後的行數。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應不到任何檔案 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡 | `failed` |
| `element-id` 在該投影片裡找不到，或找到但不是文字承載結構 | `failed` |
| `element-id` 存在，但不是文字框（沒有 `data-comot-text-width`） | `failed` |
| 目標元素是鎖定的版面骨架，且未加 `--force` | `failed` |

**範例**

```
co-motion textbox align pres-abc123 slides/002.svg el-a1b2c3 center
co-motion textbox align pres-abc123 slides/002.svg el-locked right --force
```

## `convert`

**語法**

```
co-motion convert <presentation-id>
```

**參數**

- `presentation-id`：字串，必填。要轉換的簡報識別碼。沒有單張投影片或 dry-run 的形式——這條命令一次處理整份簡報的所有投影片，全有或全無。

**成功 `data`**

```json
{
  "slides": [
    { "slidePath": "slides/001.svg", "changed": true, "wrapped": 2 }
  ]
}
```

`slides` 陣列涵蓋 `project.json.slides` 列出的每一張投影片，依原始順序；`changed` 代表這張投影片的位元組是否因轉換而改變；`wrapped` 是這張投影片因轉換而新增的容器（`<g id="el-…">`）數量。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| 任一投影片內容無法正規化（例如結構嚴重損毀，正規化邏輯本身丟出錯誤） | `failed` |
| 寫入某張投影片時發生磁碟錯誤 | `failed` |

> 讀取階段（正規化前）與寫入階段的錯誤都歸類為 `failed`。寫入階段特別設計成「不留半成品」：所有投影片會先全部讀出並正規化完成，只要有一張正規化失敗，就不會寫入任何一個位元組；寫入階段真的動筆之後若某一張寫入失敗，已經寫入的其餘投影片會被盡力還原成原始內容，錯誤訊息會誠實描述還原是否完全成功，而不是宣稱「整份簡報都沒有被修改」卻其實有例外。

**範例**

```
co-motion convert pres-abc123
```

## `undo`

**語法**

```
co-motion undo <presentation-id>
```

**參數**

- `presentation-id`：字串，必填。

**成功 `data`**

```json
{ "restoredPaths": ["slides/001.svg"] }
```

`restoredPaths` 是這一步 undo 實際還原（或刪除，見下方）的虛擬路徑清單。若被復原的那個歷史群組裡有某筆 entry 的 `snapshotId` 為 `null`（代表該路徑是被「建立」的，例如一次素材匯入），undo 的動作是**刪除該檔案**而不是還原內容；`restoredPaths` 仍然會列出這個路徑。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| undo 堆疊是空的（沒有可復原的操作） | `failed` |
| 復原歷史檔案（`stack.json`）已損毀，或快照檔案讀寫失敗 | `failed` |

**範例**

```
co-motion undo pres-abc123
```

## `redo`

**語法**

```
co-motion redo <presentation-id>
```

**參數**

- `presentation-id`：字串，必填。

**成功 `data`**

```json
{ "restoredPaths": ["slides/001.svg"] }
```

語意與 `undo` 對稱：`restoredPaths` 是這一步 redo 重新套用（或重新建立）的虛擬路徑清單。任何一次新的寫入操作發生後，redo 堆疊會被清空——這是一般 undo/redo 系統的標準規則，不是本命令特有的例外。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| redo 堆疊是空的（沒有可重做的操作，例如尚未 undo 過，或 undo 之後又執行了新的寫入操作） | `failed` |
| 復原歷史檔案（`stack.json`）已損毀，或快照檔案讀寫失敗 | `failed` |

**範例**

```
co-motion redo pres-abc123
```
## `element insert`

**語法**

```
co-motion element insert <kind> <presentation-id> <slide-path> [--x n] [--y n] [--width n] [--height n] [--x1 n] [--y1 n] [--x2 n] [--y2 n] [--d path-data] [--fill value] [--stroke value] [--stroke-width n] [--href value] [--media value] [--embed provider]
```

**參數**

- `kind`：必填，位置參數，值域固定為 `rect`、`ellipse`、`line`、`image`、`path`、`video`、`audio` 之一；不在此集合內會在 argv 解析階段直接報錯（不經過 dispatch，不帶 `failureKind`）。
- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `--x`、`--y`：數字，選填；`rect`／`ellipse`／`image`／`video`／`audio` 必填（缺少或非有限數字會報錯），`path` 選填（預設 `0`），`line` 不使用。
- `--width`、`--height`：數字，選填；`rect`／`ellipse`／`image`／`video`／`audio` 必填，且必須是大於 0 的數字，其他 kind 不使用。
- `--x1`、`--y1`、`--x2`、`--y2`：數字，選填；`line` 必填（缺少或非有限數字會報錯），其他 kind 不使用。
- `--d`：字串，選填；`path` 必填（SVG path 資料，原樣寫入 `d` 屬性，不驗證語法）。
- `--fill`：字串，選填，任何 kind 皆可使用（未經格式驗證，原樣寫入 `fill` 屬性）。
- `--stroke`：字串，選填，任何 kind 皆可使用。
- `--stroke-width`：數字，選填；只在同時給 `--stroke-width` 時驗證，必須是大於 0 的數字。
- `--href`：字串，選填；`image` 必填（缺少會報錯）；`video`／`audio` 選填（給了就以海報圖 `<image>` 呈現，不給則呈現一個色塊 `<rect>`）；其餘 kind 不使用。
- `--media`：字串，選填，任何 kind 皆可標記為媒體佔位符（`data-comot-media`）。
- `--embed`：字串，選填；只能搭配 `--kind video` 使用（否則報錯），且必須同時給 `--media`（否則報錯）；值必須是受支援的嵌入提供者（由 `requireEmbedProvider` 驗證）。

**成功 `data`**

```json
{ "elementId": "el-xxxxxxxxx" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `image` 缺少 `--href` | `failed` |
| `path` 缺少 `--d` | `failed` |
| `--embed` 用在非 `--kind video` 的元素上 | `failed` |
| `--embed` 未搭配 `--media` | `failed` |
| `--embed` 的值不是受支援的嵌入提供者 | `failed` |
| `--x`/`--y`/`--width`/`--height`/`--x1`/`--y1`/`--x2`/`--y2` 缺少或不是有限數字（依 kind 而定） | `failed` |
| `--width`/`--height`/`--stroke-width` 不是大於 0 的數字 | `failed` |

**範例**

```
co-motion element insert rect pres-123 slides/1.svg --x 100 --y 200 --width 300 --height 150 --fill '#3366ff'
```

---

## `element delete`

**語法**

```
co-motion element delete <presentation-id> <slide-path> <element-ids>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單（例：`el-1,el-2`），不可為空、不可含空白 token。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |

**範例**

```
co-motion element delete pres-123 slides/1.svg el-1,el-2
```

（刪除一個群組時，其內部所有子元素連帶被刪除，不需個別列出；已被祖先涵蓋的目標不會被重複判定為「找不到」。）

---

## `element move`

**語法**

```
co-motion element move <presentation-id> <slide-path> <element-ids> --dx n --dy n [--force]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。
- `--dx`：必填，數字，位移量（可正可負）。
- `--dy`：必填，數字，位移量（可正可負）。
- `--force`：選填，布林旗標（無值），繞過鎖定元素的保護（ADR-0013）。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| 目標是鎖定的元素且未加 `--force` | `failed` |
| 目標既有的 `transform` 含傾斜（skew）或矩陣退化，無法拆解 | `failed` |

**範例**

```
co-motion element move pres-123 slides/1.svg el-1 --dx 10 --dy -5
```

---

## `element scale`

**語法**

```
co-motion element scale <presentation-id> <slide-path> <element-ids> --factor n [--force]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。
- `--factor`：必填，數字，必須是大於 0 的數字；以每個目標自身容器原點為錨點等比縮放。
- `--force`：選填，布林旗標，繞過鎖定元素的保護。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| `--factor` 不是大於 0 的數字 | `failed` |
| 目標（或其群組子孫）是鎖定的元素且未加 `--force` | `failed` |
| 目標是表格容器，且縮放非等比（表格一律走 `--factor` 等比路徑，不受此限） | `failed` |
| 縮放後數值四捨五入為 0 或以下（例：寬高、font-size） | `failed` |
| 目標的 `path` 含橢圓弧（`A`/`a` 指令），尚不支援縮放 | `failed` |
| 圖元標籤不支援縮放（例如 `<polygon>`） | `failed` |
| 群組子容器缺少 `id`，無法縮放 | `failed` |

**範例**

```
co-motion element scale pres-123 slides/1.svg el-1 --factor 1.5
```

（目標若為群組，會遞迴縮放所有子孫容器的位移與圖元幾何；文字框則同時縮放 font-size 並重新換行。）

---

## `element resize`

**語法**

```
co-motion element resize <presentation-id> <slide-path> <element-ids> --width n --height n [--anchor nw|ne|sw|se] [--force]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。
- `--width`：必填，數字，必須是大於 0 的數字，目標調整後的寬度。
- `--height`：必填，數字，必須是大於 0 的數字，目標調整後的高度。
- `--anchor`：選填，值域為 `nw`、`ne`、`sw`、`se`，預設 `nw`；指定調整時固定不動的角落。
- `--force`：選填，布林旗標，繞過鎖定元素的保護。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| `--width`/`--height` 不是大於 0 的數字 | `failed` |
| `--anchor` 不是 `nw`/`ne`/`sw`/`se` 之一 | `failed` |
| 目標（或其群組子孫）是鎖定的元素且未加 `--force` | `failed` |
| 目標沒有可計算的邊界框（寬或高為 0） | `failed` |
| 目標含 `<text>`/`<circle>`/`<path>` 且本次調整是非等比（`sx ≠ sy`）——需改用 `element scale` | `failed` |
| 目標既有的 `transform` 含傾斜或矩陣退化 | `failed` |

**範例**

```
co-motion element resize pres-123 slides/1.svg el-1 --width 400 --height 200 --anchor nw
```

（`--width`/`--height` 是調整後的目標尺寸，非位移量；`--anchor` 指定的角落座標在調整前後保持不動。）

---

## `element rotate`

**語法**

```
co-motion element rotate <presentation-id> <slide-path> <element-ids> --degrees n [--force]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。
- `--degrees`：必填，數字，旋轉角度增量（相對於目前角度疊加，可正可負）。
- `--force`：選填，布林旗標，繞過鎖定元素的保護。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| 目標是鎖定的元素且未加 `--force` | `failed` |
| 目標既有的 `transform` 含傾斜（skew），這個模型沒有傾斜的語意，無法拆解 | `failed` |

**範例**

```
co-motion element rotate pres-123 slides/1.svg el-1,el-2 --degrees 15
```

---

## `element style set`

**語法**

```
co-motion element style set <presentation-id> <slide-path> <element-ids> <attr> <value> [--force]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。
- `attr`：必填，位置參數，必須落在白名單內（ADR-0014）：`fill`、`stroke`、`stroke-width`、`stroke-dasharray`、`opacity`、`font-family`、`font-size`、`font-weight`、`text-anchor`。
- `value`：必填，位置參數（可為空字串，視為合法值，不視為缺少參數）。
- `--force`：選填，布林旗標，繞過鎖定元素的保護。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| `attr` 是 `transform`/`x`/`y`/`width`/`height`（位置與大小需用 move/scale/resize） | `failed` |
| `attr` 以 `data-comot-` 開頭（保留屬性前綴） | `failed` |
| `attr` 不在樣式白名單內 | `failed` |
| `attr` 為 `opacity` 但 `value` 不是 0 到 1 之間的數字 | `failed` |
| `attr` 為 `font-size` 但 `value` 不是大於 0 的數字 | `failed` |
| `attr` 為 `stroke-width` 但 `value` 是負數 | `failed` |
| `attr` 為 `text-anchor` 但 `value` 不是 `start`/`middle`/`end` 之一 | `failed` |
| 目標是鎖定的元素且未加 `--force` | `failed` |
| 目標是表格容器（樣式需用 `table` 命令族調整） | `failed` |
| 目標是圖表容器（樣式需用 `chart` 命令族調整） | `failed` |
| 目標是群組，沒有可套用樣式的圖元 | `failed` |
| 目標是文字框且 `attr` 為 `text-anchor`（文字框的換行引擎假設 start，不支援） | `failed` |

**範例**

```
co-motion element style set pres-123 slides/1.svg el-1 fill '#ff0000'
```

---

## `element order`

**語法**

```
co-motion element order <presentation-id> <slide-path> <element-ids> <direction> [--force]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單；`front`/`back` 依清單順序處理（清單最後一個 id 最終疊在最上/最下），`up`/`down` 則每個目標各自逐步移動一層。
- `direction`：必填，位置參數，值域為 `front`、`back`、`up`、`down`。
- `--force`：選填，布林旗標，繞過鎖定元素的保護。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| 目標是鎖定的元素且未加 `--force` | `failed` |

**範例**

```
co-motion element order pres-123 slides/1.svg el-1 front
```

（若目標已在同層容器中的最上/最下層，或該層只有這一個子元素，此命令為無操作，仍視為成功。不同父容器下的目標互不影響彼此的順序。）

---

## `element group`

**語法**

```
co-motion element group <presentation-id> <slide-path> <element-ids>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單，至少需要兩個元素，且必須都在同一層容器內。

**成功 `data`**

```json
{ "elementId": "el-xxxxxxxxx", "removedEffects": 0 }
```

`elementId` 是新建立的群組容器 id；`removedEffects` 是因為原本直接指向被群組成員的動畫效果項被移除的數量（成員一旦被收進群組，就不再是可獨立選取、可獨立套動畫的對象）。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| `element-ids` 少於兩個元素 | `failed` |
| `element-ids` 中的元素不在同一層容器內 | `failed` |
| `element-ids` 內有重複的 id | `failed` |

**範例**

```
co-motion element group pres-123 slides/1.svg el-1,el-2,el-3
```

（本命令不檢查鎖定狀態，也沒有 `--force`；新群組容器本身不帶 `transform`，落在清單中文件順序最後（最上層）目標原本的位置，其餘目標的原始 z-order 不受影響。）

---

## `element ungroup`

**語法**

```
co-motion element ungroup <presentation-id> <slide-path> <element-ids>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的群組 id 清單。

**成功 `data`**

```json
{ "elementIds": ["el-a", "el-b"], "removedEffects": 0 }
```

`elementIds` 是所有被解散群組的直接子元素 id（依處理順序串接），供前端重新選取；`removedEffects` 是因為直接指向被解散群組本身的動畫效果項被移除的數量。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| `element-ids` 中有元素是表格容器（表格不能被解散群組） | `failed` |
| `element-ids` 中有元素不是群組 | `failed` |
| `element-ids` 內有重複的 id | `failed` |

**範例**

```
co-motion element ungroup pres-123 slides/1.svg el-group1
```

（解散時群組自身的 `transform` 會被摺疊進每個子元素各自的 `transform`，使子元素的絕對位置不變；本命令不檢查鎖定狀態，也沒有 `--force`。）

---

## `element align`

**語法**

```
co-motion element align <presentation-id> <slide-path> <element-ids> <direction>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單，至少需要兩個元素，且必須都在同一層容器內。
- `direction`：必填，位置參數，值域為 `left`、`hcenter`、`right`、`top`、`vcenter`、`bottom`。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| `element-ids` 少於兩個元素 | `failed` |
| `element-ids` 中的元素不在同一層容器內 | `failed` |
| 有目標無法量測邊界框（例如裸露的 `<text>` 圖元，或含橢圓弧的 `path`） | `failed` |

**範例**

```
co-motion element align pres-123 slides/1.svg el-1,el-2,el-3 hcenter
```

（對齊基準是所有目標邊界框的聯集（union），每個目標只移動自己容器的位移；本命令沒有 `--force`，不檢查鎖定狀態。）

---

## `element distribute`

**語法**

```
co-motion element distribute <presentation-id> <slide-path> <element-ids> <axis>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單，至少需要三個元素，且必須都在同一層容器內。
- `axis`：必填，位置參數，值域為 `horizontal`、`vertical`。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |
| `element-ids` 少於三個元素 | `failed` |
| `element-ids` 中的元素不在同一層容器內 | `failed` |
| 有目標無法量測邊界框 | `failed` |

**範例**

```
co-motion element distribute pres-123 slides/1.svg el-1,el-2,el-3,el-4 horizontal
```

（依邊界框「中心點」在指定軸上排序，取第一個與最後一個中心點固定不動，中間的目標被重新等距分佈；本命令沒有 `--force`。）

---

## `element name set`

**語法**

```
co-motion element name set <presentation-id> <slide-path> <element-ids> <name>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。
- `name`：必填，位置參數（可為空字串——空字串會清除既有的顯示名稱，而不是報錯）。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |

**範例**

```
co-motion element name set pres-123 slides/1.svg el-1 '標題文字'
```

（多個 id 之間名稱不要求唯一；本命令沒有 `--force`，不檢查鎖定狀態。）

---

## `element copy`

**語法**

```
co-motion element copy <presentation-id> <slide-path> <element-ids>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。

**成功 `data`**

```json
{ "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" ...>...</svg>" }
```

`svg` 是與系統剪貼簿交換格式相同的獨立 `<svg>` 字串（等同 GUI 按下 ⌘C 寫入 `navigator.clipboard` 的內容），同時也會寫入該簡報專屬的內部剪貼簿檔案（`<CO_MOTION_HOME>/clipboard/<presentation-id>.json`），供同一簡報之後的 `element paste`（未帶 `--svg-file`）讀取。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |

**範例**

```
co-motion element copy pres-123 slides/1.svg el-1,el-2
```

（不修改簡報內容，不佔用復原/重做步驟；複製的元素若原本在群組內，其祖先鏈的 transform 會被摺疊進自身的 transform，確保貼到其他簡報的根層級時視覺位置不變。）

---

## `element cut`

**語法**

```
co-motion element cut <presentation-id> <slide-path> <element-ids>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。

**成功 `data`**

```json
{ "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" ...>...</svg>" }
```

`svg` 意義同 `element copy` 的 `svg`。內部剪貼簿檔案的寫入發生在簡報本身被寫回之前，確保剪貼簿寫入失敗時簡報不會已經被修改過。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |

**範例**

```
co-motion element cut pres-123 slides/1.svg el-1
```

（不檢查鎖定狀態——ADR-0013 明訂刪除鎖定元素不需要 `--force`；復原（undo）會還原被刪除的元素，但不會還原剪貼簿內容，與一般編輯器行為一致。）

---

## `element paste`

**語法**

```
co-motion element paste <presentation-id> <slide-path> [--dx n] [--dy n] [--svg-file path]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數，貼上的目的地（可以和複製來源的投影片不同）。
- `--dx`：選填，數字，預設 `0`；貼上後每個新元素自身容器再位移的量。
- `--dy`：選填，數字，預設 `0`。
- `--svg-file`：選填，本機檔案路徑，內容須是系統剪貼簿交換格式的 `<svg>` 字串（CLI 專屬旗標；讀不到檔案會報錯）。給了 `--svg-file` 時，直接解析該內容貼上，完全不讀取、也不寫入該簡報的內部剪貼簿檔案；不給則讀取該簡報先前 `element copy`/`element cut` 寫入的內部剪貼簿檔案。

**成功 `data`**

```json
{ "elementIds": ["el-a", "el-b"] }
```

`elementIds` 是貼上後、每個剪貼簿項目對應的新頂層元素 id（依剪貼簿原始順序，絕不含子孫元素的 id）——貼上時每個容器 id（含子孫）都會被重新產生，並在效果項的 `target` 中一併替換。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `--svg-file` 指定的本機檔案讀不到 | `failed` |
| 未給 `--svg-file` 且該簡報的內部剪貼簿檔案不存在（尚未複製/剪下過，或已被其他方式清除） | `failed` |
| 內部剪貼簿檔案存在但讀取失敗（非「找不到檔案」的 I/O 錯誤） | `failed` |
| 內部剪貼簿檔案內容不是合法 JSON | `failed` |
| `--svg-file` 給的內容不是合法的 co-motion 元素剪貼簿格式（缺少辨識標記或無法解析） | `failed` |
| 剪貼簿內容為空（沒有任何元素可貼上） | `failed` |
| 剪貼簿內容未通過三層驗證（結構、單一根節點、屬性/值白名單——ADR-0010，見 `sanitizeClipboardMarkup`） | `failed` |

**範例**

```
co-motion element paste pres-123 slides/2.svg --dx 20 --dy 20
```

（`--svg` 這個系統剪貼簿字串輸入在 `ElementPasteInput` 型別中存在，但 CLI 的 argv 層目前只曝露 `--svg-file`，未曝露對應的 `--svg` 旗標；`--svg-file` 讀出的內容會作為該欄位的值。）

---

## `element duplicate`

**語法**

```
co-motion element duplicate <presentation-id> <slide-path> <element-ids> [--dx n] [--dy n]
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單（複製來源）。
- `--dx`：選填，數字，預設 `0`；新複本再位移的量。
- `--dy`：選填，數字，預設 `0`。

**成功 `data`**

```json
{ "elementIds": ["el-a", "el-b"] }
```

`elementIds` 是新建立之複本的頂層元素 id（依來源清單順序）。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |

**範例**

```
co-motion element duplicate pres-123 slides/1.svg el-1 --dx 10 --dy 10
```

（內部走與 `copy`＋`paste` 相同的抽取/貼上邏輯，但完全繞過剪貼簿檔案，不會覆寫使用者實際的剪貼簿內容；不檢查鎖定狀態，沒有 `--force`。）

---

## `element lock`

**語法**

```
co-motion element lock <presentation-id> <slide-path> <element-ids>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |

**範例**

```
co-motion element lock pres-123 slides/1.svg el-1,el-2
```

（在每個目標容器上設定 `data-comot-lock="true"`；具幂等性——鎖定一個已鎖定的元素不會報錯。）

---

## `element unlock`

**語法**

```
co-motion element unlock <presentation-id> <slide-path> <element-ids>
```

**參數**

- `presentation-id`：必填，位置參數。
- `slide-path`：必填，位置參數。
- `element-ids`：必填，位置參數，逗號分隔的元素 id 清單。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應的檔案不存在 | `not-found` |
| `slide-path` 存在但未列在 `project.json` 的 slides/templates 清單中 | `failed` |
| `element-ids` 中有 id 找不到對應元素 | `failed` |

**範例**

```
co-motion element unlock pres-123 slides/1.svg el-1,el-2
```

（移除目標容器上的 `data-comot-lock` 屬性——一律整個屬性移除，絕不寫入 `data-comot-lock="false"`；具幂等性——解鎖一個已解鎖的元素不會報錯。）
## `table create`

**語法**

```
co-motion table create <presentation-id> <slide-path> --rows <n> --cols <n> --x <x> --y <y> [--col-width <width>] [--theme dark|light|zebra] [--header true|false]
```

**參數**

- `<presentation-id>`：字串，必填，簡報識別碼
- `<slide-path>`：字串，必填，投影片的虛擬路徑
- `--rows`：數字，必填，須為 ≥ 1 的整數
- `--cols`：數字，必填，須為 ≥ 1 的整數
- `--x`：數字，必填，有限數字（表格容器左上角 x 座標）
- `--y`：數字，必填，有限數字（表格容器左上角 y 座標）
- `--col-width`：數字，選填，須為大於 0 的有限數字；省略時每欄使用預設欄寬 160
- `--theme`：字串，選填，值域固定為 `dark`、`light`、`zebra`；省略時預設 `dark`
- `--header`：字串，選填，只接受 `true` 或 `false`（在 CLI 參數解析階段檢查，不合法值會直接以 parse 錯誤中止、不會進入 dispatch，因此沒有 `failureKind`）；省略時預設開啟表頭

**成功 `data`**

```json
{ "elementId": "el-a1b2c3" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範（例如缺少或格式錯誤的 `viewBox`） | `failed` |
| `--rows`／`--cols` 不是 ≥ 1 的整數 | `failed` |
| `--x`／`--y` 不是有限數字 | `failed` |
| `--col-width` 不是大於 0 的有限數字 | `failed` |
| `--theme` 不是 `dark`／`light`／`zebra` 之一 | `failed` |

**範例**

```
co-motion table create pres-1 slides/1.svg --rows 3 --cols 4 --x 40 --y 60 --theme light --header true
```

## `table cell set`

**語法**

```
co-motion table cell set <presentation-id> <slide-path> <element-id> --row <row> --col <col> --text <text>
```

**參數**

- `<presentation-id>`：字串，必填
- `<slide-path>`：字串，必填
- `<element-id>`：字串，必填，目標表格容器的元素 id
- `--row`：數字，必填，0-based 列索引
- `--col`：數字，必填，0-based 欄索引
- `--text`：字串，必填，寫入該儲存格的純文字內容（允許空字串）

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `(row,col)` 沒有對應的實際儲存格（超出表格範圍，或該位置被合併範圍覆蓋） | `failed` |

**範例**

```
co-motion table cell set pres-1 slides/1.svg el-table1 --row 0 --col 1 --text '營收'
```

## `table cell style set`

**語法**

```
co-motion table cell style set <presentation-id> <slide-path> <element-id> --row <row> --col <col> [--row-end <row>] [--col-end <col>] <attr> <value>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同 `table cell set`
- `--row`：數字，必填，範圍起始列（0-based）
- `--col`：數字，必填，範圍起始欄（0-based）
- `--row-end`：數字，選填，範圍結束列；省略時等同 `--row`
- `--col-end`：數字，選填，範圍結束欄；省略時等同 `--col`（`--row`/`--row-end`、`--col`/`--col-end` 兩端可任意順序，套用時會自動取 min/max 框出矩形）
- `<attr>`：字串，必填，最後兩個位置參數中的第一個；值域固定為 `align`、`fill`、`text-fill`、`font-weight`（未提供時在 CLI 參數解析階段即中止，非 `failureKind`）
- `<value>`：字串，必填，最後一個位置參數，值域依 `<attr>` 而定：
  - `align`：`left`、`center`、`right`
  - `font-weight`：`100`、`200`、`300`、`400`、`500`、`600`、`700`、`800`、`900`
  - `fill`：`none` 或 `#RRGGBB`
  - `text-fill`：`#RRGGBB`（不接受 `none`）

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `<value>` 不在 `<attr>` 對應的值域內 | `failed` |
| 指定範圍內沒有任何儲存格（例如範圍完全落在表格外） | `failed` |

**範例**

```
co-motion table cell style set pres-1 slides/1.svg el-table1 --row 0 --col 0 --row-end 0 --col-end 3 align center
```

## `table merge`

**語法**

```
co-motion table merge <presentation-id> <slide-path> <element-id> --row <row> --col <col> [--row-span <n>] [--col-span <n>] [--unmerge]
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--row`：數字，必填，目標儲存格（合併範圍左上角）的 0-based 列索引
- `--col`：數字，必填，目標儲存格（合併範圍左上角）的 0-based 欄索引
- `--row-span`：數字，選填，合併後的列跨度；省略時預設 1
- `--col-span`：數字，選填，合併後的欄跨度；省略時預設 1
- `--unmerge`：布林旗標，選填，出現即代表要取消 `(row,col)` 所在既有合併範圍的合併

行為備註：`--row-span 1 --col-span 1`（未加 `--unmerge`）等同執行一次取消合併；若目標本來就未合併，視為無操作並成功返回。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `(row,col)` 不是任何既有儲存格的左上角 | `failed` |
| `--unmerge` 但該儲存格未合併，無法取消合併 | `failed` |
| `--row-span`／`--col-span` 不是正整數 | `failed` |
| 合併範圍超出表格 | `failed` |
| 合併範圍與既有合併重疊（涵蓋到的既有合併未完全落在新範圍內） | `failed` |

**範例**

```
co-motion table merge pres-1 slides/1.svg el-table1 --row 0 --col 0 --row-span 1 --col-span 2
```

## `table col width`

**語法**

```
co-motion table col width <presentation-id> <slide-path> <element-id> --col <col> --width <width> [--keep-total]
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--col`：數字，必填，0-based 欄索引
- `--width`：數字，必填，須為大於 0 的有限數字
- `--keep-total`：布林旗標，選填，出現時右邊相鄰欄吸收寬度差，讓表格總寬維持不變

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--col` 超出範圍 | `failed` |
| `--width` 不是大於 0 的有限數字 | `failed` |
| `--keep-total` 用在最後一欄（右邊沒有欄可吸收差值） | `failed` |
| `--keep-total` 造成右邊那欄小於最小欄寬（2×12+16=40） | `failed` |

**範例**

```
co-motion table col width pres-1 slides/1.svg el-table1 --col 0 --width 220 --keep-total
```

## `table col insert`

**語法**

```
co-motion table col insert <presentation-id> <slide-path> <element-id> --at <index>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--at`：數字，必填，插入位置的 0-based 欄索引，合法範圍為 `0` 到目前欄數（含）；等於目前欄數代表插在最後一欄之後

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--at` 超出範圍 | `failed` |

**範例**

```
co-motion table col insert pres-1 slides/1.svg el-table1 --at 2
```

## `table col delete`

**語法**

```
co-motion table col delete <presentation-id> <slide-path> <element-id> --at <index>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--at`：數字，必填，刪除位置的 0-based 欄索引，合法範圍為 `0` 到目前欄數 − 1

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--at` 超出範圍 | `failed` |
| 表格只剩一欄時不可刪除 | `failed` |

**範例**

```
co-motion table col delete pres-1 slides/1.svg el-table1 --at 2
```

## `table row insert`

**語法**

```
co-motion table row insert <presentation-id> <slide-path> <element-id> --at <index>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--at`：數字，必填，插入位置的 0-based 列索引，合法範圍為 `0` 到目前列數（含）；等於目前列數代表插在最後一列之後

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--at` 超出範圍 | `failed` |

**範例**

```
co-motion table row insert pres-1 slides/1.svg el-table1 --at 1
```

## `table row delete`

**語法**

```
co-motion table row delete <presentation-id> <slide-path> <element-id> --at <index>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--at`：數字，必填，刪除位置的 0-based 列索引，合法範圍為 `0` 到目前列數 − 1

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--at` 超出範圍 | `failed` |
| 表格只剩一列時不可刪除 | `failed` |
| 該列是綁定資料來源的模板列，不可直接刪除（須先解除綁定） | `failed` |

**範例**

```
co-motion table row delete pres-1 slides/1.svg el-table1 --at 1
```

## `table theme set`

**語法**

```
co-motion table theme set <presentation-id> <slide-path> <element-id> <theme>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `<theme>`：字串，必填，值域固定為 `dark`、`light`、`zebra`

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `<theme>` 不是 `dark`／`light`／`zebra` 之一 | `failed` |

**範例**

```
co-motion table theme set pres-1 slides/1.svg el-table1 zebra
```

## `table header set`

**語法**

```
co-motion table header set <presentation-id> <slide-path> <element-id> <true|false>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `<true|false>`：字串，必填，只接受 `true` 或 `false`；不合法值在 CLI 參數解析階段即中止，不會進入 dispatch（因此沒有 `failureKind`）

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |

**範例**

```
co-motion table header set pres-1 slides/1.svg el-table1 false
```

## `table bind`

**語法**

```
co-motion table bind <presentation-id> <slide-path> <element-id> --source <virtual-csv-path> [--template-row <row>]
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--source`：字串，必填，簡報內部的虛擬路徑，指向一個 CSV 檔案（例如 `assets/data/sales.csv`）
- `--template-row`：數字，選填，0-based 列索引，指定哪一列作為展開用的模板列（在既有 generated 列被剝除、且套用尚未展開前的列編號上計算）。省略時的預設規則：先找第一個內容含有 `{{ }}` 佔位符的非表頭列當模板列；找不到就取（剝除 generated 列後）最後一列；若表格有表頭且只剩表頭一列，沒有可當模板的列則報錯

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--source` 對應的 CSV 檔案不存在 | `not-found` |
| CSV 內容格式錯誤（引號未封閉、標頭欄名空白或重複、資料列欄數與標頭不符、內容完全空白） | `failed` |
| `--template-row` 超出範圍 | `failed` |
| `--template-row` 指到表頭列 | `failed` |
| 表格只有表頭列、沒有可當模板的列（且未指定 `--template-row`） | `failed` |
| 模板格中的 `{{ 欄名 }}` 在 CSV 標頭找不到對應欄，或 `{{ }}` 內為空白名稱 | `failed` |

**範例**

```
co-motion table bind pres-1 slides/1.svg el-table1 --source assets/data/sales.csv --template-row 1
```

## `table refresh`

**語法**

```
co-motion table refresh <presentation-id> <slide-path> <element-id>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上（無額外旗標；來源路徑與模板列沿用該表格先前 `table bind` 記錄的值）

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| 表格尚未綁定任何資料來源（未執行過 `table bind`） | `failed` |
| 先前綁定的來源 CSV 檔案已不存在 | `not-found` |
| CSV 內容格式錯誤 | `failed` |
| 表格沒有模板列（模板列已被手動移除或改動） | `failed` |
| 模板格中的 `{{ 欄名 }}` 在 CSV 標頭找不到對應欄，或 `{{ }}` 內為空白名稱 | `failed` |

**範例**

```
co-motion table refresh pres-1 slides/1.svg el-table1
```

## `table set`

**語法**

```
co-motion table set <presentation-id> <slide-path> <element-id> (--from <virtual-csv-path> | --markdown <text> | --markdown-file <path>)
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--from`：字串，三選一，簡報內部的虛擬路徑，指向一個 CSV 檔案；以此重建整張表格（含表頭）
- `--markdown`：字串，三選一，字面 Markdown 表格文字
- `--markdown-file`：字串，三選一，本地檔案系統路徑，讀取其內容當 Markdown 表格文字
- `--from`、`--markdown`、`--markdown-file` 必須恰好提供其中一種；提供 0 個或 2 個以上會在 CLI 參數解析階段直接中止，不進入 dispatch（因此沒有 `failureKind`）

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--from` 對應的 CSV 檔案不存在 | `not-found` |
| `--from` 的 CSV 內容格式錯誤 | `failed` |
| `--markdown-file` 指定的檔案不存在 | `not-found` |
| `--markdown`／`--markdown-file` 的 Markdown 表格格式錯誤（缺對齊列、資料列欄數與標頭不符） | `failed` |

**範例**

```
co-motion table set pres-1 slides/1.svg el-table1 --markdown-file ./table.md
```

## `table cell copy`

**語法**

```
co-motion table cell copy <presentation-id> <slide-path> <element-id> --range <r,c:r,c>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--range`：字串，必填，格式為 `r,c:r,c`（兩個 `row,col` 座標，皆為非負整數）；兩端座標可任意順序給，套用時會自動正規化成 top/left/bottom/right

本命令從不修改簡報內容。

**成功 `data`**

```json
{ "tsv": "a\tb\nc\td" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--range` 格式不符合 `r,c:r,c`（非負整數） | `failed` |
| `--range` 超出表格實際列／欄數 | `failed` |

**範例**

```
co-motion table cell copy pres-1 slides/1.svg el-table1 --range 0,0:2,1
```

## `table cell cut`

**語法**

```
co-motion table cell cut <presentation-id> <slide-path> <element-id> --range <r,c:r,c>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--range`：字串，必填，格式同 `table cell copy` 的 `--range`

行為備註：先讀出範圍內容當回傳值，再把範圍內每個實際存在的儲存格文字清空（其餘樣式與合併狀態不變）；一次呼叫只產生一個復原步驟。

**成功 `data`**

```json
{ "tsv": "a\tb\nc\td" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--range` 格式不符合 `r,c:r,c`（非負整數） | `failed` |
| `--range` 超出表格實際列／欄數 | `failed` |

**範例**

```
co-motion table cell cut pres-1 slides/1.svg el-table1 --range 0,0:2,1
```

## `table cell paste`

**語法**

```
co-motion table cell paste <presentation-id> <slide-path> <element-id> --at <r,c> --tsv-file <path>
```

**參數**

- `<presentation-id>` / `<slide-path>` / `<element-id>`：同上
- `--at`：字串，必填，格式為 `r,c`（貼上起點，兩個非負整數）
- `--tsv-file`：字串，必填，本地檔案系統路徑，讀取其內容當作要貼上的 TSV 文字

行為備註：貼上範圍會被裁切在表格目前的列／欄數之內，不會擴張表格；TSV 每一列若長度不足，會以空字串補到該 TSV 本身最寬那一列的寬度，而不是保留目標儲存格原本的文字。

**成功 `data`**

```json
{ "cells": 6 }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `<presentation-id>` 不存在 | `not-found` |
| `<slide-path>` 對應的檔案不存在 | `not-found` |
| `<slide-path>` 存在但未列在該簡報的投影片／範本清單中 | `failed` |
| 投影片內容不符合規範 | `failed` |
| `<element-id>` 不存在 | `failed` |
| `<element-id>` 存在但不是表格 | `failed` |
| `--tsv-file` 指定的檔案不存在（讀檔失敗一律視為「找不到來源檔案」，不區分實際原因） | `failed` |
| `--at` 格式不符合 `r,c`（非負整數），或不是非負整數座標 | `failed` |
| `--at` 超出表格實際列／欄數 | `failed` |
| TSV 內容為空字串 | `failed` |

**範例**

```
co-motion table cell paste pres-1 slides/1.svg el-table1 --at 1,0 --tsv-file ./cells.tsv
```
## `plan set`

**語法**

```
co-motion plan set <presentation-id> <name> <content>
```

**參數**

- `presentation-id`：字串，必填。
- `name`：位置引數，必填，只能是 `outline`（寫 `plan/outline.md`）或 `design-spec`（寫 `plan/design-spec.md`）。
- `content`：位置引數，必填，檔案全文。開頭必須是一個 ```` ```json ```` 圍欄（機器可讀段），其後可接任意 markdown 正文。寫入前會解析並驗證 JSON 段：`outline` 要有 `status`（`draft`｜`confirmed`）、`mode`（`pyramid`｜`narrative`｜`instructional`｜`showcase`｜`briefing`）、非空的 `pages`（每項 `n` 從 1 連續遞增、`type` ∈ cover｜section｜bullets｜compare｜number｜closing、`rhythm` ∈ anchor｜dense｜breathing、`title`），選填 `questions`（每題 `id` 唯一、`question`、`recommended` 必須是 2～4 個 `options` 之一的 `value`、選填 `note` 與 `free_text`）；`design-spec` 要有 `density`（`presentation`｜`balanced`｜`text`）、`palette`（七個角色 `background`／`secondary_bg`／`primary`／`accent`／`secondary_accent`／`text`／`muted`，皆為大寫 `#RRGGBB`）、`type_scale`（九個角色 `cover`／`section`／`number`／`claim`／`title`／`subtitle`／`body`／`column`／`caption`，皆為正數）。任何一項不合就拒絕、不落地。計畫檔不是投影片內容，**不進 undo 歷史**（ADR-0018）。

**成功 `data`**

```json
{ "path": "plan/outline.md" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `name` 不是 `outline` 或 `design-spec` | `failed` |
| `content` 沒有 ```` ```json ```` 圍欄、JSON 無法解析、或任一欄位不合上述規則 | `failed` |

**範例**

```
co-motion plan set pres-1 outline '```json
{ "status": "draft", "mode": "pyramid", "pages": [ { "n": 1, "type": "cover", "rhythm": "anchor", "title": "封面" } ] }
```

## 第 1 頁
封面的主張與聽眾變化。'
```

## `plan list`

**語法**

```
co-motion plan list <presentation-id>
```

**參數**

- `presentation-id`：字串，必填。

**成功 `data`**

```json
{ "plans": [ { "file": "plan/outline.md", "status": "draft" }, { "file": "plan/design-spec.md" } ] }
```

`outline.md` 在時先列並帶 `status`；`design-spec.md` 沒有 `status` 欄。沒有任何計畫檔時 `plans` 是空陣列，仍然成功。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| 計畫檔存在但 JSON 段不合規則（例如被手動改壞） | `failed` |

**範例**

```
co-motion plan list pres-1
```

## `plan delete`

**語法**

```
co-motion plan delete <presentation-id> [name]
```

**參數**

- `presentation-id`：字串，必填。
- `name`：位置引數，選填，`outline` 或 `design-spec`；省略時刪除整個 `plan/` 目錄。不進 undo 歷史。

**成功 `data`**

```json
{}
```

與 `template delete` 相同：`data` 欄位完全不存在，只印 `message`。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `name` 不是 `outline` 或 `design-spec` | `failed` |
| 指定的計畫檔不存在，或省略 `name` 時沒有 `plan/` 目錄 | `not-found` |

**範例**

```
co-motion plan delete pres-1
co-motion plan delete pres-1 outline
```

## `validate`

**語法**

```
co-motion validate <presentation-id> [slide-path]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：位置引數，選填，必須在 `slides` 清單裡；省略時驗整份（含跨頁規則）。

規則寫死在 Rust 裡，門檻依 `plan/design-spec.md` 的 `density` 選組（presentation：標題 ≤ 24 字、要點 ≤ 32 字且 ≤ 2 行、2～7 條、全頁 ≤ 1000 字；balanced：32／48／3 行／2～8／1400；text：40／64／4 行／2～9／2000；門檻刻意寫鬆——放不下的版面由 `geometry.*` 擋，這裡只攔明顯誇張的那種；字數不含空白，`{{ … }}` 動態文字佔位算 0 字），配色、字級表、`shape_language`（選填，`plain`／`swiss-minimal`／`soft-rounded`／`glass`／`paper-cut`／`ink-wash`／`chalkboard`／`sketch-notes`／`brutalist`／`data-dense` 之一，省略時為 `plain`；它只描述形狀行為、不含顏色）與 `layout` 錨點（`side_margin` / `bottom_margin` / `footer_margin` / `gutter` / `spacing`，整組可省略，省略時分別是 80／72／16／24／`[8,16,24,40,64]`；寫了就必須是合法數字）也從它讀——`geometry.*` 的安全區邊界取自前三個，沒有 design-spec 時才用同樣的預設值；頁數、關係、頁型、節奏從 `plan/outline.md` 讀（每頁必填 `relationship` ∈ order／link／parent／membership／contrast／overlap／none；`type` 選填，只有填了才驗 `roster.page-type` 與 `structure.template`）。`rhythm.repeated-shape`（需 outline）：相鄰兩頁的 `relationship` 相同、`blueprint.shape` 相同、`blueprint.nodes` 也相同時報錯。`blueprint.required`（需 outline）：`status` 是 `confirmed` 時每頁都必須有 `blueprint`。`role.required`（需 outline）：`relationship` 不是 `none` 的頁面至少要有一個 `data-comot-role="node"` 的元素。`role.garnish-animated`（不需計畫）：`data-comot-role="garnish"` 的元素不得是任何 `<comot:effect>` 的 `target`。`roster.relationship-variety`（需 outline）：4 頁以上的簡報，單一 `relationship` 不得超過總頁數的一半。沒有計畫檔時只跑不需要計畫的規則（`geometry.*`、`structure.background`、`structure.notes`、`taboo.*`），`message` 加註「（沒有 plan/ 計畫檔，只驗幾何與骨架）」。`rule` 的固定值：`text.title-length`、`text.bullet-length`、`text.bullet-lines`、`text.bullet-count`、`text.page-total`、`focus.single-title`、`geometry.right-overflow`、`geometry.bottom-overflow`、`geometry.text-overlap`、`style.font-size`、`style.text-fill`、`style.shape-fill`、`structure.background`、`structure.notes`、`structure.template`、`roster.page-count`、`roster.page-type`、`rhythm.breathing-cards`、`motion.transition`、`motion.enter`、`structure.scrim`、`structure.background-image`、`role.garnish-meaning`、`role.spine-count`、`role.edge-endpoints`、`role.node-label`、`blueprint.required`、`blueprint.nodes`、`blueprint.steps`、`role.required`、`role.garnish-animated`、`rhythm.repeated-shape`、`roster.relationship-variety`、`taboo.thank-you`、`taboo.duplicate-cover`、`taboo.stroke`。字級 ≤ 字級表 `caption` 的文字框（頁尾）允許延伸到畫布底 − 16·k，其餘文字框到畫布底 − 72·k。`structure.scrim`（需 design-spec）：頁面有 `data-comot-role="background"` 元素時，每個文字框（字級 ≤ caption 的頁尾與字級 ≥ claim 的大字除外）必須完全落在一個文件順序在它之前、fill 為 background 或 secondary_bg、opacity ≥ 0.6 的 rect 之內。背景圖元素本身不受任何規則約束。`blueprint.*`（需 outline）：`plan/outline.md` 的每頁可選擇性帶一個 `blueprint` 物件（非空字串 `shape`，加上非負整數 `nodes` 與 `steps`；寫了就必須完整）。有 blueprint 的頁面，`data-comot-role="node"` 的元素數必須等於 `nodes`，`on-click` 的 enter 效果數必須等於 `steps`。`role.*`（不需計畫）：元素可選擇性宣告 `data-comot-role`（`field`／`node`／`spine`／`edge`／`label`／`garnish`，另有 CLI 自己寫的 `background`）；沒有宣告的頁面驗法不變，有宣告則必須自洽——`garnish` 不得是文字框、一頁至多一條 `spine`、有 `edge` 時至少兩個 `node`、`label` 數不少於當作色塊的 `node`。文字框宣告上的角色會由 `slide add --svg`／`slide set --svg` 帶到正規化後的元素上；不在清單上的角色直接拒絕。`structure.background-image`（需 outline）：`plan/outline.md` 的 `background` 是 `on`（缺省值）時，每一頁都必須有 `data-comot-role="background"` 的元素。

**成功 `data`**

```json
{ "checked": 6, "errors": [ { "slide": "slides/002.svg", "element": "el-abc", "rule": "text.bullet-length", "actual": "37 字", "limit": "≤ 32 字", "message": "第 2 頁要點第 3 條 37 字，上限 32 字" } ] }
```

`element` 對整頁規則為 `null`。`message` 是 `共 N 頁，M 個錯誤`。**有錯誤時 exit code 是 1**，但 `ok` 仍為 `true`、報告照常印出——與 `effect list` 的空清單同理，非零代表「有發現」，不是故障。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在 `slides` 清單裡 | `not-found` |
| 計畫檔存在但 JSON 段不合規則 | `failed` |

**範例**

```
co-motion validate pres-1
co-motion validate pres-1 slides/003.svg
```

## `effect add`

**語法**

```
co-motion effect add <presentation-id> <slide-path> <element-id>[,<element-id>...] --family <enter|emphasis|exit|path|media> --effect <effect-name> [--start <on-click|with-previous|after-previous>] [--duration <秒數>] [--delay <秒數>] [--d <svg-path-data>] [--index <n>]
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。可指向一般投影片或範本（`template add` 建立的 `templates/*.svg`）——底層只要求路徑存在於 `project.json` 的 `slides` 或 `templates` 之一即可，不限投影片。
- `element-id`：逗號分隔清單、必填、至少一個。每個 id 在寫入前會逐一確認存在，任何一個不存在都會讓整個指令失敗、不寫入任何一項（all-or-nothing）。清單中出現空字串（例如 `"a,,b"` 或結尾逗號）會在 argv 解析層直接報錯，不會走到這裡的 `not-found` 判斷。
- `--family`：必填、固定集合 `enter | emphasis | exit | path | media`。此值在 argv 解析層就會做集合檢查，不合法值直接以未結構化錯誤結束（exit code 1、無 `failureKind`），不會進入下面的錯誤情境表。
- `--effect`：必填、字串。合法值依 `--family`而定（argv 層不檢查，由 handler 檢查）：`enter` → `appear|fade|fly-up|fly-left|zoom`；`emphasis` → `pulse|spin|grow`；`exit` → `disappear|fade-out|zoom-out`；`path` → `path`；`media` → `play|pause`。
- `--start`：選填、固定集合 `on-click | with-previous | after-previous`（argv 層即檢查集合，同 `--family`）。省略時，清單中第一個 `element-id` 用 `"on-click"`；`element-id` 有多個時，第二個以後一律被強制改成 `"with-previous"`（無論 `--start` 給了什麼值）——一次 `effect add` 呼叫只會替第一個元素套用你指定的 `--start`。
- `--duration`：選填、數字（秒），須 `>= 0` 且為有限數。省略時依 `--family` 給預設：`media` 為 `0`，其餘為 `0.6`。
- `--delay`：選填、數字（秒），須 `>= 0` 且為有限數。省略時預設 `0`。
- `--d`：選填、字串（SVG path data）。`--family path` 時必填（缺少會報錯）；其他 family 給了會被原樣保留但不使用。
- `--index`：選填、1-based 整數插入位置。省略時預設為「附加到清單最後」（等同目前效果項數 + 1）；範圍必須落在 `1` 到「目前效果項數 + 1」之間（含兩端），超出則報錯。若這張投影片原本沒有效果清單，「目前效果項數」視為 0（即只能是 1）。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在（虛擬檔案系統找不到這個檔案） | `not-found` |
| `slide-path` 存在但既不是 `slides` 也不是 `templates` 清單裡的項目 | `failed` |
| `element-id` 清單中有任一 id 在這張投影片裡找不到（比對整個投影片的 id，不限特定容器） | `not-found` |
| `--effect` 的值不屬於 `--family` 允許的集合 | `failed` |
| `--family` 是 `path` 但沒有給 `--d` | `failed` |
| `--duration` 或 `--delay` 是負數或非有限數 | `failed` |
| `--index` 超出 `1`..`目前效果項數+1` 的範圍 | `failed` |

**不確定與保留事項（非本表格式化項目，附加說明）**：核心寫入邏輯（`addEffects`/`insertEffectItems`）並不檢查「一份效果清單的第一項 `start` 必須是 `on-click`」這條結構性不變量——若在既有清單第 1 項之前插入一個 `--start with-previous` 的新項（或用 `--index 1` 搭配非 `on-click` 值），指令會成功寫入,不報任何錯，直到之後有人呼叫 `deriveSteps`（`packages/web/src/player-plan.ts` 等播放/匯出路徑才會用到）時才會炸开。CLI 這一層本身沒有這個檢查，因此本規格不把它列進上面的錯誤情境表。

**範例**

```
co-motion effect add pres-1 slides/001.svg el-a,el-b --family enter --effect fade --duration 0.8
```

## `effect remove`

**語法**

```
co-motion effect remove <presentation-id> <slide-path> <index>[,<index>...]
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填（同樣可以是 `slides` 或 `templates` 路徑）。
- `index`：逗號分隔的 1-based 整數清單、必填、至少一個。每個 token 必須是合法整數（非整數在 argv 解析層就報錯，exit code 1、無 `failureKind`）。重複的 index 會先用 `Set` 去重，不會報錯；去重後由大到小依序刪除，因此刪除多個項目時彼此的位移不會互相干擾。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| 這張投影片沒有效果清單（從未 `effect add` 過） | `not-found` |
| `index` 清單中有任一值 `< 1` 或大於目前效果項數 | `failed` |

**範例**

```
co-motion effect remove pres-1 slides/001.svg 2,3
```

## `effect move`

**語法**

```
co-motion effect move <presentation-id> <slide-path> <index> <up|down>
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `index`：1-based 整數、必填。非整數在 argv 解析層就報錯（exit code 1、無 `failureKind`）。
- `direction`：固定集合 `up | down`、必填（argv 層即檢查集合，不合法值同樣是 exit code 1、無 `failureKind`）。

行為說明：`index` 對應的項目與相鄰一項（`up` 是往前一項、`down` 是往後一項）整組屬性互換位置。若移動方向已經到邊界（例如對第 1 項執行 `up`，或對最後一項執行 `down`），指令視為**合法的 no-op**，成功回傳、投影片內容不變，不報錯。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| 這張投影片沒有效果清單 | `not-found` |
| `index` `< 1` 或大於目前效果項數 | `failed` |

**範例**

```
co-motion effect move pres-1 slides/001.svg 2 up
```

## `effect set`

**語法**

```
co-motion effect set <presentation-id> <slide-path> <index> [--effect <effect-name>] [--start <on-click|with-previous|after-previous>] [--duration <秒數>] [--delay <秒數>] [--d <svg-path-data>]
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `index`：1-based 整數、必填。非整數在 argv 解析層就報錯（exit code 1、無 `failureKind`）。
- `--effect`：選填、字串。只能改成**目前這一項 `family` 允許的其他 `effect` 值**（`family` 本身不可透過 `set` 更改——換 family 要 `remove` + `add`）；給了一個不屬於現有 family 的值會報錯。
- `--start`：選填、固定集合 `on-click | with-previous | after-previous`（argv 層即檢查集合）。
- `--duration`：選填、數字（秒），須 `>= 0` 且為有限數。
- `--delay`：選填、數字（秒），須 `>= 0` 且為有限數。
- `--d`：選填、字串。只有這一項的 `family` 本來就是 `"path"` 時才能設定，否則報錯。
- 五個選填欄位（`--effect`/`--start`/`--duration`/`--delay`/`--d`）**至少要給一個**，一個都沒給會報錯。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| 這張投影片沒有效果清單 | `not-found` |
| `index` `< 1` 或大於目前效果項數 | `failed` |
| 一個欄位都沒給（`--effect`/`--start`/`--duration`/`--delay`/`--d` 全部省略） | `failed` |
| `--effect` 的值不屬於這一項現有的 `family` | `failed` |
| `--d` 給了，但這一項的 `family` 不是 `path` | `failed` |
| `--duration` 或 `--delay` 是負數或非有限數 | `failed` |
| 這一項的 `family` 屬性本身已損毀（不在已知集合裡） | `failed` |

**不確定與保留事項**：與 `effect add` 相同，`setEffect` 不檢查「清單第一項 `start` 必須是 `on-click`」——把第 1 項的 `--start` 改成 `with-previous`/`after-previous` 會成功寫入，不報錯。

**範例**

```
co-motion effect set pres-1 slides/001.svg 1 --duration 1.2 --start after-previous
```

## `effect list`

**語法**

```
co-motion effect list <presentation-id> <slide-path>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須列在該簡報 `project.json` 的 `slides` 清單裡（範本不適用）。

**成功 `data`**

```json
{
  "effects": [
    { "target": "el-p5-b", "family": "enter", "effect": "fade",
      "start": "on-click", "duration": 0.6, "delay": 0, "index": 1 }
  ],
  "steps": [
    { "effects": [
        { "target": "el-p5-b", "family": "enter", "effect": "fade",
          "start": "on-click", "duration": 0.6, "delay": 0, "index": 1 }
      ] }
  ],
  "transition": {
    "enter": { "effect": "none", "duration": 0.6 },
    "exit":  { "effect": "none", "duration": 0.5 }
  }
}
```

- `effects[]`：這張投影片的完整效果清單，依播放順序（等同 XML 文件順序）。`index` 是 **1-based**（`effect move`／`set`／`remove` 也吃 1-based `index`，兩者一致）；`d` 欄位只在 `family === "path"` 時才會出現，其餘 family 即使 XML 上有這個屬性也不會被驗證或使用（但寫入時逐字保留）。
- `steps[]`：由 `effects[]` **推導**而來，不是儲存在檔案裡的獨立資料（ADR-0008）——`start === "on-click"` 的項目開啟一個新的 step，`with-previous`／`after-previous` 併入目前的 step。空效果清單回傳 `steps: []`。**`steps[].effects[]` 內的物件與頂層 `effects[]` 是同一個形狀、同一個 1-based `index`**，不是重新編號的子清單索引。
- `transition`：**一律存在**，不是 `null`、不是省略。這張投影片沒有 `<comot:transition>` 時，回傳的是「缺席時的預設值」（`enter: { effect: "none", duration: 0.6 }`、`exit: { effect: "none", duration: 0.5 }`），語意上與「顯式設定成這個值」不可區分。
- `duration`／`delay` 一律是秒的數字；屬性缺席時填預設值（`family === "media"` 的效果預設 `duration: 0`，其餘 family 預設 `duration: 0.6`；`delay` 一律預設 `0`）。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| 這張投影片還沒有任何 `<comot:effects>` 清單（從未新增過效果） | `not-found` |
| 清單裡任一項缺少必要屬性（`target`／`family`／`effect`／`start`） | `failed` |
| `family`、`effect`、或 `start` 的值不在各自的固定集合裡 | `failed` |
| `family === "path"` 但缺少 `d` 屬性 | `failed` |
| `duration`／`delay` 屬性存在但不是合法的非負秒數（含屬性存在但為空字串的情形） | `failed` |
| 某一項的 `target` 指向的元素不存在於這張投影片 | `failed` |
| 清單第一項的 `start` 不是 `on-click`（沒有前面的 step 可以併入） | `failed` |
| 這張投影片的 `<metadata>` 裡出現一組以上的 `<comot:effects>`（結構已損毀） | `failed` |

> 「這張投影片還沒有效果清單」是 `not-found`，這與其餘 `effect` 系列命令（`add` 之外，即 `remove`／`move`／`set`）共用同一個判斷：`effect list` 對一份「從未加過任何效果」的投影片回報 `not-found`，不是回傳 `effects: []` 的空清單——只有 `effect add` 會在清單不存在時建立它。清單存在但為空（理論上：曾經加過又全部移除，`<comot:effects>` 元素還在但沒有子節點）則正常回傳 `effects: []`、`steps: []`，不是錯誤。清單內容本身損毀（上表其餘各列）一律歸類為 `failed`，因為那是「內容不合法」而非「找不到清單」。

**範例**

```
co-motion effect list pres-abc123 slides/001.svg
```
## `chart create`

**語法**

```
co-motion chart create <presentation-id> <slide-path> [--type <bar|hbar|line|area|pie|donut>] [--series <n>] [--categories <n>] [--palette <brand|cool|warm>] [--x <n>] [--y <n>] [--width <n>] [--height <n>]
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `--type`：選填、固定集合 `bar | hbar | line | area | pie | donut`；省略預設 `bar`。此值不在 argv 層檢查，不合法值由 handler 判斷。
- `--series`：選填、整數，範圍 `1`..`4`（`chart create` 專用的較窄上限，跟 `chart data set` 的 `1`..`12` 不同）；省略預設 `1`。
- `--categories`：選填、整數，範圍 `2`..`12`（同樣是 `chart create` 專用的較窄上限）；省略預設 `6`。
- `--palette`：選填、固定集合 `brand | cool | warm`；省略預設 `brand`。
- `--x` / `--y`：選填、數字（投影片座標），必須是有限數；省略時分別預設為投影片 `viewBox` 寬度的 `54%`、高度的 `16%`。
- `--width` / `--height`：選填、數字，必須是大於 0 的有限數；省略時分別預設為投影片 `viewBox` 寬度的 `38%`、高度的 `66%`。
- 圖表資料是依 `--series`/`--categories` 用固定公式（`30 + 60·|sin(j·1.3+i)|`）產生的示範資料，類別名稱固定是 `C1`、`C2`…，系列名稱固定是 `Series 1`、`Series 2`…；要換成真實資料要另外呼叫 `chart data set`。新建的圖表固定是 `stacked=false`、`axes=single`、`legend=bottom`、`grid=true`、`labels=true`、`x-title`/`y-title` 皆為空字串。

**成功 `data`**

```json
{ "elementId": "string" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| 投影片根節點不是 `<svg>`，或缺少 `viewBox`／`viewBox` 不是四個數字 | `failed` |
| `--type` 不屬於固定集合 | `failed` |
| `--series` 不是整數，或不在 `1`..`4` 範圍 | `failed` |
| `--categories` 不是整數，或不在 `2`..`12` 範圍 | `failed` |
| `--palette` 不屬於固定集合 | `failed` |
| `--x`/`--y` 不是有限數 | `failed` |
| `--width`/`--height` 不是大於 0 的有限數 | `failed` |

**範例**

```
co-motion chart create pres-1 slides/002.svg --type line --series 2 --categories 5
```

## `chart data set`

**語法**

```
co-motion chart data set <presentation-id> <slide-path> <element-id> (--categories <c1,c2,...> --series 'name=v1,v2,...' (可重複) | --csv <path|-> | --csv-asset <虛擬路徑>)
```

**參數**

- `presentation-id` / `slide-path` / `element-id`：字串，必填；`element-id` 必須指向該投影片內一個圖表元素。
- 資料來源**恰好擇一**：
  - `--categories <c1,c2,...>` 搭配一或多個 `--series 'name=v1,v2,...'`（可重複，每個系列一個旗標）；`values` 是逗號分隔數字列。
  - `--csv <path|->`：`path` 是本機檔案系統路徑，或字面字串 `-` 代表從標準輸入讀取（見通則「`-` 代表標準輸入」）。內容須是 RFC 4180 引號規則的 CSV（系列名可含逗號）、可有可無 BOM（會被去除）、`\r\n` 與 `\n` 皆可、忽略結尾空行；第一欄是類別名稱，其餘欄是各系列名稱與數值。
  - `--csv-asset <虛擬路徑>`：容器內 `assets/` 下某個 CSV 檔案的虛擬路徑；內容走同一支 CSV 剖析邏輯。
  - 三選一是**驗證過的不變式**，不是三個各自獨立、恰巧只會給一個的旗標：命令列呼叫時，給 0 種或 2 種以上會在解析階段就直接失敗（見下方說明）；透過 `co-motion serve` 直接以結構化輸入呼叫時，同樣必須恰好給一種，違反時回傳失敗。
- `--csv -`：CLI 入口層會在 `dispatch` 之前把 `-` 代換成讀出的 stdin 全文，走內部欄位 `csvText`（不是 `csv`）。`co-motion serve` 沒有終端機 stdin 可讀——若 handler 收到未被代換、字面值恰為 `"-"` 的 `csv`，必須直接失敗，訊息意義為「`--csv -` 只能從命令列使用」。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但未列在該簡報的 `slides`／`templates` 清單裡 | `failed` |
| `element-id` 在該投影片裡找不到，或找到但不是圖表元素（缺少 `data-comot-type="chart"`） | `failed` |
| 三種資料來源給了 0 種或 2 種以上 | `failed` |
| `--csv <path>` 指定的本機檔案不存在 | `not-found` |
| `--csv-asset <虛擬路徑>` 在容器內找不到 | `not-found` |
| `--csv -` 但標準輸入是空的 | `failed` |
| 經由 `serve` 直接呼叫、且 `csv` 的值恰為未代換的 `"-"` | `failed` |
| CSV／`--categories`＋`--series` 內容不合法（欄數不齊、數值欄含非數字、類別清單為空、任一系列沒有任何值、系列名稱為空字串） | `failed` |

> **本規格的定案**：「恰好一種」的驗證放進 handler 本身（`serve` 與 CLI 都經過的同一層），而不是只在 argv 解析時擋一次，讓兩條呼叫路徑的行為一致。
>
> **`element-id` 不存在／不是圖表元素的 `failureKind` 是 `failed`，不是 `not-found`**。這點與其他圖表命令（`chart type set` 等）、`table` 系列命令、`element` 系列命令一致，但與同一份文件其他地方「找不到某個 id 就是 `not-found`」的直覺不同，特別標注避免誤植。

**範例**

```
co-motion chart data set pres-1 slides/001.svg el-1 --categories Q1,Q2,Q3 --series '營收=100,120,140'
cat sales.csv | co-motion chart data set pres-1 slides/001.svg el-1 --csv -
```
## `chart type set`

**語法**

```
co-motion chart type set <presentation-id> <slide-path> <element-id> <type>
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `element-id`：字串、必填。
- `type`：固定集合 `bar | hbar | line | area | pie | donut`、必填。argv 層不檢查此集合，由 handler 判斷。

切換 `type` 後，整份 `ChartModel` 會重新完整驗證（不只驗證 `type` 這一欄）——例如原本是 `stacked=true` 的長條圖，改成不支援堆疊的 `type`（`line`/`pie`/`donut`）會被拒絕；原本 `axes=dual`，改成 `pie`/`donut`（兩者都要求 `axes=single`）也會被拒絕。這類「改了 type 但跟其他既有欄位衝突」的組合一律回報失敗，不會自動連動調整 `stacked`/`axes`（"不自動改"）。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| `element-id` 在這張投影片找不到 | `failed`（**不是** `not-found`——每一個 chart 子命令的「元素不存在」一律分類為 `failed`） |
| `element-id` 存在，但不是圖表元素（沒有 `data-comot-type="chart"`） | `failed` |
| `type` 不屬於固定集合 | `failed` |
| 新 `type` 與現有 `stacked=true` 不相容（新 type 不在 `bar/hbar/area` 之列） | `failed` |
| 新 `type` 是 `pie`/`donut`，但現有 `axes` 是 `dual` | `failed` |

**範例**

```
co-motion chart type set pres-1 slides/002.svg chart-1 area
```

## `chart palette set`

**語法**

```
co-motion chart palette set <presentation-id> <slide-path> <element-id> <palette> [--color 'name=#hex'] (可重複)
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `element-id`：字串、必填。
- `palette`：固定集合 `brand | cool | warm`、必填。argv 層不檢查此集合。
- `--color`：選填、可重複，格式 `name=#hex`（以第一個 `=` 切開；`#hex` 需符合 `#RGB` 或 `#RRGGBB`）。只覆寫清單中點名的系列顏色，其他系列的顏色（`null` 或先前設定的顏色）維持不變。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| `element-id` 在這張投影片找不到 | `failed`（同上，非 `not-found`） |
| `element-id` 存在但不是圖表元素 | `failed` |
| `palette` 不屬於固定集合 | `failed` |
| `--color` 指定的系列名在圖表裡不存在 | `failed` |
| `--color` 的顏色不符合 `#RGB`/`#RRGGBB` 格式 | `failed` |

**範例**

```
co-motion chart palette set pres-1 slides/002.svg chart-1 cool --color 'Series 1=#3366ff'
```

## `chart axis set`

**語法**

```
co-motion chart axis set <presentation-id> <slide-path> <element-id> <single|dual> [--right <系列名>] (可重複)
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `element-id`：字串、必填。
- `axes`：固定集合 `single | dual`、必填（argv 層以 `requirePositional` 取值標籤為 `single|dual`，但實際值不在 argv 層檢查集合，由 handler 判斷）。
- `--right`：選填、可重複，每個值是一個既有系列名稱。這是「整份取代」語意，不是增量修改：呼叫一次就會把**所有系列**的 axis 重新指派一遍——`--right` 點名的系列變成 `axis="right"`，其餘全部變成 `axis="left"`。
  - `axes=single` 時**不可**給任何 `--right`（給了就報錯）——single 模式下所有系列一律 `axis="left"`。
  - `axes=dual` 時**必須**至少給一個 `--right`，否則報錯（因為一個都不給的 dual 等同 single，沒有意義）。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| `element-id` 在這張投影片找不到 | `failed`（同上，非 `not-found`） |
| `element-id` 存在但不是圖表元素 | `failed` |
| `axes` 不是 `single` 或 `dual` | `failed` |
| `axes=single` 但給了 `--right` | `failed` |
| `axes=dual` 但一個 `--right` 都沒給 | `failed` |
| `--right` 點名的系列名在圖表裡不存在 | `failed` |

**範例**

```
co-motion chart axis set pres-1 slides/002.svg chart-1 dual --right 'Series 2'
```

## `chart stack set`

**語法**

```
co-motion chart stack set <presentation-id> <slide-path> <element-id> <on|off>
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `element-id`：字串、必填。
- `on|off`：固定集合、必填。**此值在 argv 解析層就會檢查**（`on-off !== "on" && !== "off"` 時直接以未結構化錯誤結束，exit code 1、無 `failureKind`），比對到後轉成布林 `stacked`（`on` → `true`，`off` → `false`）交給 handler。

型別/軸相容性檢查（`validateChartModel`）：只有 `type` 為 `bar`/`hbar`/`area` 的圖表可以開啟堆疊；開啟堆疊時 `axes` 必須是 `single`。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| `element-id` 在這張投影片找不到 | `failed`（同上，非 `not-found`） |
| `element-id` 存在但不是圖表元素 | `failed` |
| 開啟堆疊（`on`），但目前 `type` 不是 `bar`/`hbar`/`area` | `failed` |
| 開啟堆疊（`on`），但目前 `axes` 是 `dual` | `failed` |

**範例**

```
co-motion chart stack set pres-1 slides/002.svg chart-1 on
```

## `chart legend set`

**語法**

```
co-motion chart legend set <presentation-id> <slide-path> <element-id> <legend>
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `element-id`：字串、必填。
- `legend`：固定集合 `none | bottom | right`、必填。argv 層不檢查此集合，由 handler 判斷。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| `element-id` 在這張投影片找不到 | `failed`（同上，非 `not-found`） |
| `element-id` 存在但不是圖表元素 | `failed` |
| `legend` 不屬於固定集合 | `failed` |

**範例**

```
co-motion chart legend set pres-1 slides/002.svg chart-1 right
```

## `chart option set`

**語法**

```
co-motion chart option set <presentation-id> <slide-path> <element-id> <key> <value>
```

**參數**

- `presentation-id`：字串、必填。
- `slide-path`：字串、必填。
- `element-id`：字串、必填。
- `key`：固定集合 `grid | labels | x-title | y-title`、必填。argv 層不檢查此集合，由 handler 判斷。
- `value`：字串、必填，意義依 `key` 而定：
  - `key=grid` 或 `key=labels`：只能是字面字串 `"true"` 或 `"false"`，其他值報錯。
  - `key=x-title` 或 `key=y-title`：任意字串都接受，包含空字串（等於清空標題），沒有格式限制。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 存在但不是 `slides`/`templates` 清單裡的項目 | `failed` |
| `element-id` 在這張投影片找不到 | `failed`（同上，非 `not-found`） |
| `element-id` 存在但不是圖表元素 | `failed` |
| `key` 不屬於固定集合 | `failed` |
| `key` 是 `grid`/`labels`，但 `value` 不是 `"true"`/`"false"` | `failed` |

**範例**

```
co-motion chart option set pres-1 slides/002.svg chart-1 x-title '銷售季度'
```

## `slide render`

**語法**

```
co-motion slide render <presentation-id> <slide-path>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須列在該簡報的 `slides` 清單裡。

**成功 `data`**

```json
{ "content": "<這張投影片顯示時態的完整 SVG 內容>" }
```

`content` 與 `cat` 讀同一個虛擬路徑相比，差別只在於 `{{ slide_number }}`／`{{ slide_total }}`／`{{ presentation_name }}` 這類動態文字已經被代換成實際值；除此之外是同一份 SVG 位元組。渲染規則與 `cat` 完全相同（見「Renderer 命令」一節）：預設情況下 `data.content` 原封不動印到 stdout，不加換行、不印 `message`。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| 動態文字代換過程失敗（例如簡報層級的中繼資料缺失導致無法算出 `slide_total`） | `failed` |

**範例**

```
co-motion slide render pres-abc123 slides/001.svg
```

## `font import`

**語法**

```
co-motion font import <presentation-id> <source> --family <家族名> --license <授權> --source <出處> [--license-file <路徑或 URL>]
```

**參數**

- `presentation-id`：字串，必填。
- `source`（位置參數）：字串，必填。開頭是 `http://`／`https://` 時下載，否則視為本機路徑（相對於 CLI 行程的工作目錄），與 `asset import` 的 `source` 同規則。
- `--family`：字串，必填，不可為空。這是之後 `--font-family`／`font-family` 屬性要寫的名字。**同一份簡報內不得重複**（格式規定 `fonts[].family` 唯一）。
- `--license`：字串，必填。授權名稱或全文。
- `--source`（旗標）：字串，必填。字型的出處（通常是下載頁網址）。
- `--license-file`：字串，選填。授權全文的來源（路徑或 URL）；省略時以 `--license` 與 `--source` 的內容寫出一份 `fonts/LICENSE-<檔名>.txt`。

`--license`／`--source` 之所以必填，是因為 `project.json` 的 `FontEntry` 五個欄位都必填（見 `comot-format.md`）：嵌入他人字型的簡報必須帶著它被嵌入時的條款。

容器內的檔名取自**家族名**而非來源檔名（家族唯一，所以不會與既有字型撞名），副檔名沿用來源（`ttf`／`otf`／`ttc`／`woff2`／`woff`，認不出時用 `ttf`）。寫入走 `create_presentation_file`，所以匯入本身可以復原。

**成功 `data`**

```json
{ "family": "Noto Serif TC", "file": "fonts/Noto-Serif-TC.ttf", "licenseFile": "fonts/LICENSE-Noto-Serif-TC.ttf.txt" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| 本機來源檔讀不到 | `not-found` |
| URL 下載失敗 | `failed` |
| 位置參數不是兩個，或缺 `--family`／`--license`／`--source` | `failed` |
| `--family` 已經內嵌於這份簡報 | `failed` |
| 來源不是可解析的字型檔 | `failed` |

**範例**

```
co-motion font import 4Hw4-c-QfUbm https://fonts.example.org/NotoSerifTC-Regular.otf --family 'Noto Serif TC' --license 'SIL Open Font License 1.1' --source 'https://fonts.google.com/noto/specimen/Noto+Serif+TC'
```

## `asset import`

**語法**

```
co-motion asset import <presentation-id> <source> [--as csv]
co-motion asset import <presentation-id> --svg <markup> --name <檔名.svg>
```

**參數**

- `presentation-id`：字串，必填。
- `source`：字串，必填。開頭是 `http://` 或 `https://` 時視為 URL，一律用 `fetch` 下載；否則視為本機檔案系統路徑，用 `readFile` 讀取。**相對路徑合法，相對於 CLI 行程當下的工作目錄解析**（這是凍結現行行為的定案；`packages/server/agent-workdir/reference/commands.md` 目前寫的「本機絕對路徑」是敘述不精確，不是契約，本規格才是準確描述）。
- `--as`：字串，選填。唯一合法值是 `csv`，代表這是一筆資料資產而非媒體資產；給其他任何值都直接失敗。省略 `--as` 時走既有的媒體匯入路徑（byte-for-byte 相容現行行為）。
- `--svg`：字串，選填（#303 §13）。從命令列內容直接建立一個 SVG 資產，與 `source` 位置參數、`--as` 互斥。內容根節點必須是 `<svg>`，不允許 `<script>`／`<foreignObject>`。
- `--name`：字串，只能與 `--svg` 一起給、且必填。只允許 `[A-Za-z0-9_-]+\.svg`；寫入 `assets/<檔名>`，**不做衝突改名**：同名已存在時失敗（背景配方靠路徑重用，靜默改名會破壞重用）。成功 `data` 為 `{ "path": "assets/<檔名>", "mimeType": "image/svg+xml", "kind": "image" }`。

**成功 `data`**

一般媒體匯入：

```json
{ "path": "assets/photo-1.png", "mimeType": "image/png", "kind": "image" }
```

`--as csv` 時：

```json
{ "path": "assets/data/sales.csv", "mimeType": "text/csv", "kind": "data" }
```

`kind` 值域：`image | video | audio | data`。格式判定**只看檔頭位元組，不看副檔名**（ADR-0015）。檔名衝突時，`resolveAssetImport`／`resolveDataAssetImport` 各自在自己的序號空間裡（一般媒體落 `assets/`，資料資產落 `assets/data/`）產生不衝突的檔名，兩者互不干擾。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| 本機來源檔案不存在或讀不到 | `not-found` |
| URL 下載失敗（連線錯誤，例如 DNS 解析失敗或連線被拒） | `failed` |
| URL 回應非 2xx 狀態碼 | `failed` |
| `--as` 給的值不是 `csv` | `failed` |
| 檔頭位元組不符合任何支援的媒體格式（且未給 `--as csv`） | `failed` |
| `--svg` 與 `<source>` 或 `--as` 同時給；`--svg` 缺 `--name`；`--name` 不合格式；`--svg` 根節點不是 `<svg>` 或含禁用元素；`assets/<檔名>` 已存在 | `failed` |

> **本機來源檔案不存在 → `not-found`**：理由是與 `chart data set --csv` 讀本機檔案時 ENOENT 對應到 `CoMotionNotFoundError`（`not-found`）的慣例保持一致。

**範例**

```
co-motion asset import pres-abc123 https://example.com/photo.png
co-motion asset import pres-abc123 ./sales.csv --as csv
```
## `slide add`

**語法**

```
co-motion slide add <presentation-id> [--template <template-path>] [--svg <markup>] [--at <index>]
```

**參數**

- `presentation-id`：字串，必填。
- `--svg`：選填字串，一整頁的 SVG 標記（#303，ADR-0018）：agent 一次寫完一頁，CoMotion 寫入前跑 ingest——根節點必須是 `<svg>`；`viewBox` 省略時補成畫布尺寸、與畫布不同則拒絕；每個直接放在根 `<svg>` 底下、帶 `data-comot-text-width` 的 `<text>`「文字框宣告」會被換成真正的文字框（與 `textbox add` 產出相同的 `<g>` 結構：`x`／`y` 是左上角、內容以換行分段、`data-comot-list` 每段一個 token、`data-comot-text-align` 對齊、`font-size` 省略為 24、`font-family` 省略為 Noto Sans TC；宣告裡不得有子元素）；接著跑與 `convert` 相同的正規化（裸圖元包 `<g>`、補 id、transform 搬上容器），`<script>`／`<foreignObject>`、重複 id 等不可修的問題一律拒絕、不落地。`<defs>`、`<style>`、漸層、濾鏡、clipPath、`path` 皆允許。agent 可以自己給 `id`。與 `--template` 互斥。
- `--template`：選填字串，`project.json` 的 `templates` 清單裡某個範本的虛擬路徑；省略則新增一張空白投影片（依簡報目前畫布尺寸產生一個沒有任何元素的合規 `<svg>`）。套用範本時，範本內容會逐位元組複製，但每個元素的 `id`（以及引用這些 id 的效果/留言 `target`）都會重新產生，避免與範本本身或其他已套用過的投影片重複。
- `--at`：選填，數字字串；省略則附加在最後一張投影片之後。必須是整數，且落在 `0`（清單最前）到「目前投影片總數」（清單最後，等同附加）之間，含端點；只有解析階段檢查「是否為合法數字」，是否為整數與是否落在範圍內是在實際執行時才驗證。

**成功 `data`**

```json
{ "slidePath": "slides/003.svg" }
```

新投影片的虛擬路徑，檔名取「目前 `slides/` 目錄下最小尚未使用的 `NNN.svg` 編號」，不是單純遞增。帶 `--svg` 時多一個 `elementIds`（文件順序的所有頂層容器 id）：

```json
{ "slidePath": "slides/003.svg", "elementIds": ["el-title", "el-a1b2c3d4e5f6"] }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `--template` 指定的路徑完全不存在（既不是範本也不是投影片） | `not-found` |
| `--template` 指定的路徑其實是一張投影片而不是範本 | `failed` |
| `--at` 不是整數，或不在 `0` 到目前投影片總數之間 | `failed` |
| `--svg` 與 `--template` 同時給 | `failed` |
| `--svg` 的根節點不是 `<svg>`、`viewBox` 與畫布不符、文字框宣告含子元素或不在根 `<svg>` 底下、正規化不可修（`<script>`、重複 id…） | `failed` |

**範例**

```
co-motion slide add pres-abc123
co-motion slide add pres-abc123 --template templates/001.svg --at 0
co-motion slide add pres-abc123 --svg '<svg viewBox="0 0 1280 720" style="background-color:#101418"><text id="el-title" data-comot-text-width="1120" x="80" y="72" font-size="40" font-weight="700" fill="#F4F6F8">標題</text></svg>'
```

## `slide set`

**語法**

```
co-motion slide set <presentation-id> <slide-path> --svg <markup>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，`project.json` 的 `slides` 或 `templates` 清單裡的虛擬路徑。
- `--svg`：字串，必填。一整頁的 SVG 標記，ingest 規則與 `slide add --svg` 完全相同。新標記沒有帶 `<metadata>` 時，沿用舊頁的 `<metadata>`（備忘稿、留言、效果、轉場都留下）；帶了就以新的為準。

**成功 `data`**

```json
{ "slidePath": "slides/003.svg", "elementIds": ["el-title"] }
```

整頁覆寫走與 `text set` 相同的歷史紀錄路徑，`undo` 還原成覆寫前的整頁。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡 | `failed` |
| 缺少 `--svg`，或 `--svg` 的內容未通過 ingest（同 `slide add --svg`） | `failed` |

**範例**

```
co-motion slide set pres-abc123 slides/003.svg --svg '<svg viewBox="0 0 1280 720"><text data-comot-text-width="1120" x="80" y="72" font-size="40">改寫後的標題</text></svg>'
```

## `slide background set`

**語法**

```
co-motion slide background set <presentation-id> <slide-path> --asset <assets/檔名> [--opacity <0～1>]
co-motion slide background set <presentation-id> <slide-path> --none
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，`slides` 或 `templates` 清單裡的虛擬路徑。
- `--asset`：字串，`assets/` 底下既有資產的虛擬路徑。在該頁**最底層**（`<metadata>` 之後、所有元素之前）放一個滿版 `<image href x=0 y=0 width=畫布寬 height=畫布高>`，容器固定為 `id="el-background"`、`data-comot-name="背景圖"`、`data-comot-role="background"`、`data-comot-lock="true"`。該頁已有 `data-comot-role="background"` 的元素時整個替換，不重複。
- `--opacity`：數字，選填，0～1，寫在 `<image>` 上。
- `--none`：移除該元素。`--asset` 與 `--none` 必須且只能給一個。

`slide add --svg`／`slide set --svg` 的內容裡若已含 `data-comot-role="background"` 的容器，原樣保留並補上鎖定。這個寫入進入復原歷史。

**成功 `data`**

`--asset`：`{ "elementId": "el-background" }`；`--none`：無 `data`。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不存在；`--asset` 指向的檔案不存在；`--none` 時該頁沒有背景圖 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡；`--asset` 不在 `assets/` 底下；`--opacity` 超出 0～1；`--asset`／`--none` 未擇一 | `failed` |

**範例**

```
co-motion slide background set pres-abc123 slides/002.svg --asset assets/bg-mesh.svg --opacity 0.8
co-motion slide background set pres-abc123 slides/002.svg --none
```

## `slide delete`

**語法**

```
co-motion slide delete <presentation-id> <slide-path>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，**必須是 `project.json` 的 `slides` 清單裡的投影片**（範本路徑不算數，這點跟 `text set` 那一族不同）。允許刪到只剩 0 張投影片；投影片上有鎖定元素也一樣可以刪除整張投影片（ADR-0013 不限制刪除整張投影片這種操作）。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在該簡報的 `slides` 清單裡 | `failed` |

**範例**

```
co-motion slide delete pres-abc123 slides/003.svg
```

## `slide duplicate`

**語法**

```
co-motion slide duplicate <presentation-id> <slide-path>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須是 `slides` 清單裡的投影片（範本路徑不算數）。新投影片會緊接在來源投影片之後插入；除了元素 id（及引用它們的效果/留言 `target`）會重新產生外，包含備忘稿在內的其他內容逐位元組複製。

**成功 `data`**

```json
{ "slidePath": "slides/004.svg" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 其實是一個範本路徑（應改用 `template add --from`） | `failed` |
| `slide-path` 不在該簡報的 `slides` 清單裡（也不是範本） | `failed` |

**範例**

```
co-motion slide duplicate pres-abc123 slides/001.svg
```

## `slide move`

**語法**

```
co-motion slide move <presentation-id> <slide-path> <new-index>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須是 `slides` 清單裡的投影片。
- `new-index`：位置引數，必填，數字字串。解析階段只檢查「是否為合法數字」；是否為整數、是否落在 `0` 到「目前投影片總數 − 1」之間（含端點）是實際執行時才驗證。這個命令只重寫 `project.json` 的 `slides` 順序，不會開啟或改寫任何一張投影片檔案本身的位元組。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在該簡報的 `slides` 清單裡 | `failed` |
| `new-index` 不是整數，或不在 `0` 到「目前投影片總數 − 1」之間 | `failed` |

**範例**

```
co-motion slide move pres-abc123 slides/003.svg 0
```

## `slide notes set`

**語法**

```
co-motion slide notes set <presentation-id> <slide-path> <text>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須是 `slides` 清單裡的投影片（範本沒有備忘稿的顯示時機意義，因此範本路徑在這裡不成立）。
- `text`：位置引數，必填，但**允許空字串 `''`**——空字串是合法值，代表清空該投影片的備忘稿，只有完全省略這個位置才算缺漏。核心層對內容沒有其他格式要求。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在該簡報的 `slides` 清單裡 | `failed` |

**範例**

```
co-motion slide notes set pres-abc123 slides/001.svg '記得先講開場故事'
co-motion slide notes set pres-abc123 slides/001.svg ''
```

## `slide transition set`

**語法**

```
co-motion slide transition set <presentation-id> <slide-path> [--enter none|fade|slide|zoom] [--enter-duration <seconds>] [--exit none|fade|slide|zoom] [--exit-duration <seconds>] [--all]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須是 `slides` 清單裡的投影片；即使搭配 `--all`，這個路徑仍然是「目前先讀取其現有轉場當基準」的那一張。
- `--enter`、`--exit`：選填，固定集合 `none`、`fade`、`slide`、`zoom`；省略則沿用該投影片目前的值。不在此集合內在命令解析階段就報錯。
- `--enter-duration`、`--exit-duration`：選填，秒數（有限數字）；省略則沿用目前的值。命令解析階段只檢查「是否為合法數字」，是否為非負數是實際執行時才驗證。
- `--all`：布林旗標。不加時只寫入 `slide-path` 這一張；加了則把「以上四個欄位覆蓋、其餘沿用 `slide-path` 目前值」解析出的最終轉場設定，套用到簡報裡**每一張**投影片（一個復原步驟）。
- `--enter`、`--enter-duration`、`--exit`、`--exit-duration`、`--all` 至少要出現一個，否則在命令解析階段就報錯（不會進入實際執行）。

**成功 `data`**

```json
{}
```

成功訊息會依是否加 `--all` 而不同（單張投影片 vs. 套用到 N 張投影片），但 `data` 本身兩種情況都是 `{}`。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在該簡報的 `slides` 清單裡 | `failed` |
| `--enter-duration` 或 `--exit-duration` 是負數 | `failed` |

**範例**

```
co-motion slide transition set pres-abc123 slides/001.svg --enter fade --enter-duration 0.4
co-motion slide transition set pres-abc123 slides/001.svg --exit zoom --all
```

## `slide style set`

**語法**

```
co-motion slide style set <presentation-id> <slide-path> [--background <color>] [--accent <color>]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，可以是已登記的投影片或範本（跟 `text set` 那一族一樣，透過 `resolveVirtualFilePath` + 「必須列在 slides 或 templates」檢查，不是走 `slide-ops` 那一族的「只認 slides」規則）。
- `--background`：選填字串，寫入該投影片根 `<svg>` 的 `style` 屬性裡的 `background-color` 宣告。**允許空字串 `''`，代表清除既有的 `background-color` 宣告**，而不是把它設成空字串的顏色值。
- `--accent`：選填字串，同 `--background`，對應的 CSS 宣告是 `--comot-accent`（一個自訂屬性）；空字串 `''` 同樣代表清除。
- `--background`、`--accent` 至少要提供一個，否則在命令解析階段就報錯（不會進入實際執行）。這個寫入會進入復原歷史（跟「頁面尺寸」那個唯一例外不同）。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 對應不到任何檔案 | `not-found` |
| `slide-path` 不在 `slides` 或 `templates` 清單裡 | `failed` |

**範例**

```
co-motion slide style set pres-abc123 slides/001.svg --background '#1a1a2e' --accent '#e94560'
co-motion slide style set pres-abc123 slides/001.svg --background ''
```

## `presentation canvas set`

**語法**

```
co-motion presentation canvas set <presentation-id> --width <數值> --height <數值>
```

**參數**

- `presentation-id`：字串，必填。
- `--width`：數字，必填，正數。
- `--height`：數字，必填，正數。

**成功 `data`**

```json
{ "width": 1920, "height": 1080 }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `--width`／`--height` 不是合法數字（命令解析階段即擋下，不進入 dispatch，無 `failureKind`） | — |
| `--width`／`--height` 不是正數 | `failed` |

**這條命令刻意不佔用任何 undo 步驟**——是通則「Undo 語意」一節唯一的例外（其餘所有寫入類命令都恰好一步 undo）。畫布尺寸屬於簡報層級的整體設定，不是某一步可以個別回退的內容編輯，重新設定一次不會被記錄進復原歷史、也不會被 `undo`/`redo` 影響。

**範例**

```
co-motion presentation canvas set pres-abc123 --width 1920 --height 1080
```
## `template add`

**語法**

```
co-motion template add <presentation-id> [--from <slide-path>] [--name <name>]
```

**參數**

- `presentation-id`：字串、必填。
- `--from`：選填、既有投影片的虛擬路徑（必須已經在 `project.json` 的 `slides` 清單裡，不能是另一個範本）。省略時建立一張空白範本（依簡報畫布尺寸產生空白 SVG）；有給時複製該投影片內容，並替每個元素重新產生 id（`mintElementIds`，避免與來源共用 id）。
- `--name`：選填、字串（會被 trim）。省略時預設用新檔案的檔名（例如 `001`）當名稱；**明確給了但 trim 後是空字串**會報錯（省略跟給空字串是兩種不同情況：省略合法，給空字串不合法）。
- 新範本一律存到 `templates/<編號>.svg`（三位數流水號，跟既有範本/投影片編號互不衝突），並登記進 `project.json` 的 `templates` 陣列——絕不會寫進 `slides`。

**成功 `data`**

```json
{ "templatePath": "string" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `--name` 有給值，但 trim 後是空字串 | `failed` |
| `--from` 指定的路徑不在 `project.json` 的 `slides` 清單裡 | `not-found` |

**範例**

```
co-motion template add pres-1 --from slides/001.svg --name '標題頁範本'
```

## `template list`

**語法**

```
co-motion template list <presentation-id>
```

**參數**

- `presentation-id`：字串、必填。

**成功 `data`**

```json
{ "templates": [ { "file": "templates/001.svg", "name": "string" } ] }
```

`templates` 是 `TemplateEntry[]`，每筆固定兩個欄位：`file`（容器內虛擬路徑）、`name`（使用者可見名稱，允許重複、不做唯一性檢查）。清單順序即 `project.json` 裡 `templates` 陣列的原始順序；空陣列（`[]`）代表這個簡報還沒有任何範本，是合法結果，不是錯誤。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |

**範例**

```
co-motion template list pres-1
```

## `template rename`

**語法**

```
co-motion template rename <presentation-id> <template-path> <new-name>
```

**參數**

- `presentation-id`：字串、必填。
- `template-path`：字串、必填。必須是 `project.json` 的 `templates` 陣列裡某一筆的 `file`。
- `new-name`：字串、必填（可以合法地是空字串——argv 解析層只檢查「有沒有給這個參數」，不檢查它是不是空字串；空字串會在 handler 裡因 trim 後為空而報錯）。只改 `templates[i].name`，絕不改動 SVG 檔案本身或其路徑。允許改成跟另一筆範本相同的名字，不檢查唯一性。

**成功 `data`**

```json
{}
```

實際上這個指令的 handler 回傳 `{ ok: true, message }`，完全沒有設定 `data` 欄位（型別是 `void`，不是「空物件 `{}`」）；`co-motion` bin 只有在 `result.data !== undefined` 時才印出 JSON 區塊，因此這個指令的終端輸出只有 `message` 那一行文字，不會印出任何 JSON。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `new-name` trim 後是空字串 | `failed` |
| `template-path` 不在 `templates` 清單裡，但剛好是 `slides` 清單裡的路徑 | `failed`（訊息「不是範本：`<template-path>`」） |
| `template-path` 既不在 `templates` 也不在 `slides` 清單裡 | `not-found` |

**範例**

```
co-motion template rename pres-1 templates/001.svg '新標題頁'
```

## `template delete`

**語法**

```
co-motion template delete <presentation-id> <template-path>
```

**參數**

- `presentation-id`：字串、必填。
- `template-path`：字串、必填。必須是 `project.json` 的 `templates` 陣列裡某一筆的 `file`。刪除會同時移除 SVG 檔案與 `templates` 陣列裡的登記，包在同一個 history group 裡（一次 undo 兩者一起復原）。依 ADR-0013，刪除範本**不會**去檢查、掃描或警告任何已經套用過這個範本的投影片——範本一旦被套用就與後續投影片無關。

**成功 `data`**

```json
{}
```

與 `template rename` 相同：handler 回傳 `{ ok: true, message }`，`data` 欄位完全不存在（型別 `void`），bin 端不會印出任何 JSON，只印 `message`。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `template-path` 不在 `templates` 清單裡，但剛好是 `slides` 清單裡的路徑 | `failed`（訊息「不是範本：`<template-path>`（刪除投影片請用 slide delete）」） |
| `template-path` 既不在 `templates` 也不在 `slides` 清單裡 | `not-found` |

**範例**

```
co-motion template delete pres-1 templates/001.svg
```
## `comment add`

**語法**

```
co-motion comment add <presentation-id> <slide-path> <target> <text> [--author <name>]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須是 `project.json` 的 `slides` 清單裡的投影片（範本不適用，備忘稿/留言都只對投影片有意義）；而且該投影片必須是「合規」格式（已執行過 `convert`，每個可選取元素都是 `<g id="…">` 容器）——留言功能是建立在這個正規形式上解析元素清單的。
- `target`：位置引數，必填，字面字串 `"page"`（代表整張投影片層級的留言），或該投影片裡某個既有元素的 id。
- `text`：位置引數，必填。命令解析階段允許空字串（只檢查是否「完全省略」），但**核心層會拒絕內容去除頭尾空白後為空的字串**，所以留言內容實際上不能是空白。
- `--author`：選填字串；省略預設 `"agent"`。同樣是去除頭尾空白後不能為空字串。

**成功 `data`**

```json
{ "commentId": "c-a1b2c3d4" }
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在該簡報的 `slides` 清單裡 | `failed` |
| `--author` 去除頭尾空白後為空字串 | `failed` |
| `text` 去除頭尾空白後為空字串 | `failed` |
| 該投影片不是合規格式（尚未 `convert`，或本身結構有問題） | `failed` |
| `target` 不是 `"page"`，且在該投影片裡找不到對應的元素 | `failed` |

**範例**

```
co-motion comment add pres-abc123 slides/001.svg page '整體配色可以再深一點'
co-motion comment add pres-abc123 slides/001.svg el-title '標題字體太小' --author reviewer1
```

## `comment edit`

**語法**

```
co-motion comment edit <presentation-id> <slide-path> <comment-id> <text>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須是 `slides` 清單裡的投影片。
- `comment-id`：位置引數，必填，既有留言的 id（例如 `c-a1b2c3d4`）。
- `text`：位置引數，必填。命令解析階段允許空字串，但核心層會拒絕去除頭尾空白後為空的字串。只替換留言內容，留言的 `created` 時間戳不變。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在該簡報的 `slides` 清單裡 | `failed` |
| `text` 去除頭尾空白後為空字串 | `failed` |
| `comment-id` 在該投影片上找不到 | `not-found` |

**範例**

```
co-motion comment edit pres-abc123 slides/001.svg c-a1b2c3d4 '改過的留言內容'
```

## `comment delete`

**語法**

```
co-motion comment delete <presentation-id> <slide-path> <comment-id>
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：字串，必填，必須是 `slides` 清單裡的投影片。
- `comment-id`：位置引數，必填，既有留言的 id。刪除最後一則留言時，留言容器本身（`<comot:comments>`）會留空，不會被整個移除。

**成功 `data`**

```json
{}
```

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| `slide-path` 不在該簡報的 `slides` 清單裡 | `failed` |
| `comment-id` 在該投影片上找不到 | `not-found` |

**範例**

```
co-motion comment delete pres-abc123 slides/001.svg c-a1b2c3d4
```

## `comment list`

**語法**

```
co-motion comment list <presentation-id> [slide-path]
```

**參數**

- `presentation-id`：字串，必填。
- `slide-path`：位置引數，選填。省略時列出整份簡報所有投影片的留言（依 `project.json` 的 `slides` 順序，同一張投影片內再依文件順序）；有指定時只列出該投影片的留言，且該路徑必須在 `slides` 清單裡（範本不適用）。

**成功 `data`**

```json
{
  "comments": [
    {
      "id": "c-a1b2c3d4",
      "target": "page",
      "author": "agent",
      "created": "2026-01-01T00:00:00.000Z",
      "text": "整體配色可以再深一點",
      "slidePath": "slides/001.svg"
    }
  ]
}
```

每則留言除了 `id`／`target`／`author`／`created`（ISO 8601）／`text` 外，都會多帶一個 `slidePath` 欄位標示它所在的投影片。

**錯誤情境**

| 情境 | `failureKind` |
|---|---|
| `presentation-id` 不存在 | `not-found` |
| 有指定 `slide-path`，但它不在該簡報的 `slides` 清單裡 | `failed` |

**範例**

```
co-motion comment list pres-abc123
co-motion comment list pres-abc123 slides/001.svg
```
