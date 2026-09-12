# `/comotion-style` 示範輸入

在 `demo/` 打包出的示範簡報上執行（四頁，`slides/001.svg`～`slides/004.svg`，畫布 1280×720；此份簡報沒有文字框，皆為純 `<text>` 元素）。

## 示範輸入

```
/comotion-style 把第 1 頁的標題字級改成 72，標題跟副標的顏色都改成 #F4F6F8
```

## 預期結果

- `comotion cat <id> slides/001.svg` 可看到 `el-title` 的 `font-size="72"`。
- `el-title` 與 `el-subtitle` 的 `fill="#F4F6F8"`。
- agent 的回報裡列出改動的 element id、屬性、新值。

## 不該發生的事

- 不嘗試設定 `line-height`／行距——這是唯一一條「拒絕執行」的要求；agent 應明確回答目前不支援，不得改 `y` 座標或加空行假造效果。
- 不對表格或圖表元素直接用 `element style set`。
- 不使用雙引號；顏色值需以單引號包住並保留 `#`。
