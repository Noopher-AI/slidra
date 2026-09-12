## 資產匯入

`asset import` 把圖片、影片或音訊複製（本機來源）或下載（URL 來源）進簡報的 `assets/` 目錄，一律走檔頭位元組驗證，見 ADR-0015。

### 來源

- **本機絕對路徑**：直接讀取檔案。
- **URL**（`http://` 或 `https://`）：下載回應本體，`Content-Type` 標頭只是提示，不作為格式判斷依據（不可信輸入）。

### 格式驗證：只看檔頭位元組，不看副檔名

匯入時讀取檔案開頭的位元組，比對支援格式的簽章（見下方清單）。**副檔名完全不參與格式判斷**：

- 副檔名偽裝（例如把文字檔改名成 `.png`）：檔頭比對不到任何已知簽章，一律拒絕，`assets/` 不會多出任何檔案。
- 副檔名遺失或錯誤，但內容確實是支援的媒體：以偵測到的真實格式決定寫入檔案的副檔名，不採用來源的副檔名。
- URL 回應的 `Content-Type` 與偵測到的位元組不一致：一律以位元組偵測結果為準；`Content-Type` 宣稱是媒體但位元組不是，一律拒絕。

支援格式清單的單一來源是 `crates/comotion/src/media_format.rs`（位元組簽章偵測，`asset import` 實際跑的地方）——`packages/server/src/media-types.ts` 是與它同步維護的副檔名／MIME 對照表，`packages/server/src/raw.ts` 提供給瀏覽器讀取 `/api/raw/` 資產時用的 Content-Type 表就是從這份對照表衍生的，不是另外維護的第三份。

| 副檔名 | MIME type | 種類 |
|---|---|---|
| `.png` | image/png | image |
| `.jpg`（含 `.jpeg`） | image/jpeg | image |
| `.gif` | image/gif | image |
| `.webp` | image/webp | image |
| `.mp4` | video/mp4 | video |
| `.webm` | video/webm | video |
| `.m4v` | video/mp4 | video |
| `.mov` | video/quicktime | video |
| `.ogv` | video/ogg | video |
| `.mp3` | audio/mpeg | audio |
| `.wav` | audio/wav | audio |
| `.m4a` | audio/mp4 | audio |
| `.opus` | audio/ogg | audio |
| `.oga` | audio/ogg | audio |
| `.aac` | audio/aac | audio |

### 檔名衝突規則

目的檔名 =（去除副檔名的來源檔名，非法檔案系統字元以 `_` 取代）+（偵測到的格式決定的副檔名）。

若 `assets/<name><ext>` 已經存在，依序嘗試 `<name>-1<ext>`、`<name>-2<ext>`……直到找到第一個不存在的檔名為止。**絕不覆蓋既有檔案，絕不使用時間戳**——時間戳無法在測試裡穩定斷言，也不利於除錯時肉眼辨識。

### 復原（undo/redo）

匯入是一個獨立的 undo 步驟：`comotion undo` 會把剛匯入的檔案從 `assets/` 移除；`comotion redo` 會把它的原始位元組原封不動地寫回來。跟其他任何寫入命令共用同一個 undo/redo 堆疊，沒有另外一套資產匯入專用的復原邏輯。
