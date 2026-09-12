頁數：5，沒有 `plan/` 計畫檔。

`/slidra-validate` 對這份 deck 跑完之後：`slidra validate` 只驗幾何與骨架（沒有計畫檔時字數、字級、配色、頁型都不驗），所以下表第 2～5 列由命令報什麼就釘什麼，不強制；**第 1 與第 6 列是 skill 的通讀步驟負責的，`comment list <presentation-id>` 一定要涵蓋這兩組 (頁, target) 配對**：

| # | 類別 | 頁 | target | 埋的問題 | 必須釘到 |
|---|---|---|---|---|---|
| 1 | 錯字 | 002 | `el-p2-body` | 「產品品直」應為「產品品質」 | ✅ |
| 2 | 標題層級不一致 | 003 | `el-p3-title` | font-size 28，其他內容頁標題都是 40 | 有計畫檔時由 `style.font-size` 抓 |
| 3 | 字級與顏色不統一 | 004 | `el-p4-body` | font-size 20 且 `fill="#CC0000"`，其他內文都是 24／`#333333` | 有計畫檔時由 `style.*` 抓 |
| 4 | 要點過長 | 004 | `el-p4-bullets` | 單條要點 80 字以上 | 有計畫檔時由 `text.bullet-length` 抓；沒有計畫檔時可能以 `geometry.*` 報出 |
| 5 | 缺標題頁 | 001 | `page` | 整份簡報沒有一頁是封面／標題頁，`slides/001.svg` 本身就是內容頁格式 | 有計畫檔時由 `roster.page-type` 抓 |
| 6 | 動畫順序與版面順序不合 | 005 | `el-p5-b` 或 `page`（擇一即算涵蓋） | 版面上 `el-p5-a`（y=200）在 `el-p5-b`（y=400）上方，但 `<slidra:effects>` 先播 `el-p5-b` 再播 `el-p5-a` | ✅ |

## 判定方式

- 第 1、6 列各要在 `comment list <presentation-id>` 的結果裡找到至少一則「頁面與 target 相符」的留言（留言文字不要求逐字比對，只要求指向正確的頁與 target）；`validate` 命令報出的每一筆錯誤也都要有對應的留言。
- **除了 `<slidra:comments>` 之外，五頁的其他內容必須完全不變。** 驗法：對每一頁 `cat <presentation-id> slides/00N.svg` 取回內容，把 `<metadata><slidra:comments xmlns:slidra="…">…</slidra:comments></metadata>` 這一段整段拿掉（執行前這些頁面本來就沒有 comments，所以拿掉的應該是這次新加的那一段），剩下的內容要跟這個 fixture 目錄裡對應的原始檔案逐位元組相同。

## 不算通過的樣子

- 第 1 或第 6 列沒有對應的留言，或 `validate` 報了錯卻沒有釘留言。
- 任何一頁除了新增留言之外，還有其他內容被改動（例如把錯字直接修正、把字級改一致）。
- 留言的 target 或頁碼指錯地方（例如把 003 的標題問題釘到 002）。
