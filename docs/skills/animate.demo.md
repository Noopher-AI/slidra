# `/comotion-animate` 示範輸入

在 `demo/` 打包出的示範簡報上執行（四頁，`slides/001.svg`～`slides/004.svg`，畫布 1280×720）。

## 示範輸入

```
/comotion-animate 幫第 1 頁加上依序揭露的動畫，標題先出現，副標接著出現
```

## 預期結果

- `comotion effect list <id> slides/001.svg` 回傳 2 個效果項：
  - `index 1`：`target: el-title`、`family: enter`、`effect: fade`、`start: on-click`
  - `index 2`：`target: el-subtitle`、`family: enter`、`effect: fade`、`start: after-previous`
- `comotion cat <id> slides/001.svg` 可看到 `<comot:effect target="el-title" family="enter" effect="fade" start="on-click" .../>` 與對應的 `el-subtitle` 項。
- agent 的回報裡列出兩個元素各自的 family/effect/start/duration。

## 不該發生的事

- 不對沒有 `data-comot-name` 的元素加效果。
- 不使用雙引號或反斜線。
- 不在沒有先讀 `effect list` 的情況下對已有效果的頁（例如 `slides/003.svg`）直接疊加效果。
