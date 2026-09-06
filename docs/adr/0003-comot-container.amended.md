# 簡報是單一 `.comot` 容器檔，工作目錄隱藏

> **⚠️ 部分條款已失效。** 「內部結構為 `project.json` + `slides/00N.svg` + `assets/`」由 **ADR-0016** 擴充為四個目錄：新增 `fonts/`，登記在 `project.json` 新增的 optional `fonts` 欄位裡。**其餘部分**（`project.json` 只放 SVG 表達不了的東西、`formatVersion` 不可省略、頁面順序用陣列）不受影響。

使用者期待簡報是「一個檔案」，可以複製、寄送、備份。但編輯期間維持壓縮狀態不可行——一份含影片的簡報，改一個字就要重壓幾十 MB。

因此 `.comot` 是儲存與運輸格式（zip），`co-motion open` 將其解壓到 `~/.comotion/work/<id>/` 進行編輯，關閉或儲存時重新打包。這是 Keynote 與 LibreOffice 的模型。

工作目錄刻意放在使用者與 agent 都不會經過的位置，而不是與 `.comot` 同層——見 ADR-0004。

## Consequences

- 內部結構為 `project.json` + `slides/00N.svg` + `assets/`。**字型的第四個目錄 `fonts/` 見 ADR-0016。**
- `project.json` 只放 SVG 表達不了的東西：`formatVersion`、`name`、`canvas`、`slides` 順序陣列（**及 ADR-0016 新增的 `fonts` 陣列**）。共用樣式不放這裡，否則單獨開啟一張投影片會缺色，違反 ADR-0001。
- `formatVersion` 不可省略，它是未來遷移舊檔的唯一依據。
- 頁面順序用明確陣列而非檔名排序，避免調整順序時大量改名。
- **[E2.T8]**：作者釘在簡報上的留言不在 `project.json`，在各投影片 SVG 自己的 `<metadata>` 裡，詳見 ADR-0008。
