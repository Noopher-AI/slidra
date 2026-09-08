# `/comotion-chart` 示範輸入

在 `demo/` 打包出的示範簡報上執行，放到第 2 頁（`slides/002.svg`，畫布 1280×720）。

## 示範輸入

```
/comotion-chart 幫我把這組資料畫成長條圖，放在第 2 頁：類別 Q1、Q2、Q3，
營收 100、120、140，毛利 40、55、60，毛利放右軸，圖例放下面
```

## 預期結果

- `co-motion chart create <id> slides/002.svg --type bar ...` 成功並回傳一個 `elementId`。
- `co-motion chart data set <id> slides/002.svg <elementId> --categories Q1,Q2,Q3 --series '營收=100,120,140' --series '毛利=40,55,60'` 成功。
- `co-motion chart axis set <id> slides/002.svg <elementId> dual --right 毛利` 成功。
- `co-motion cat <id> slides/002.svg` 可看到 `<comot:chart type="bar" ... axes="dual" legend="bottom" ...>`，以及兩個 `<comot:series>`，`毛利` 的 `axis="right"`。
- agent 的回報裡列出圖表 element id、類型、類別與數列、以及軸／圖例設定。

## 不該發生的事

- 不使用 `--csv`／`--csv-asset`——agent 沒有寫檔能力，資料一律用 `--categories`／`--series`。
- 對已設定雙軸的圖表直接下 `chart stack set on` 會回「堆疊圖表必須是 axes=single」；agent 不應忽略這個錯誤或自行改用其他方式繞過，而是先切回 `single` 再堆疊，或向使用者說明兩者互斥。
- 不對 `pie`／`donut` 類型設定堆疊或雙軸。
