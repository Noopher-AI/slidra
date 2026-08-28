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
React 外殼（面板／聊天／工具列）＋ vanilla 畫布
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
- 動態以 `data-comot-step`、`data-comot-enter` 等屬性表達，由 CoMotion 的 runtime 依步驟驅動。
- 播放與編輯是同一個 web app 的兩個模式。播放 `.comot` 需要安裝 CoMotion，分享靠匯出（ADR-0007）。
- 內建聊天透過 Agent Client Protocol 接上使用者已安裝的 agent。

決策脈絡見 [`docs/adr/`](docs/adr/)，領域詞彙見 [`CONTEXT.md`](CONTEXT.md)。

## MVP 邊界

第一顆曳光彈只打穿一條路徑：

> `co-motion serve` → 瀏覽器看到一頁 SVG → 在聊天裡說「把標題改成 Q3 財報」→ agent 經 ACP 收到、執行 `co-motion` 命令改檔 → 檔案變動推回前端 → 畫面更新。

它驗證的假設是：**一個現成的 coding agent，只靠一則編輯規約加一組 CLI 命令，就能編輯投影片。** 這個假設不成立，其他都不必做。

**不含**：動畫、影音、拖拉編輯、`.comot` 打包。

暫不預設簡報匯入匯出格式、即時多人協作、雲端服務、完整動畫時間軸、AI 自動生成整份簡報或商業化功能。它們是否需要，應在第一條路徑可用後再決定。

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

- **Noto Sans TC**（`packages/web/src/assets/fonts/NotoSansTC-subset.woff2`）：Google 的開源中文字型，授權為 [SIL Open Font License 1.1](https://openfontlicense.org/)。原始字體取自 Google Fonts（`https://fonts.googleapis.com/css2?family=Noto+Sans+TC`），這裡收錄的是子集版本——只保留 UI 實際用到的字元，由 `scripts/build-font-subset.mjs` 產生（子集使用 [`subset-font`](https://github.com/papandreou/subset-font)，wasm 版 harfbuzz，不需要 Python 工具鏈）。

## 尚待決定

- CLI 命令集合的具體設計：動詞、參數與定址寫法。
- 是否讓 agent 看得到渲染後的畫面（`co-motion screenshot`）。目前延後。
- Agent 一次執行多條命令後，使用者要如何一次退回整個回合。目前只有逐條 undo。
- 匯出成可分享格式（HTML、PDF 等）的時機。那是 server 端的功能，MVP 不做。
