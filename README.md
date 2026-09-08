# CoMotion

> An AX- and UX-friendly SVG presentation editor. From idea to presented, fast.

## 專案定位

CoMotion 是一個開源的 SVG-first 投影片編輯工具。它要讓不必熟悉 SVG 或程式的人，也能直接編輯並播放有動態與多媒體的投影片；同時，agent 能理解、檢查並和人共同編輯同一份簡報。

這不是另一個只用 AI 產生 PPTX 的工具。CoMotion 的核心是可持續編輯的 SVG 投影片，以及人與 agent 對其內容、時間與媒體的共同創作。

## 目標使用者

已安裝並登入 Codex 或 Claude Code、願意在自己電腦上安裝軟體的人。

介面仍要低壓力、一般人也能直接上手，但不為零技術背景的使用者做妥協。CoMotion 不處理註冊、雲端儲存或計費——agent 的授權由使用者既有的 CLI 工具負責。

## 已確認的期待

- 以 SVG 作為投影片的本體，而非通往其他格式的中間產物。
- 提供低壓力、一般使用者也能直接上手的視覺編輯體驗。
- 支援物件依序出現等動畫與展示節奏。
- 能放入並播放影音等多媒體內容。
- 採開源方式發展。
- 簡報內容對 agent 友善：結構清楚、可檢查，並讓 agent 與人能共同操作同一份內容。

## 形狀

```
React 外殼（頂列／左側縮圖軌／舞台底部 Dock／右側 Chat·Style·Animate 分頁）＋ vanilla 畫布
    ↓
co-motion serve          ← CLI 的常駐模式
    ↓
   CLI                   ← 唯一的操作語彙 ← 外部 agent 也走這裡
    ↓
 簡報內容
```

- 一份 `.comot` 檔就是一份簡報，內含 `project.json`、`slides/00N.svg`、`assets/` 與 `fonts/`（簡報內嵌的字型，見 ADR-0016）。
- 所有修改都經由語意化的 CLI 命令。前端不擁有 CLI 沒有的操作。
- Agent 看得到簡報的完整內容，但只能經由命令修改。
- 動態是投影片 `<metadata>` 裡一份有序的效果清單（`<comot:effect>`，ADR-0009），由 CoMotion 的 runtime 依清單切出的步驟驅動。
- 播放與編輯是同一個 web app 的兩個模式。播放 `.comot` 需要安裝 CoMotion，分享靠匯出（ADR-0007）。
- 內建聊天透過 Agent Client Protocol 接上使用者已安裝的 agent。

命令與格式的規範性定義見 [`docs/spec/`](docs/spec/)，決策脈絡見 [`docs/adr/`](docs/adr/)，領域詞彙見 [`CONTEXT.md`](CONTEXT.md)。

## 命令與格式以 `docs/spec/` 為準

- [`docs/spec/cli.md`](docs/spec/cli.md)：81 條命令的唯一規範性文件——參數、成功時的 `data` JSON 形狀、錯誤情境與 `failureKind`、exit code、renderer 規則。
- [`docs/spec/comot-format.md`](docs/spec/comot-format.md)：`.comot` 容器與 `~/.comotion/` 工作區的唯一規範性文件——zip 佈局、`project.json` 欄位、SVG `<metadata>` 內的 `comot:*` 元素、`formatVersion` 與遷移規則。

`docs/adr/` 留作**決策史**，記錄當初為什麼那樣選；規格與實作對不上時，以 `docs/spec/` 為準。`packages/server/agent-workdir/reference/commands.md` 是給 agent 的用法摘要，是 `docs/spec/cli.md` 的子集，由 `scripts/check-reference-subset.mjs` 檢查。

## MVP 邊界

第一顆曳光彈只打穿一條路徑：

> `co-motion serve` → 瀏覽器看到一頁 SVG → 在聊天裡說「把標題改成 Q3 財報」→ agent 經 ACP 收到、執行 `co-motion` 命令改檔 → 檔案變動推回前端 → 畫面更新。

它驗證的假設是：**一個現成的 coding agent，只靠一則編輯規約加一組 CLI 命令，就能編輯投影片。** 這個假設不成立，其他都不必做。

**不含**：動畫、影音、拖拉編輯、`.comot` 打包。（這是第一顆曳光彈當時的邊界，現在動畫、影音、拖拉編輯與 `.comot` 打包都已交付——`object-animation.test.ts`／`player-media.test.ts`／`direct-manipulation.test.ts`／`packDirectory` 各自是它們的驗收證據。這一段保留原始記錄，不是目前功能範圍；目前範圍見上面「形狀」一節與 `docs/adr/`。）

暫不預設簡報匯入格式、即時多人協作、雲端服務、完整動畫時間軸、AI 自動生成整份簡報或商業化功能。匯出已支援 PDF（見下方「尚待決定」）。它們是否需要，應在第一條路徑可用後再決定。

## 命名格式

| 用途 | 名稱 |
| --- | --- |
| 正式產品名稱 | `CoMotion` |
| 專案資料夾與 GitHub repository | `co-motion` |
| 未來 JavaScript/TypeScript 套件 scope | `@co-motion/*` |
| CLI 執行檔 | `co-motion` |
| 簡報檔副檔名 | `.comot` |
| 文件與使用者可見文案 | `CoMotion` |

`CoMotion` 表達人與 agent 的共同創作（Co-），以及 SVG 元素、動畫與影音共同形成的動態演出（Motion）。

## 第三方素材授權

- **Noto Sans TC**（`packages/web/src/assets/fonts/NotoSansTC-subset.woff2`、`NotoSansTC-subset-500.woff2`、`NotoSansTC-subset-700.woff2`）：Google 的開源中文字型，授權為 [SIL Open Font License 1.1](https://openfontlicense.org/)。原始字體取自 Google Fonts（`https://fonts.googleapis.com/css2?family=Noto+Sans+TC`），這裡收錄的是子集版本——只保留 UI 實際用到的字元，400/500/700 三個字重各自子集化，由 `scripts/build-font-subset.mjs` 產生（子集使用 [`subset-font`](https://github.com/papandreou/subset-font)，wasm 版 harfbuzz，不需要 Python 工具鏈）。
- **Noto Sans TC — 簡報字型**（`packages/core/src/assets/fonts/NotoSansTC-Presentation.ttf`，授權全文隨每份 `.comot` 一起打包在 `fonts/LICENSE-NotoSansTC.txt`）：與上一條同樣是 Google 的開源中文字型，授權同為 [SIL Open Font License 1.1](https://openfontlicense.org/)，但這是獨立的一份子集——每份新簡報建立時都會把這顆字型連同授權文字一起內嵌進 `.comot`，讓簡報在沒有安裝該字型的環境（包含沒有瀏覽器的 Node 端文字量測）也能算出、畫出一致的結果。子集範圍固定為 ASCII、Latin-1 補充、標點、CJK 符號／全形／半形與整個 CJK 統一表意文字區塊，格式是 sfnt（`.ttf`，不是 woff2），由 `scripts/build-presentation-font.mjs` 產生。

- **Noto Sans TC 完整版**（打包進 `.comot` 的 `assets/fonts/NotoSansTC-Regular.ttf`，授權全文 `packages/core/src/font/OFL.txt`）：同一套字型的完整版本，授權為 [SIL Open Font License 1.1](https://openfontlicense.org/)。原始字體取自 Google Fonts（`https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400`），**字型檔本身不進版控**——第一次用到時才下載，並快取在 `~/.cache/co-motion/fonts/`（可用 `CO_MOTION_FONT_CACHE` 指定）。打包進 `.comot` 的是完整字型而非子集，因為簡報的文字內容不可預先枚舉；`OFL.txt` 與字型檔一起進 `assets/fonts/`，授權全文因此隨著每一份 `.comot` 走。離線且快取未命中時會直接拋錯，不會偷偷改用系統字型。

## 尚待決定

- CLI 命令集合的具體設計：動詞、參數與定址寫法。
- 是否讓 agent 看得到渲染後的畫面（`co-motion screenshot`）。目前延後。
- Agent 一次執行多條命令後，使用者要如何一次退回整個回合。目前只有逐條 undo。
- 匯出成 PDF 以外其餘可分享格式（如 HTML）的時機——PDF（含逐頁與逐效果步驟兩種）已支援，見 `export-cli.test.ts`／`export-gui.test.ts`。
