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
- **一致性測試套件**：[`conformance/`](conformance/)，51 個 formatVersion 6 的小型 deck，各自附上符合規格的讀取器應該得到的判定，可用來測試任何實作。舊版 deck 不在套件範圍內。
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
| `SLIDRA_EMBED_ORIGINS` | `*` | 允許嵌入 `/embed` 的來源，以空白分隔 |
| `--port`、`PORT` | `3000` | |
| `--hostname` | 所有網路介面 | |

也可以直接連到某份 deck：`http://localhost:3000/?deck=/decks/1/showcase.slidra#3` 會從第 3 張開始播範例。這樣的連結貼到聊天軟體或社群網站時，會顯示這份 deck 的名稱、描述和封面投影片（`/api/og` 在 server 端把封面轉成 1200×630 的 PNG，轉換前會先移除投影片裡所有外部參照）。

## Web component

`<slidra-player>` 可以把 deck 放進任何網頁，不需要框架，也不需要自己的 server。`npm run build:element` 會把它打包成單一 ES module，slide runtime 已經內含在裡面（位於 `packages/slidra-player/`，發布名稱為 `@slidra/player`）：

```html
<script type="module" src="slidra-player.js"></script>
<slidra-player src="talk.slidra" controls slide="3"></slidra-player>
```

它提供 `next()`、`previous()`、`goTo(n)`、`slide`、`step`、`slideCount`，並會觸發 `slidechange`、`stepchange` 與 `error` 事件。頁面也可以不用 `src`，改把 `source` 屬性設成一個 [deck source](#deck-source)，元素只會向它讀取要顯示的投影片。投影片依然在沙箱 frame 裡渲染；除非元素加上 `allow-remote`，否則網路資源一律封鎖。`/embed` 就是用它做的。詳見 [`packages/slidra-player/README.md`](packages/slidra-player/README.md)。

## 嵌入其他網站

這台 server 列出的任何 deck 都能嵌入其他網站：

```html
<iframe src="https://your-server/embed?deck=%2Fdecks%2F0%2Fshowcase.slidra" width="960" height="584" style="border:0" allow="autoplay; fullscreen" allowfullscreen></iframe>
```

`/embed` 只有舞台和一條精簡的控制列（附 **Open in Slidra** 連結），也是唯一允許被其他網站嵌入的頁面（`Content-Security-Policy: frame-ancestors *`；可用 `SLIDRA_EMBED_ORIGINS` 以空白分隔列出允許的來源來收窄）。其他頁面一律送出 `X-Frame-Options: SAMEORIGIN`。deck 頁面會宣告 oEmbed 端點（`/api/oembed?url=<deck 連結>`），支援連結展開的工具可以自動嵌入。

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
| `Ctrl`/`⌘` + `P` | 列印、存成 PDF（每頁一張、附備忘稿，或講義每頁 2、3、6 張，也可以把每個動畫步驟各印成一頁），或匯出圖片：目前這張存成 PNG，或全部投影片打包成 PNG 的 ZIP |
| `P` | 在第二個視窗開啟簡報者檢視 |
| `L` | 雷射筆（在簡報者檢視中也可以用：指著你那份預覽，紅點會出現在觀眾畫面上） |
| `Z` | 以游標為中心放大 2 倍，再按 `Z` 或 `Esc` 還原 |
| `Esc` | 依序：關閉總覽、離開全螢幕、關閉 deck |

支援範圍：五類共 20 種效果（進場、強調、離場、路徑動畫、媒體），可用 `on-click`、`with-previous`、`after-previous` 安排時序，並支援六種 easing 曲線、重複播放、逐行／逐字／逐字元的文字動畫，以及點擊任一元素觸發的動畫；每張投影片各自的換頁轉場（fade、slide、zoom，以及 morph：id 相同的元素會從上一張的位置平滑移動到下一張）；內嵌字型、影片與音訊、YouTube 嵌入、圖表與表格、動態文字（`{{ slide_number }}`、`{{ slide_total }}`、`{{ presentation_name }}`），以及講者備忘稿。現行的 deck（formatVersion 6，SQLite）可以開，舊版 deck 也能以唯讀方式開啟：formatVersion 5（SQLite）與 1–4（ZIP）。

**簡報者檢視。** 按 `P`（或簡報者按鈕）會開出只給你看的第二個視窗，裡面有靜音播放的目前投影片、下一個步驟或下一張、備忘稿、可暫停與重設的計時器，以及目前時間。原本的視窗則作為觀眾畫面（拖到投影機後按 `F`）並負責播放聲音；簡報者檢視開著時，觀眾畫面不會顯示備忘稿。在任一視窗按鍵或按按鈕，兩邊都會同步移動。deck 是透過 `BroadcastChannel` 傳給簡報者視窗的，所以從本機檔案打開的 deck 也能用。從 [deck source](#deck-source) 播放的 deck 則改傳 source 的 `presenter()` 描述，由簡報者頁面據此開啟自己的 source（`startPresenter({ openSource })`）。

`project.json` 裡的文件資訊（作者、日期、描述、關鍵字、封面頁）會顯示在簡報庫、標題列和總覽頁上方。

viewer 本身也支援輔助科技與鍵盤操作（播放規格 §9）：以禮貌模式的 live region 報讀每張投影片（頁碼、總頁數、標題），並念出每個步驟新出現的內容；總覽可以用方向鍵移動；對話框會把焦點留在框內；各頁以 axe 檢查沒有 serious 等級的問題；系統設定 `prefers-reduced-motion` 時，所有效果與轉場都會立即完成。

投影片支援無障礙語意（格式規格 §4.7）：每張投影片的 frame 都帶有 deck 的 `lang`（或投影片自己的 `xml:lang`）；投影片的 `<title>` 會成為總覽和螢幕閱讀器看到的名稱；元素的 `<title>` 會轉成 `aria-label`，簡報時不會跳出提示框；標了 `data-slidra-decorative` 的元素則對輔助科技隱藏。

元素可以是連結（格式規格 §4.8）：`data-slidra-link` 可以在新分頁開網頁、依 `data-slidra-slide-id` 跳到另一張投影片，或是 `#next`／`#previous`／`#first`／`#last`。點擊連結元素，或用 Tab 移過去再按 Enter 即可。其他種類的 URL 一律忽略。

## 運作方式

大型 deck 也不會拖垮瀏覽器：總覽和簡報庫的縮圖是從每張投影片算一次的小 PNG（以 SVG 圖片繪製，不會執行 script、也不會連網），只保留目前投影片附近約十二張的前處理結果，內嵌資源則共用一個有上限的快取。

deck **完全在瀏覽器裡解析**。server 只負責提供檔案，拖進頁面的檔案不會離開你的電腦。SQLite 讀取器是自己寫的唯讀實作（`lib/viewer/sqlite-reader.js`），不需要 WebAssembly。

### Deck source

播放器從來不需要整個檔案：它透過 **deck source**（`lib/viewer/source.js`）讀取 deck，而且只要它要顯示的部分。

```js
/** @typedef {{
 *   project(): Promise<object>,                       // 解析好的 project.json；播放器會再驗證一次
 *   slide(path: string): Promise<string>,             // 單張投影片的 SVG markup，需要時才取
 *   fileUrl(path: string): Promise<string|null> | string | null, // 字型、圖片、影片或音訊檔的 URL
 *   slideIds?(): Promise<(string|null)[]>,            // 選用：每張投影片的 data-slidra-slide-id，供連結使用
 *   presenter?(): unknown,                            // 選用：簡報者視窗據以開啟自己那份 deck 的描述
 * }} DeckSource */
```

`deckSourceFromBytes(bytes)` 就是 viewer、`/embed` 與 `<slidra-player src>` 背後的 source：整個檔案在記憶體裡，檔案以 `data:` URL 提供，行為和以前完全一樣。server 也可以實作同一個介面而從不送出檔案本身：只給 project.json、一次一張投影片（要的話可以先拿掉講者備忘稿），每個打包的檔案各有自己的 URL。播放器只會準備目前投影片附近的幾張（被要求時再加上縮圖與列印），`@font-face` 和 `<image href>` 直接引用 source 給的 URL 而不內嵌；縮圖與列印則用它自己抓回來的副本繪製（因此字型 URL——從 frame 的 opaque origin 以 CORS 模式載入——以及縮圖用到的圖片 URL 需要 `Access-Control-Allow-Origin`）。source 回傳的一切仍視為不可信任：project.json 會再驗證一次，投影片照常前處理，檔案 URL 只接受 `data:`、`blob:` 與 `http(s):`。

```js
const player = document.querySelector("slidra-player");
player.source = {
  project: () => fetch("/api/decks/42/project.json").then((r) => r.json()),
  slide: (path) => fetch(`/api/decks/42/${path}`).then((r) => r.text()),
  fileUrl: (path) => filesByPath[path] ?? null, // 例如以內容定址的 https URL
};
```

viewer app 也接受 source：`lib/viewer/app.js` 的 `startViewer({ source, presenterUrl })`，簡報者頁面則以 `startPresenter({ openSource })` 把 source 的 `presenter()` 描述還原成 source。

容器本身同樣不可信任：讀取器能承受截斷、損毀或惡意構造的檔案（`test/fuzz.test.mjs` 以變異方式 fuzz；`npm run fuzz` 會跑較長的一輪），並以錯誤訊息收場。超過 1 GB 的 deck、單一條目超過 256 MB、條目超過 50,000 個，以及解壓後超出宣告大小的 ZIP 條目，一律拒絕開啟。

投影片內容一律視為不可信任。每張投影片都放在 `<iframe sandbox="allow-scripts">` 裡渲染，屬於 opaque origin，Content-Security-Policy 只放行 viewer 自己帶 nonce 的 runtime。所以投影片裡的 script、事件處理器和 `javascript:` URL 一律不會執行，也碰不到 viewer 頁面。deck 內的資源都以 `data:` URL 內嵌，自成一體的 deck 播放時完全不會連網；deck source 自己的檔案 URL 則逐一放行（origin 加路徑，絕不放行整個 scheme），也不算 deck 的網路內容。如果 deck 引用了網路上的資源（`https:` 圖片、CSS `url()`、YouTube 嵌入），在你按下 **Load external content** 之前一律不載入，因為光是一張遠端圖片，就會讓那台 server 知道你何時打開了這份 deck（格式規格 §13）。封鎖是靠投影片 frame 的 Content-Security-Policy 做到的，不是改寫 markup。

## 驗證 deck

`slidra-validate` 依規格檢查 deck，每一項發現都會標出依據的條文。錯誤包括讀取器必須拒絕的、會讓投影片被視為損壞的，以及 writer 絕不能產生的內容；警告則是規格裡的 SHOULD，例如缺少替代文字，或 deck 需要連網才能載入資源。

```bash
npm run validate -- talk.slidra                # 或：node bin/slidra-validate.mjs talk.slidra
✓ talk.slidra (sqlite, formatVersion 6, 12 slides): 0 errors, 1 warning
  warning slides/004.svg el-Ab3xK9mQ2pLw: el-Ab3xK9mQ2pLw shows an image, media or a chart but has neither a <title> nor data-slidra-decorative="true". [a11y-unnamed, format §4.7]
```

`data-slidra-role` 的值如果既不是版面角色（`background`、`field`、`node`、`spine`、`edge`、`label`、`garnish`，見格式 §4.9），也不是 `pro:timeline` 這類 `<prefix>:<name>` 擴充值，會得到 `role-unknown` 錯誤；角色不會影響播放。舊版 deck（formatVersion 1–5）只會得到 `legacy-format-version` 警告，不算錯誤；其他版本號則是錯誤。`--json` 輸出機器可讀的報告，`--strict` 讓警告也算失敗，`--quiet` 只顯示錯誤。所有 deck 都有效時結束碼為 0，任何一個有錯誤時為 1，參數錯誤時為 2。同樣的檢查也可以直接呼叫 `lib/validate.js` 的 `validateDeck(bytes)`。

## 產生 deck

`lib/writer/` 是參考實作的 writer（需要 Node 22.5 以上的 `node:sqlite`）。規格對 writer 的要求它全部照做：RFC 0001 的檔頭、明確的目錄列、安全的路徑、依 schema 檢查 `project.json` 並保留原本的欄位順序、保留看不懂的欄位與資料表，並以原子方式取代檔案。它寫出的是 formatVersion 6；`editDeck` 編輯舊版 formatVersion 5 的 deck 時，會在同一個 transaction 裡把它升級成 6，`convertLegacyDeck` 則把 formatVersion 5 或 ZIP（1–4）的 deck 一次轉換完成。

```js
import { DeckWriter, editDeck, convertLegacyDeck, newElementId, newSlideId } from "./lib/writer/index.js";

const deck = new DeckWriter({ name: "Q3 review", author: "Alice", lang: "en" });
deck.addSlide(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-slidra-slide-id="${newSlideId()}">…</svg>`);
deck.addFile("assets/photo.png", pngBytes);
deck.write("q3.slidra");

await editDeck("q3.slidra", (d) => d.updateProject((p) => ({ ...p, modified: new Date().toISOString() })));
await convertLegacyDeck("old-deck.slidra"); // formatVersion 1–5 → 6，原地轉換
```

`tools/build-examples.mjs` 也用它產生 `examples/`（加 `--out <dir>` 可輸出到別的目錄）。`tools/build-feature-examples.mjs` 同樣用它產生兩份功能導覽 deck：

- **`motion.slidra`**：easing 曲線、飛入方向、逐行／逐字／逐字元的文字動畫、重複播放、以觸發製作的測驗、三張投影片的 morph，以及連結。
- **`sharing.slidra`**：文件資訊與封面、可點擊跳頁的議程、替代文字與裝飾標記、附資料的圖表、以 `xml:lang` 標示的繁體中文投影片、簡報者檢視、外部資源同意提示，以及列印、匯出圖片與嵌入。

兩份都內嵌由 `tools/.feature-text.txt` 產生的 Noto Sans TC 子集字型（Regular 與 Bold，OFL 授權）。

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
npm run bundle            # 建置供 vendoring 的 dist/slidra-bundle/（見「供 vendoring 的 bundle」）
npm run test:e2e          # 瀏覽器測試（Playwright，Chromium）：播放、導覽、投影片沙箱
```

瀏覽器測試會自己在 port 3107 啟動 `next dev`（可用 `SLIDRA_E2E_PORT` 改掉）。第一次請先執行 `npx playwright install chromium` 安裝瀏覽器。測試用的 deck 由 `test/fixtures/make-deck.mjs` 即時產生。

viewer 核心是純 ES modules（`lib/viewer/`），由 Next.js 打包；`npm run dev` 會自動重新載入。

## 供 vendoring 的 bundle

`npm run bundle` 會產生 `dist/slidra-bundle/`：其他專案要在某個 tag 上 vendor 這份格式與播放器所需的一切，不必再下載或安裝任何東西。每個 `format-v*` tag（例如 `format-v6`）的 GitHub release 會附上 `slidra-bundle-<tag>.tar.gz` 和對應的 `.sha256` 檔（`.github/workflows/release-bundle.yml`）。

| 路徑 | 內容 |
|---|---|
| `player/slidra-viewer.js` | viewer 函式庫打包成一個 ES module（`lib/viewer/index.js`），內含投影片 runtime：`openDeck`、`Deck`、`DeckError`、`deckInfo`、`FORMAT_VERSION`、`APPLICATION_ID`、`NAMESPACE`、`DEFAULT_LIMITS`；deck source（`deckSourceFromBytes`、`BytesDeckSource`、`PlayableDeck`、`openSource`；`DeckSource` 介面寫在 `lib/viewer/source.js`）；`Player`、`prepareSlide`、`PLAYER_RUNTIME`；viewer 頁面的 `startViewer` 與 `startPresenter`；以及做縮圖、列印與匯出用的 `buildPrintout`、`printEntries`、`markupAtStep`、`PER_PAGE`、`renderThumbnail`、`renderSlidePng`、`fontFaceCss`、`staticDocument`、`zipStore` |
| `player/viewer-shell.html`、`player/presenter-shell.html`、`player/slidra-viewer.css` | `startViewer` 與 `startPresenter` 掛載用的 markup，以及它的樣式表 |
| `player/slidra-player.js` | `<slidra-player>` web component |
| `player/player-runtime.js` | 投影片 runtime，即 `/js/player-runtime.js` 提供的那一份 |
| `validator/slidra-validate.mjs` | 含相依套件的驗證器（Node 22.5 以上）：`import { validateDeck } from "./slidra-validate.mjs"`，或直接執行 `node slidra-validate.mjs [--json] [--strict] <deck>…`；旁邊附 `THIRD-PARTY-LICENSES.txt` |
| `schema/`、`spec/`、`conformance/` | JSON Schema、規格（含 RFC），以及一致性測試 deck 與其 `manifest.json`、`README.md` |
| `MANIFEST.json`、`LICENSE` | formatVersion、來源 commit，以及其他每個檔案的大小與 sha256，依路徑排序 |

建置是確定性的：同一個 commit 產出逐位元組相同的檔案。要驗證 vendor 進來的副本，可以在該 tag 重新建置後比對 manifest：

```bash
git checkout format-v6 && npm ci && npm run bundle
diff dist/slidra-bundle/MANIFEST.json path/to/vendored/MANIFEST.json
```

或用 release 附的檢查碼驗證 tarball：`sha256sum -c slidra-bundle-format-v6.tar.gz.sha256`。

## 部署

線上 demo **https://slidra-demo.vercel.app/** 跑在 Vercel（專案 `slidra-demo`）。

- `vercel.json` 指定 Next.js preset：先 `npm ci`，再 `next build`。
- `examples/` 裡的範例 deck 和 `spec/` 的規格會一起打包進 route handler（見 `next.config.mjs` 的 `outputFileTracingIncludes`），所以 demo 列出的就是 `examples/` 的內容。
- 用 CLI 手動佈署，push 不會自動觸發：先 `vercel link` 一次，之後 `vercel deploy --prod`。

## 參與貢獻

環境設定、可用指令，以及格式變更的流程（規格先行），請見 [CONTRIBUTING.md](CONTRIBUTING.md)。資安問題請依 [SECURITY.md](SECURITY.md) 的說明私下回報。歷次變更列在 [CHANGELOG.md](CHANGELOG.md)。

## 授權

MIT，見 [LICENSE](LICENSE)。範例 deck 內嵌了 Noto Sans TC 的子集，採 SIL Open Font License 1.1，授權全文就放在 deck 裡的 `fonts/LICENSE-NotoSansTC.txt`。
