# 字型隨 `.comot` 打包在 `fonts/`；單獨開啟的投影片，字型只在 CoMotion 裡才保證正確

> **本 ADR 在兩份既有 ADR 上各開了一個明確的洞。** ADR-0003 的容器結構原本只有三個目錄（`project.json` + `slides/` + `assets/`），本 ADR 加上第四個：`fonts/`。ADR-0001 原本要求任何工具開啟單張投影片時「靜態畫面必須正常」，本 ADR 在**字型**這一項上明確承認例外：單獨開啟的投影片會降級成系統字型。兩份 ADR 其餘部分不受影響。
>
> 字型隨 `.comot` 打包、單獨開啟時降級成系統字型的**決策**不變；`project.json.fonts` 的 `FontEntry` 完整欄位表，以及
> `formatVersion` 4 起「`fonts` 必填（`[]` 合法）」的精確規則與 3→4 遷移規則，細節見
> [`docs/spec/comot-format.md`](../spec/comot-format.md)。

CJK 簡報需要一顆字型才能量測與畫出穩定、跨環境一致的文字（#71）：Node 端在沒有瀏覽器的情況下算版面要用它，瀏覽器渲染也要用同一顆，兩邊量出的寬度必須一致，否則排版在編輯與播放之間會跳動。這顆字型不能依賴使用者電腦上「剛好裝了 Noto Sans TC」——所以它必須跟著 `.comot`走。

## 決定一：字型是容器的內容之一，登記在 `project.json.fonts`

`.comot` 內部新增 `fonts/` 目錄存放字型檔本體（sfnt／`.ttf`）與授權全文。`project.json` 新增 optional 欄位 `fonts: FontEntry[]`：

```ts
interface FontEntry {
  /** 容器內的相對路徑，例如 "fonts/NotoSansTC-Presentation.ttf"。 */
  file: string;
  /** SVG font-family 屬性引用的值，同時是這份簡報裡字型的唯一鍵。 */
  family: string;
  /** 人類可讀的授權名稱，例如 "SIL Open Font License 1.1"。 */
  license: string;
  /** 授權全文在容器內的相對路徑。 */
  licenseFile: string;
  /** 字型取得來源。 */
  source: string;
}
```

**路徑規則**：`file` 與 `licenseFile` 必須是容器內的相對路徑，不得以 `/` 開頭、不得含 `..` 路徑片段（與 ADR-0004 對真實路徑的防範同一個理由——容器裡不該有能跳出容器根目錄的路徑）。字型檔實務上放在 `fonts/` 之下，但欄位本身不強制目錄名稱，只驗證路徑合法。

**去重策略**：`family` 是這份簡報裡字型的唯一鍵——`fonts` 陣列裡不得出現重複的 `family`。同一顆字型被多張投影片引用時，共用同一筆 `FontEntry`（同一個 `file`），不重複打包字型檔本身；SVG 只存 `font-family` 這個字串引用，不存字型資料。沒有 `fonts` 欄位的簡報（`#71` 之前建立的所有 `.comot`）仍然結構合法——這是 optional 欄位存在的原因，呼應 ADR-0003「forward-compatibility」的既有慣例。

## 決定二：單張 SVG 離線開啟時，字型降級成系統字型；只有 CoMotion wrapper 保證正確

**選擇**：`@font-face` 只在 CoMotion 的三個 wrapper 文件（`wrapSlideDocument`／`wrapSelectionDocument`／`wrapPlayDocument`）裡透過 `/api/raw/fonts/...` 注入。單張 SVG 被外部工具（瀏覽器直接開檔、Illustrator、Figma）開啟時，找不到 `@font-face` 來源，`font-family` 依 CSS 字型堆疊規則降級成該環境的系統字型——畫面不會壞，但不保證與 CoMotion 內看到的逐像素一致。

**放棄的選項：把字型 base64 內嵌進每張 SVG 的 `@font-face`。**

放棄理由：

- **檔案大小不可行。** 目前這顆簡報用 CJK 子集字型本體約 5.6MB（sfnt），base64 編碼後再漲約三分之一。一份 N 頁簡報若每張 SVG 各自內嵌一份，字型的儲存成本是 N 倍——十頁簡報就是五十幾 MB 字型資料，且逐頁重複。這對「簡報要能複製、寄送」的 ADR-0002 前提（`.comot` 是一個檔案）是嚴重的體積負擔。
- **與既有原則衝突。** ADR-0015 已經為 `assets/` 底下的圖片影音立下規則：「SVG 必須保持精簡：不內嵌 base64」，理由是 SVG 檔案大小直接等於 agent 每輪對話的 token 成本。字型 base64 是同一種傷害，且量級更大（字型檔比多數素材圖片大得多）。
- **不會讓單張 SVG 真正自足。** 即使 base64 內嵌，被開啟的環境仍需支援 `@font-face` + `data:` URL 的 sfnt 解碼——多數情況下能用，但這不是「本體不需要任何外部條件」的實質差異，只是把外部條件從「一個 HTTP route」換成「瀏覽器的字型解碼器」，換不到 ADR-0001 真正想要的東西，卻付出上面兩條的代價。

**這不是動畫或效果清單那種「單張投影片自成一體」的例外（ADR-0008 處理的是那個問題，不受本 ADR 影響）**——效果清單一定得放在該投影片的 SVG 裡才能對調頁面不動到別的檔案；字型不同，字型是全域共用資源，重複才是問題，不重複才是本 ADR 的目的。

## Consequences

- `.comot` 容器新增 `fonts/` 目錄；`project.json` 新增 optional `fonts` 欄位，形狀見上。
- SVG 只透過 `font-family` 字串引用字型，不內嵌字型資料。
- Node 端文字量測（`measurePresentationText` 一類的 API）必須能從 `project.json.fonts` 找到 `family` 對應的字型檔並解析，找不到時明確拋錯（不得 fallback 成猜測寬度）——這條沿用專案「不做 fallback」的一貫原則，不是本 ADR 新增的規則，但值得在此點名，因為量測結果一旦是猜的，排版計算全部不可信。
- 驗收標準：CoMotion 裡（`serve`／播放／編輯）看到的字型必須是簡報實際指定的那顆；單獨開啟一張投影片 SVG 時允許系統字型降級，但畫面本身仍必須合法可讀（不得空白、不得報錯）——這是 ADR-0001 尚未失效的那半句「靜態畫面必須正常」在字型議題上的具體標準。
