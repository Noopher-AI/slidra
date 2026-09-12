# `/slidra-table` 示範輸入

在 `demo/` 打包出的示範簡報上執行，放到第 2 頁（`slides/002.svg`，畫布 1280×720）。

## 示範輸入

```
/slidra-table 把這張表放到第 2 頁：

| 項目 | 數量 |
|---|---|
| 蘋果 | 3 |
| 香蕉 | 5 |

用 zebra 主題，要有標題列
```

## 預期結果

- `slidra table create <id> slides/002.svg --rows 3 --cols 2 --x 140 --y 200` 成功並回傳一個 `elementId`。
- `slidra table set <id> slides/002.svg <elementId> --markdown '...'` 成功，訊息為「已重寫 … 表格 … 的內容」。
- `slidra cat <id> slides/002.svg` 可看到 `data-slidra-type="table"`、`data-slidra-theme="zebra"`、`data-slidra-header="1"`，兩個資料列的儲存格文字為「蘋果／3」「香蕉／5」。
- agent 的回報裡列出建立的 element id、欄列數與主題。

## 不該發生的事

- 不使用 `asset import` 或 `chart data set --csv` 之類需要本機檔案路徑的旗標。
- 若使用者貼的是缺對齊列的 Markdown，agent 應主動補上對齊列並說明補了什麼，而不是直接報錯了事。
- 不使用雙引號；多行 Markdown 內容放在單引號內，用真正的換行分隔列。
