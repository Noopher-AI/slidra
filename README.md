# CoMotion

> An AX- and UX-friendly SVG presentation editor. From idea to presented, fast.

## 專案定位

CoMotion 是一個開源的 SVG-first 投影片編輯工具，做給**要用 agent 做簡報、而且簡報要拿得出手**的人。

用 agent 做簡報，內容通常很快就到位。剩下的時間多半花在版面：一段文字比框長了半行、兩欄的起始位置差三像素、圖片壓到說明文字。這些都不難修，難的是要一頁一頁看過才知道哪裡該修；而再請 agent 調整一輪，前一輪對好的地方可能又跟著動了。

CoMotion 想處理的是這段來回，以及它背後的三件事。

## 一、版面對不對，是算得出來的

在 CoMotion 裡，一頁排得對不對有確定的答案，不必靠眼睛判斷。

每個元素都有明確的座標、尺寸與角度；文字的實際寬高由簡報自帶的字型在 Node 端量出來，不需要瀏覽器、不需要截圖，也不需要模型看圖。所以下面這幾件事都算得出來：

- 這段文字有沒有超出它的文字框？
- 這個元素有沒有超出畫布？
- 這兩頁的標題差幾像素？
- 這兩個元素有沒有重疊？

修正同樣落在計算這一側：`element move`、`element align`、`element distribute`、`textbox width` 改的都是一個數字。

偵測與修正都在機器這一邊，因此可以合成一個閉環——agent 改完自己量一次，沒過就再調，調完再量。人看的是收斂之後的結果。

量測與幾何都已經在 `@co-motion/core` 裡：`elementBounds()`、`primitiveBounds()`、`measureTextWidth()`，以及對齊、分布與吸附，全部跑在 Node 端。把它們接成一條 `co-motion check` 是接下來的第一件事（見〈接下來〉）。

## 二、人跟 agent 在同一份東西上工作

在畫布上拖一個元素，跟 agent 下一條命令，走的是同一條路：同一組操作、同一條歷程、同一份檔案。

- **介面與命令是同一套能力。** 你在畫布上做得到的事，agent 都下得出對應的命令；agent 做得到的事，介面上也找得到入口。
- **undo 是共用的一條線。** 退回去的時候，每一步是什麼、由誰發起，都看得出來。
- **它在改第三頁，你可以同時在第一頁動手。** 兩邊寫的是同一份檔案，不必輪流等待。
- **也可以指著講**：在元素上留一句「這裡改紅一點」，送出對話時一併帶給 agent。

畫布上該有的都在：拖拉、縮放、旋轉、對齊分布、群組、鎖定、疊放順序；文字就地編輯，含游標移動、拖曳選取與中文 IME 組字；樣式與動畫各有面板；表格與圖表有專屬的編輯浮層。

## 三、規範跟著簡報一起走

團隊的簡報規範通常寫在另一份文件裡，靠人記得。交給 agent 之後，記得的責任多半落在提示詞上。

CoMotion 讓規範住在簡報裡，由編輯路徑本身維持：

- **範本**：新增投影片時整份複製過去，該固定的位置已經固定。一份簡報可以有好幾份範本——封面、內頁、章節頁。
- **鎖定**：背景、色塊、logo、頁尾、頁碼標記為版面骨架，日常編輯不會動到它們，人和 agent 一樣。
- **樣式白名單**：可寫入的屬性是一份明確的清單，清單以外的屬性在命令這一層就停下來，不會進到檔案之後再回頭清理。
- **agent 的工作範圍是命令表**：簡報內容以虛擬檔案系統呈現，讀得到全部內容，寫入則透過命令完成。因此每一次修改都有名字。
- **每次修改都留得下紀錄**：哪一頁、哪個元素、哪個屬性、從什麼變成什麼。一條命令一件事，回得去。
- **播放沙箱**：投影片一律在 sandbox iframe 裡執行，不開同源。自己做的和別人給的，同一套規則。
- **字型隨簡報打包**：換一台電腦、換一個作業系統，中文的斷行與字面維持一致。

結果是：agent 產出的簡報會落在團隊已經同意的那組樣式與版面裡，因為那組約定寫在編輯路徑上，而不是寫在每一次的提示詞裡。

## 這三件事是怎麼撐起來的

**一張投影片是一份 SVG，不是產生 SVG 的程式**（ADR-0001）。你拖的、agent 改的、瀏覽器畫的是同一份檔案，中間沒有編譯步驟，背後也沒有另一份更權威的表示法。座標是絕對的，所以「元素在哪裡」不必等瀏覽器算完才知道——這是第一件事的來源。每張投影片自成一體（ADR-0008）：圖形、識別碼、顯示名稱、效果清單全寫在那一張 SVG 裡，對調兩頁只是動 `slides` 陣列裡的兩個字串。

**所有修改都經由語意化的 CLI 命令，人與 agent 走同一條路**（ADR-0002）。`co-motion serve` 是 CLI 的常駐模式，前端與 agent 派送到的是同一份命令註冊表——這是第二件事的來源。簡報內容對 agent 唯讀，透過虛擬檔案系統存取，`fs/write_text_file` 一律拒絕（ADR-0004）；樣式走白名單（ADR-0014）；資產匯入驗證真實媒體格式（ADR-0015）——這些是第三件事的來源。

**簡報字型隨 `.comot` 一起打包**（ADR-0016）。Node 端的文字量測與瀏覽器渲染用的是同一顆字型，所以量出來的寬度就是畫出來的寬度，排版不會在編輯與播放之間跳動。離線且快取未命中時直接拋錯，不會靜默改用系統字型。

**動態是每張投影片自己持有的一份有序效果清單**，寫在該張 SVG 的 `<metadata>` 裡（ADR-0009）。效果分家族（進場、強調、退場；影音的播放本身也是一種效果），步驟不被儲存而是由清單推導。因為它是資料，所以調得動——拖順序、改觸發方式，都在面板上完成。

**播放與編輯是同一個 web app 的兩個模式**（ADR-0007）。影音走 `/api/raw` 串流與 HTTP Range，資產不必整包塞進瀏覽器。

**投影片內容一律當作不可信來處理。** 檢視與播放都跑在 sandbox iframe 裡，**永遠不加 `allow-same-origin`**，server 拒絕 `Origin: null`（ADR-0010、ADR-0011）。

**內建聊天接你已經在用的 agent。** CoMotion 是 Agent Client Protocol（ACP）client（ADR-0006），透過現成 adapter 接上 Claude Code 或 Codex。不重做一次 OAuth、provider 抽象與 tool-calling 迴圈，也不碰註冊、雲端儲存與計費。

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

- 一份 `.comot` 檔就是一份簡報，內含 `project.json`、`slides/00N.svg`、`assets/` 與 `fonts/`（簡報內嵌的字型，見 ADR-0016）。編輯期間解壓在工作目錄，儲存時重新打包（ADR-0003）。
- 所有修改都經由語意化的 CLI 命令。前端不擁有 CLI 沒有的操作。
- Agent 看得到簡報的完整內容，但只能經由命令修改。
- 動態是投影片 `<metadata>` 裡一份有序的效果清單（`<comot:effect>`，ADR-0009），由 CoMotion 的 runtime 依清單切出的步驟驅動。
- 播放與編輯是同一個 web app 的兩個模式。播放 `.comot` 需要安裝 CoMotion，分享靠匯出（ADR-0007）。
- 內建聊天透過 Agent Client Protocol 接上使用者已安裝的 agent。

決策脈絡見 [`docs/adr/`](docs/adr/)，領域詞彙見 [`CONTEXT.md`](CONTEXT.md)。

## 命令集合

| 家族 | 命令 |
| --- | --- |
| 簡報 | `new` `open` `pack` `presentation canvas set` |
| 範本 | `template add / delete / list / rename` |
| 投影片 | `slide add / delete / duplicate / move` `slide notes set` `slide style set` `slide transition set` `slide render` |
| 讀取 | `cat` `ls` |
| 元素 | `element insert / move / resize / rotate / scale / align / distribute / order / group / ungroup / lock / unlock / copy / cut / paste / duplicate / delete` `element name set` `element style set` |
| 文字 | `text set` `text style set` `text list set` `textbox add / align / width` |
| 表格 | `table create / set / merge` `table row insert / delete` `table col insert / delete / width` `table cell set / copy / cut / paste` `table cell style set` `table header set` `table theme set` `table bind` `table refresh` |
| 圖表 | `chart create` `chart type set` `chart data set` `chart axis set` `chart legend set` `chart palette set` `chart stack set` `chart option set` |
| 動態 | `effect add / set / move / remove / list` |
| 資產 | `asset import`（本機絕對路徑或 URL，驗證真實媒體格式後複製進 `assets/`，見 ADR-0015） |
| 協作 | `comment add / edit / delete / list` |
| 歷程 | `undo` `redo` |
| 其他 | `convert` |

常駐與輸出不走命令註冊表：`co-motion serve` 啟動編輯與播放的 web app，`co-motion export --format pdf｜pdf-frames` 以 headless Chromium 匯出。

## 目標使用者

已安裝並登入 Codex 或 Claude Code、願意在自己電腦上安裝軟體的人。

介面仍要低壓力、一般人也能直接上手，但不為零技術背景的使用者做妥協。CoMotion 不處理註冊、雲端儲存或計費——agent 的授權由使用者既有的 CLI 工具負責。

第三件事（範本、鎖定、白名單、可稽核的修改紀錄）指向的是**團隊**：一份規範要跨很多人、很多份簡報、很多次 agent 執行還站得住。個人使用者用得到的是同一組機制的一小部分，不必為此付出額外設定。

## 驗證

人工驗收一律從 `npm run verify:setup` 開始。它會安裝、建置、檢查前置、準備簡報、掛好 PATH，然後啟動 serve。不加旗標得到 e2e 的四頁 demo（驗既有行為），`--blank` 得到空白簡報（驗從零開始的路徑）。細節見 [`docs/verify-setup.md`](docs/verify-setup.md)。

外觀基準截圖的比對以 CI（`.github/workflows/e2e.yml`）為權威——本機字型渲染與 CI 不同，逐像素比對必然失敗，本機結果僅供參考。

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

## 接下來

按重要性排序。第一條是上面第一件事的兌現點，其餘是已知的缺口。

- **`co-motion check`**：把版面正確性串成一條命令——溢出、出界、重疊、跨頁對齊全部驗一次，回報哪一頁哪個元素差多少。量測與幾何都在 `@co-motion/core` 裡了，缺的是把它們接成 agent 跑得動的閉環。
- **簡報者畫面**：第二視窗、下一頁預覽、備忘稿、計時器。目前播放只有全螢幕。
- **一次退回整個回合**：agent 執行多條命令後，使用者要能一次退回，不是逐條 undo。
- **匯出的其餘出口**：目前只有 PDF（`--format pdf｜pdf-frames`），HTML 尚未做。
- 是否讓 agent 看得到渲染後的畫面（`co-motion screenshot`）。目前延後。
- 即時多人協作、雲端服務、PPTX 匯入匯出：暫不預設要做。是否需要，等主要路徑穩定後再決定。
