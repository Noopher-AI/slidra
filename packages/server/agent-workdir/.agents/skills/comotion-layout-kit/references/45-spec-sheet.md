# 45 · spec-sheet

**解的關係**：`membership`
**單位數**：1 圖 + 4–8 規格
**一句話**：左圖右規格表——產品頁的標準解，看得到東西也查得到數字。

**什麼時候用它**：實體產品、方案、硬體規格。
**什麼時候不要用**：規格只有兩三項——那用 26 `kpi-row`，表格會顯得繁瑣。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="176" width="520" height="420" fill="#E4E4E4" stroke="#AAAAAA"/>
<text x="290" y="400" font-size="18" fill="#888888">產品圖</text>
<g font-size="16">
<text x="660" y="210" fill="#777777">尺寸</text><text x="960" y="210" fill="#333333">數值</text>
<line x1="660" y1="230" x2="1200" y2="230" stroke="#EEEEEE"/>
<text x="660" y="280" fill="#777777">重量</text><text x="960" y="280" fill="#333333">數值</text>
<line x1="660" y1="300" x2="1200" y2="300" stroke="#EEEEEE"/>
<text x="660" y="350" fill="#777777">材質</text><text x="960" y="350" fill="#333333">數值</text>
<line x1="660" y1="370" x2="1200" y2="370" stroke="#EEEEEE"/>
<text x="660" y="420" fill="#777777">價格</text><text x="960" y="420" fill="#333333">數值</text>
</g>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | 產品或方案名 | 14 字 | 1 |
| 圖 | `node`（`image`） | 左側 | — | — |
| 規格列 ×N | `node` | 項目名 + 值 | — | — |
| 項目名 | `label` | 用 `muted` | 8 字 | 1 |
| 值 | `label` | 用 `text`，右側對齊 | 12 字 | 1 |

## 節奏

項目名與值分成兩個對齊的直欄，中間用細分隔線而不是格線。**項目名比值淡**——查表的人在找值，不是在找項目名。

`blueprint.shape` 寫 `spec-sheet`。

## 變體

- **雙欄規格**：規格分成兩直欄，容納八項以上。
- **無圖**：拿掉圖，規格佔滿版——但那其實就是 43 `table-full`。
