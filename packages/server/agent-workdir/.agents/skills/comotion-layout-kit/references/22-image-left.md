# 22 · image-left

**解的關係**：`membership`
**單位數**：1 + 2–4
**一句話**：左半一張滿高的圖，右半文字——圖文各佔一半，誰都不壓過誰。

**什麼時候用它**：有一張能說明主題的圖，而文字是它的解讀。
**什麼時候不要用**：圖只是裝飾。半個版面的圖必須真的承載內容，否則改用 `card-wall` 把空間讓給文字。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="0" y="0" width="560" height="720" fill="#E4E4E4" stroke="#AAAAAA"/>
<text x="200" y="370" font-size="20" fill="#777777">圖片（image）</text>
<text x="640" y="240" font-size="18" fill="#666666">要點一</text>
<text x="640" y="320" font-size="18" fill="#666666">要點二</text>
<text x="640" y="400" font-size="18" fill="#666666">要點三</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 圖片 | `node`（`image`） | 滿高出血 | — | — |
| 標題 | `label` | 移到右半上方 | 14 字 | 1 |
| 要點 ×N | `label` | | 每條 18 字 | 1–2 |

## 節奏

圖**出血到畫布邊**（x=0、y=0、滿高），不要留邊——留邊會讓它看起來像貼上去的。文字區的左緣從圖的右緣加一個 `gutter` 起算。

`blueprint.shape` 寫 `image-left`。

## 變體

- **右圖左文**：鏡像，適合閱讀方向要從文字開始時。
- **三七分**：圖佔 30%，文字更多。
