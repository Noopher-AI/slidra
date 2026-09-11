# 40 · chart-small-multiples

**解的關係**：`membership`
**單位數**：4–9
**一句話**：同一種圖表重複多個小格，每格一個對象——形狀的差異一眼可見。

**什麼時候用它**：多個對象的同一個指標（各分店、各月份、各產品線）。
**什麼時候不要用**：對象少於四個——那不如並排兩張大圖看得清楚。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<g fill="#F4F4F4" stroke="#AAAAAA">
<rect x="80" y="176" width="340" height="180"/><rect x="470" y="176" width="340" height="180"/><rect x="860" y="176" width="340" height="180"/>
<rect x="80" y="396" width="340" height="180"/><rect x="470" y="396" width="340" height="180"/><rect x="860" y="396" width="340" height="180"/>
</g>
<g font-size="14" fill="#777777">
<text x="90" y="200">對象一</text><text x="480" y="200">對象二</text><text x="870" y="200">對象三</text>
<text x="90" y="420">對象四</text><text x="480" y="420">對象五</text><text x="870" y="420">對象六</text>
</g>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 小圖 ×N | `node`（chart） | **全部同尺度同尺寸** | — | — |
| 小圖標籤 | `label`（`caption`） | 對象名 | 8 字 | 1 |
| 結論 | `label` | 這組形狀告訴我們什麼 | 24 字 | 1 |

## 節奏

每格等大、**Y 軸範圍全部一致**——這個版面的全部價值就在「形狀可以互相比較」，尺度一不同就毀了。座標軸刻度只在左下那一格標出，其餘省略。

`blueprint.shape` 寫 `chart-small-multiples`。

## 變體

- **排序**：依數值大小排列而不是依名稱，形狀的趨勢會浮出來。
- **標出異常**：其中一兩格用 accent 邊框標記。
