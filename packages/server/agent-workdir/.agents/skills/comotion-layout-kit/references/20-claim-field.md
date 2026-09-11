# 20 · claim-field

**解的關係**：`none`
**單位數**：1
**一句話**：一句話佔滿版面，其餘全是留白——最強的一種頁面，因為它什麼都不解釋。

**什麼時候用它**：章節轉場、開場的主張、結語的結論。
**什麼時候不要用**：需要證據或說明的內容。這個版面沒有地方放依據。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<text x="140" y="330" font-size="48" fill="#333333">一句帶得走的主張</text>
<text x="140" y="400" font-size="48" fill="#333333">可以到第二行</text>
<rect x="140" y="240" width="80" height="6" fill="#999999"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 短棒或標籤 | `garnish` / `label` | 可省 | 6 字 | 1 |
| 主張 | `label`（`claim` 或 `section` 字級） | ≤ 2 行 | 22 字 | 1–2 |
| 補充 | `label` | 可省，字級降兩級 | 20 字 | 1 |

## 節奏

主張貼左緣、垂直置中偏上。**留白不是沒排完，是內容的一部分**——不要因為覺得空就加東西。

`blueprint.shape` 寫 `claim-field`。

## 變體

- **置中版**：主張水平置中，更像海報。
- **編號浮水印**：右下放一個超大的章節編號（裸 `<text>`、`garnish`、opacity 0.18）。
