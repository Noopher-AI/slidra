# 38 · chart-pair

**解的關係**：`contrast`
**單位數**：2
**一句話**：兩張圖表並排，共用同一組座標與圖例——比較兩組數據時，一致的尺度是唯一重要的事。

**什麼時候用它**：同一個指標的兩個對象、兩個時期、兩種情境。
**什麼時候不要用**：兩組數據的量級差很多——同尺度會讓小的那組看不見，改用 27 `chart-focus` 分兩頁講。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="176" width="540" height="340" fill="#F4F4F4" stroke="#AAAAAA"/>
<text x="300" y="350" font-size="16" fill="#888888">圖表 A</text>
<rect x="660" y="176" width="540" height="340" fill="#F4F4F4" stroke="#AAAAAA"/>
<text x="880" y="350" font-size="16" fill="#888888">圖表 B</text>
<text x="80" y="556" font-size="18" fill="#444444">對象 A</text>
<text x="660" y="556" font-size="18" fill="#444444">對象 B</text>
<text x="80" y="600" font-size="16" fill="#666666">結論：一句話說明兩者的差異</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 圖表 ×2 | `node`（chart） | **座標範圍必須一致** | — | — |
| 標籤 ×2 | `label` | | 8 字 | 1 |
| 結論 | `label` | 差異在哪、代表什麼 | 24 字 | 1–2 |

## 節奏

兩張圖等寬等高。**Y 軸的範圍要手動統一**——自動縮放會讓兩張圖各自佔滿高度，那是最常見的視覺謊言。圖例只放一次（放在兩圖之間或下方）。

`blueprint.shape` 寫 `chart-pair`。

## 怎麼放進去

```
co-motion chart add <id> slides/00N.svg --type bar --x 80 --y 176 --width 540 --height 340
co-motion chart data set <id> slides/00N.svg <element-id> --categories 'Q1,Q2,Q3' --series '對象A=12,18,24'
```

## 變體

- **上下版**：兩圖上下排，X 軸共用——時間序比較更清楚。
- **疊圖**：兩組數列畫在同一張圖上（`chart axis` 的 `dual` 模式），當兩者真的該直接對照時。
