<h1 align="center">Slidra</h1>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://slidra-demo.vercel.app/"><img alt="Deployed on Vercel" src="https://img.shields.io/badge/demo-Vercel-000000?logo=vercel&logoColor=white"></a>
  <a href="https://nextjs.org/"><img alt="Built with Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white"></a>
</p>

<p align="center">
  <b>開放的 <code>.slidra</code> 簡報格式，以及能播放它的 viewer。</b><br>
  <a href="README.md">English</a>
</p>

一個 `.slidra` 檔就是一份完整的簡報：SVG 投影片、動畫與換頁轉場、講者備忘稿、影音與字型，全部以列的形式存在同一個 SQLite 資料庫裡。這個 repository 包含：

- **格式規格**：[`spec/slidra-format.md`](spec/slidra-format.md)（deck 是什麼）、[`spec/playback.md`](spec/playback.md)（deck 怎麼播放）、[`spec/rfcs/0001-sqlite-container-format.md`](spec/rfcs/0001-sqlite-container-format.md)（為什麼容器是 SQLite），以及 [`spec/schema/`](spec/schema/) 底下 `project.json` 與投影片詞彙的 JSON Schema。
- **Viewer**：在瀏覽器打開 `.slidra` 就能播放，動畫照跑。以 Next.js 建置，檔案不會上傳。

為什麼開放格式、為什麼選 SVG：請看〈[為什麼我們開放 `.slidra` 格式](docs/why-open-the-slidra-format_zh.md)〉。

編輯器、`slidra` CLI、Agent 整合與 Harness 屬於 Slidra Pro，不在這個 repository 裡。Slidra Pro 產出的 deck 可以直接在這裡播放。

## 快速開始

viewer 是一個 Next.js 應用程式，需要 Node.js 20.9 以上。

```bash
npm install
npm run dev          # 或：npm run build && npm start
```

打開 **http://localhost:3000/**，可以點範例 deck、按 **Choose a .slidra file**，或直接把檔案拖進頁面。

要播放自己的 deck，把檔案放進 `decks/`，或用 `SLIDRA_DECKS` 列出目錄與檔案（以 `:` 分隔）：

```bash
SLIDRA_DECKS=~/Presentations:talk.slidra npm run dev -- --port 8080
```

| 設定 | 預設值 | |
|---|---|---|
| `SLIDRA_DECKS` | `decks:examples` | 要列在首頁的目錄（往下找三層）或 `.slidra` 檔 |
| `--port`、`PORT` | `3000` | |
| `--hostname` | 所有網路介面 | |

也可以直接連到某份 deck：`http://localhost:3000/?deck=/decks/1/showcase.slidra#3` 會從第 3 張開始播範例。

## 播放操作

| 按鍵 | 動作 |
|---|---|
| `→` `↓` `Space` `PageDown` `Enter`、點一下、往左滑 | 下一步／下一張 |
| `←` `↑` `PageUp` `Backspace`、往右滑 | 上一步／上一張 |
| `Home` / `End` | 第一張／最後一張的最後一步 |
| `G`（或 `O`） | 全部投影片總覽 |
| `N` | 講者備忘稿 |
| `F` | 全螢幕 |
| `Esc` | 依序：關閉總覽、離開全螢幕、關閉 deck |

支援範圍：五類共 20 種效果（進場、強調、離場、路徑動畫、媒體），可用 `on-click`、`with-previous`、`after-previous` 安排時序，並支援六種 easing 曲線、重複播放、逐行／逐字／逐字元的文字動畫，以及點擊任一元素觸發的動畫；每張投影片各自的換頁轉場（fade、slide、zoom）；內嵌字型、影片與音訊、YouTube 嵌入、圖表與表格、動態文字（`{{ slide_number }}`、`{{ slide_total }}`、`{{ presentation_name }}`），以及講者備忘稿。現行的 SQLite 容器（format 5）和舊版 ZIP deck（format 1–4）都能開。

`project.json` 裡的文件資訊（作者、日期、描述、關鍵字、封面頁）會顯示在簡報庫、標題列和總覽頁上方。

投影片支援無障礙語意（格式規格 §4.7）：每張投影片的 frame 都帶有 deck 的 `lang`（或投影片自己的 `xml:lang`）；投影片的 `<title>` 會成為總覽和螢幕閱讀器看到的名稱；元素的 `<title>` 會轉成 `aria-label`，簡報時不會跳出提示框；標了 `data-slidra-decorative` 的元素則對輔助科技隱藏。

元素可以是連結（格式規格 §4.8）：`data-slidra-link` 可以在新分頁開網頁、依 `data-slidra-slide-id` 跳到另一張投影片，或是 `#next`／`#previous`／`#first`／`#last`。點擊連結元素，或用 Tab 移過去再按 Enter 即可。其他種類的 URL 一律忽略。

## 運作方式

deck **完全在瀏覽器裡解析**。server 只負責提供檔案，拖進頁面的檔案不會離開你的電腦。SQLite 讀取器是自己寫的唯讀實作（`lib/viewer/sqlite-reader.js`），不需要 WebAssembly。

投影片內容一律視為不可信任。每張投影片都放在 `<iframe sandbox="allow-scripts">` 裡渲染，屬於 opaque origin，Content-Security-Policy 只放行 viewer 自己帶 nonce 的 runtime。所以投影片裡的 script、事件處理器和 `javascript:` URL 一律不會執行，也碰不到 viewer 頁面。deck 內的資源都以 `data:` URL 內嵌，自成一體的 deck 播放時完全不會連網。

## 開發

```bash
npm test                  # 單元測試：SQLite 讀取器（與 node:sqlite 交叉比對）、ZIP 讀取器、deck 與效果驗證
npm run examples          # 重建 examples/（需要 Node 22.5 以上的 node:sqlite）
npm run lint              # ESLint（設定在 eslint.config.mjs）
npm run format            # Prettier；npm run format:check 只檢查不改寫
npm run typecheck         # 以 TypeScript 檢查帶 JSDoc 型別的 JavaScript（jsconfig.json，checkJs）
npm run check             # lint + format:check + typecheck + 單元測試，開 PR 前先跑一次
npm run test:e2e          # 瀏覽器測試（Playwright，Chromium）：播放、導覽、投影片沙箱
```

瀏覽器測試會自己在 port 3107 啟動 `next dev`（可用 `SLIDRA_E2E_PORT` 改掉）。第一次請先執行 `npx playwright install chromium` 安裝瀏覽器。測試用的 deck 由 `test/fixtures/make-deck.mjs` 即時產生。

viewer 核心是純 ES modules（`lib/viewer/`），由 Next.js 打包；`npm run dev` 會自動重新載入。

## 部署

線上 demo **https://slidra-demo.vercel.app/** 跑在 Vercel（專案 `slidra-demo`）。

- `vercel.json` 指定 Next.js preset：先 `npm ci`，再 `next build`。
- `examples/` 裡的範例 deck 和 `spec/` 的規格會一起打包進 route handler（見 `next.config.mjs` 的 `outputFileTracingIncludes`），所以 demo 列出的就是 `examples/` 的內容。
- 用 CLI 手動佈署，push 不會自動觸發：先 `vercel link` 一次，之後 `vercel deploy --prod`。

## 授權

MIT，見 [LICENSE](LICENSE)。範例 deck 內嵌了 Noto Sans TC 的子集，採 SIL Open Font License 1.1，授權全文就放在 deck 裡的 `fonts/LICENSE-NotoSansTC.txt`。
