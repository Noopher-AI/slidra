# `/slidra-notes` 示範輸入

在 `demo/` 打包出的示範簡報上執行（四頁，`slides/001.svg`～`slides/004.svg`）。

## 示範輸入

```
/slidra-notes 幫每一頁補口語化的簡報者備忘稿
```

## 預期結果

- 四頁各跑一次 `slidra slide notes set <id> slides/00N.svg '<講稿>'`，各自成功。
- `slidra cat <id> slides/00N.svg` 每頁都能看到非空的 `<slidra:notes>...</slidra:notes>`。
- 講稿內容是口語、第一人稱，不是投影片文字的重抄。
- agent 的回報裡逐頁列出備忘稿內容或摘要。

## 不該發生的事

- 不在該頁已有備忘稿的情況下未經確認直接覆蓋（`slide notes set` 是整份覆寫，沒有 append）。
- 不使用雙引號；講稿內容不含單引號（例如英文所有格），不得用反斜線跳脫。
- 不把投影片上的文字原文重抄一遍當備忘稿。
