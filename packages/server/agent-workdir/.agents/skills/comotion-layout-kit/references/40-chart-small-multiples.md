# 40 · chart-small-multiples

**解的關係**：`membership`
**單位數**：4–9
**一句話**：同一種圖表重複多個小格，每格一個對象——形狀的差異一眼可見。

**什麼時候用它**：多個對象的同一個指標（各分店、各月份、各產品線）。
**什麼時候不要用**：對象少於四個——那不如並排兩張大圖看得清楚。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="340" height="180" fill="#F4F4F4" stroke="#BFBFBF"/><text x="92" y="206" font-size="20" fill="#555555">對象1</text><rect x="470" y="176" width="340" height="180" fill="#F4F4F4" stroke="#BFBFBF"/><text x="482" y="206" font-size="20" fill="#555555">對象2</text><rect x="860" y="176" width="340" height="180" fill="#F4F4F4" stroke="#BFBFBF"/><text x="872" y="206" font-size="20" fill="#555555">對象3</text><rect x="80" y="400" width="340" height="180" fill="#F4F4F4" stroke="#BFBFBF"/><text x="92" y="430" font-size="20" fill="#555555">對象4</text><rect x="470" y="400" width="340" height="180" fill="#F4F4F4" stroke="#BFBFBF"/><text x="482" y="430" font-size="20" fill="#555555">對象5</text><rect x="860" y="400" width="340" height="180" fill="#F4F4F4" stroke="#BFBFBF"/><text x="872" y="430" font-size="20" fill="#555555">對象6</text><text x="80" y="630" font-size="22" fill="#777777">結論：這組形狀告訴我們什麼</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
