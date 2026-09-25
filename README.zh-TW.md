<h1 align="center">Slidra</h1>

<p align="center">
  <b>開放的 <code>.slidra</code> 簡報格式，以及能播放它的 viewer。</b><br>
  <a href="README.md">English</a>
</p>

一個 `.slidra` 檔就是一份完整的簡報：SVG 投影片、動畫與換頁轉場、講者備忘稿、影音與字型，全部以列的形式存在同一個 SQLite 資料庫裡。這個 repository 包含：

- **格式規格**：[`spec/slidra-format.md`](spec/slidra-format.md)（deck 是什麼）、[`spec/playback.md`](spec/playback.md)（deck 怎麼播放）、[`spec/rfcs/0001-sqlite-container-format.md`](spec/rfcs/0001-sqlite-container-format.md)（為什麼容器是 SQLite）。
- **Viewer**：在瀏覽器打開 `.slidra` 就能播放，動畫照跑。不用 build、沒有相依套件，檔案也不會上傳。

為什麼開放格式、為什麼選 SVG：請看〈[為什麼我們開放 `.slidra` 格式](docs/why-open-the-slidra-format_zh.md)〉。

編輯器、`slidra` CLI、Agent 整合與 Harness 屬於 Slidra Pro，不在這個 repository 裡。Slidra Pro 產出的 deck 可以直接在這裡播放。

## 快速開始

需要 Node.js 18 以上，不必 `npm install`。

```bash
npm start            # 或：node server.js
```

打開 **http://localhost:8080/**，可以點範例 deck、按 **Choose a .slidra file**，或直接把檔案拖進頁面。

要播放自己的 deck，把目錄或檔案路徑交給 server：

```bash
node server.js ~/Presentations talk.slidra --port 8080
```

| 選項 | 預設值 | |
|---|---|---|
| `[路徑…]` | `./decks` 與 `./examples` | 要列在首頁的目錄（往下找三層）或 `.slidra` 檔 |
| `--port`、`PORT` | `8080` | |
| `--host`、`HOST` | `127.0.0.1` | 設成 `0.0.0.0` 就能分享給區網裡的其他裝置 |

也可以直接連到某份 deck：`http://localhost:8080/?deck=/decks/1/showcase.slidra#3` 會從第 3 張開始播範例。

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

支援範圍：五類共 14 種效果（進場、強調、離場、路徑動畫、媒體），可用 `on-click`、`with-previous`、`after-previous` 安排時序；每張投影片各自的換頁轉場（fade、slide、zoom）；內嵌字型、影片與音訊、YouTube 嵌入、圖表與表格、動態文字（`{{ slide_number }}`、`{{ slide_total }}`、`{{ presentation_name }}`），以及講者備忘稿。現行的 SQLite 容器（format 5）和舊版 ZIP deck（format 1–4）都能開。

## 運作方式

deck **完全在瀏覽器裡解析**。server 只負責提供檔案，拖進頁面的檔案不會離開你的電腦。SQLite 讀取器是自己寫的唯讀實作（`public/js/sqlite-reader.js`），不需要 WebAssembly。

投影片內容一律視為不可信任。每張投影片都放在 `<iframe sandbox="allow-scripts">` 裡渲染，屬於 opaque origin，Content-Security-Policy 只放行 viewer 自己帶 nonce 的 runtime。所以投影片裡的 script、事件處理器和 `javascript:` URL 一律不會執行，也碰不到 viewer 頁面。deck 內的資源都以 `data:` URL 內嵌，自成一體的 deck 播放時完全不會連網。

## 開發

```bash
npm test                  # 單元測試：SQLite 讀取器（與 node:sqlite 交叉比對）、ZIP 讀取器、deck 與效果驗證
npm run examples          # 重建 examples/（需要 Node 22.5 以上的 node:sqlite）
```

程式碼是純 ES modules，沒有 build 流程，改完重新整理即可。

## 授權

MIT，見 [LICENSE](LICENSE)。範例 deck 內嵌了 Noto Sans TC 的子集，採 SIL Open Font License 1.1，授權全文就放在 deck 裡的 `fonts/LICENSE-NotoSansTC.txt`。
