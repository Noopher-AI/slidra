# image-caption-strip

**解的關係**：`none`
**單位數**：1
**一句話**：一張大圖佔上方三分之二，下方一條說明帶——圖是主體，文字是圖說而不是論述。

**什麼時候用它**：一張圖本身就能說明事情（產品照、現場照、示意圖），文字只需要一兩句。
**什麼時候不要用**：文字其實是重點——那用 22 `image-left`，把一半版面還給文字。

## 線框

```xm完整 SVG：見同資料夾 `image-caption-strip.svg`。槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 圖片 | `node`（`image`） | 3:1～16:9 的橫幅 | — | — |
| 圖說 | `label` | 說明**這張圖在說什麼**，不是圖的內容 | 26 字 | 1 |
| 出處 | `label`（`caption`） | 可省 | 20 字 | 1 |

## 節奏

圖的寬度等於安全區寬。說明帶緊貼圖的下緣（不留空隙），用 `secondary_bg` 當底——它是圖的一部分，不是獨立的區塊。

`blueprint.shape` 寫 `image-caption-strip`。

## 怎麼放進去

```
co-motion asset import <id> <圖片路徑或 URL>
co-motion element insert image <id> slides/00N.svg --x 80 --y 160 --width 1120 --height 380 --media assets/<檔名>
```

## 變體

- **說明帶壓在圖上**：把說明帶改成半透明疊在圖的下緣，更緊湊。
- **雙圖**：上方並排兩張圖，共用同一條說明帶。
