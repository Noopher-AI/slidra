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
- **一致性測試套件**：[`conformance/`](conformance/)，49 個小型 deck，各自附上符合規格的讀取器應該得到的判定，可用來測試任何實作。
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
| `SLIDRA_ALLOW_REMOTE` | 未設定 | 設為 `1` 時，這台 server 列出的 deck 可以直接載入網路資源，不必先詢問（見下方說明） |
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
| `B` 或 `.`／`W` 或 `,` | 黑屏／白屏，按任意鍵或點一下就回到投影片 |
| 輸入數字再按 `Enter` | 跳到該張投影片 |
| `?` | 列出所有快捷鍵 |
| `P` | 在第二個視窗開啟簡報者檢視 |
| `L` | 雷射筆（在簡報者檢視中也可以用：指著你那份預覽，紅點會出現在觀眾畫面上） |
| `Z` | 以游標為中心放大 2 倍，再按 `Z` 或 `Esc` 還原 |
| `Esc` | 依序：關閉總覽、離開全螢幕、關閉 deck |

支援範圍：五類共 20 種效果（進場、強調、離場、路徑動畫、媒體），可用 `on-click`、`with-previous`、`after-previous` 安排時序，並支援六種 easing 曲線、重複播放、逐行／逐字／逐字元的文字動畫，以及點擊任一元素觸發的動畫；每張投影片各自的換頁轉場（fade、slide、zoom，以及 morph：id 相同的元素會從上一張的位置平滑移動到下一張）；內嵌字型、影片與音訊、YouTube 嵌入、圖表與表格、動態文字（`{{ slide_number }}`、`{{ slide_total }}`、`{{ presentation_name }}`），以及講者備忘稿。現行的 SQLite 容器（format 5）和舊版 ZIP deck（format 1–4）都能開。

**簡報者檢視。** 按 `P`（或簡報者按鈕）會開出只給你看的第二個視窗，裡面有靜音播放的目前投影片、下一個步驟或下一張、備忘稿、可暫停與重設的計時器，以及目前時間。原本的視窗則作為觀眾畫面（拖到投影機後按 `F`）並負責播放聲音；簡報者檢視開著時，觀眾畫面不會顯示備忘稿。在任一視窗按鍵或按按鈕，兩邊都會同步移動。deck 是透過 `BroadcastChannel` 傳給簡報者視窗的，所以從本機檔案打開的 deck 也能用。

`project.json` 裡的文件資訊（作者、日期、描述、關鍵字、封面頁）會顯示在簡報庫、標題列和總覽頁上方。

投影片支援無障礙語意（格式規格 §4.7）：每張投影片的 frame 都帶有 deck 的 `lang`（或投影片自己的 `xml:lang`）；投影片的 `<title>` 會成為總覽和螢幕閱讀器看到的名稱；元素的 `<title>` 會轉成 `aria-label`，簡報時不會跳出提示框；標了 `data-slidra-decorative` 的元素則對輔助科技隱藏。

元素可以是連結（格式規格 §4.8）：`data-slidra-link` 可以在新分頁開網頁、依 `data-slidra-slide-id` 跳到另一張投影片，或是 `#next`／`#previous`／`#first`／`#last`。點擊連結元素，或用 Tab 移過去再按 Enter 即可。其他種類的 URL 一律忽略。

## 運作方式

大型 deck 也不會拖垮瀏覽器：總覽和簡報庫的縮圖是從每張投影片算一次的小 PNG（以 SVG 圖片繪製，不會執行 script、也不會連網），只保留目前投影片附近約十二張的前處理結果，內嵌資源則共用一個有上限的快取。

deck **完全在瀏覽器裡解析**。server 只負責提供檔案，拖進頁面的檔案不會離開你的電腦。SQLite 讀取器是自己寫的唯讀實作（`lib/viewer/sqlite-reader.js`），不需要 WebAssembly。

容器本身同樣不可信任：讀取器能承受截斷、損毀或惡意構造的檔案（`test/fuzz.test.mjs` 以變異方式 fuzz；`npm run fuzz` 會跑較長的一輪），並以錯誤訊息收場。超過 1 GB 的 deck、單一條目超過 256 MB、條目超過 50,000 個，以及解壓後超出宣告大小的 ZIP 條目，一律拒絕開啟。

投影片內容一律視為不可信任。每張投影片都放在 `<iframe sandbox="allow-scripts">` 裡渲染，屬於 opaque origin，Content-Security-Policy 只放行 viewer 自己帶 nonce 的 runtime。所以投影片裡的 script、事件處理器和 `javascript:` URL 一律不會執行，也碰不到 viewer 頁面。deck 內的資源都以 `data:` URL 內嵌，自成一體的 deck 播放時完全不會連網。如果 deck 引用了網路上的資源（`https:` 圖片、CSS `url()`、YouTube 嵌入），在你按下 **Load external content** 之前一律不載入，因為光是一張遠端圖片，就會讓那台 server 知道你何時打開了這份 deck（格式規格 §13）。封鎖是靠投影片 frame 的 Content-Security-Policy 做到的，不是改寫 markup。

## 驗證 deck

`slidra-validate` 依規格檢查 deck，每一項發現都會標出依據的條文。錯誤包括讀取器必須拒絕的、會讓投影片被視為損壞的，以及 writer 絕不能產生的內容；警告則是規格裡的 SHOULD，例如缺少替代文字，或 deck 需要連網才能載入資源。

```bash
npm run validate -- talk.slidra                # 或：node bin/slidra-validate.mjs talk.slidra
✓ talk.slidra (sqlite, formatVersion 5, 12 slides): 0 errors, 1 warning
  warning slides/004.svg el-Ab3xK9mQ2pLw: el-Ab3xK9mQ2pLw shows an image, media or a chart but has neither a <title> nor data-slidra-decorative="true". [a11y-unnamed, format §4.7]
```

`--json` 輸出機器可讀的報告，`--strict` 讓警告也算失敗，`--quiet` 只顯示錯誤。所有 deck 都有效時結束碼為 0，任何一個有錯誤時為 1，參數錯誤時為 2。同樣的檢查也可以直接呼叫 `lib/validate.js` 的 `validateDeck(bytes)`。

## 產生 deck

`lib/writer/` 是參考實作的 writer（需要 Node 22.5 以上的 `node:sqlite`）。規格對 writer 的要求它全部照做：RFC 0001 的檔頭、明確的目錄列、安全的路徑、依 schema 檢查 `project.json` 並保留原本的欄位順序、保留看不懂的欄位與資料表，並以原子方式取代檔案。

```js
import { DeckWriter, editDeck, convertLegacyDeck, newElementId, newSlideId } from "./lib/writer/index.js";

const deck = new DeckWriter({ name: "Q3 review", author: "Alice", lang: "en" });
deck.addSlide(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-slidra-slide-id="${newSlideId()}">…</svg>`);
deck.addFile("assets/photo.png", pngBytes);
deck.write("q3.slidra");

await editDeck("q3.slidra", (d) => d.updateProject((p) => ({ ...p, modified: new Date().toISOString() })));
await convertLegacyDeck("old-zip-deck.slidra"); // formatVersion 1–4 → 5，原地轉換
```

`tools/build-examples.mjs` 也用它產生 `examples/`（加 `--out <dir>` 可輸出到別的目錄）。

## 開發

```bash
npm test                  # 單元測試：讀取器（SQLite 與 node:sqlite 交叉比對、ZIP）、deck、效果與投影片前處理、
                          # frame 文件與 CSP、投影片 runtime 的步驟時鐘（在 vm 裡以假 DOM 執行）、writer、驗證器、一致性套件
npm run examples          # 重建 examples/（需要 Node 22.5 以上的 node:sqlite）
npm run conformance       # 依 conformance/cases.mjs 重建 conformance/decks 與 manifest.json
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
