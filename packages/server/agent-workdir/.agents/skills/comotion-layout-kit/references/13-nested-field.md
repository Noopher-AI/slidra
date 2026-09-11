# 13 · nested-field

**解的關係**：`parent`
**單位數**：1 + 2–4
**一句話**：大場域裡包著小場域——包含關係用「在裡面」直接表達，不需要線。

**什麼時候用它**：子項確實「屬於」母項的空間或範疇（一個系統內的模組、一個組織內的部門）。
**什麼時候不要用**：子項是母項的「步驟」或「屬性」而不是「成員」——那不是包含。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="140" y="180" width="1000" height="420" fill="#F5F5F5" stroke="#999999" stroke-width="2"/>
<text x="170" y="220" font-size="20" fill="#444444">母項（大 field）</text>
<rect x="190" y="250" width="280" height="300" fill="#E6E6E6" stroke="#AAAAAA"/>
<text x="220" y="290" font-size="16" fill="#555555">子項一</text>
<rect x="500" y="250" width="280" height="300" fill="#E6E6E6" stroke="#AAAAAA"/>
<text x="530" y="290" font-size="16" fill="#555555">子項二</text>
<rect x="810" y="250" width="280" height="300" fill="#E6E6E6" stroke="#AAAAAA"/>
<text x="840" y="290" font-size="16" fill="#555555">子項三</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 母場域 | `field` | 包住全部 | — | — |
| 母項名 | `label` | 放在母場域左上 | 12 字 | 1 |
| 子項 ×N | `node`（各自 `field`） | | 10 字 | 1 |
| 子項內文 | `label` | | 每條 16 字，2–3 條 | 1 |

## 節奏

母場域的內距至少一個 `layout.spacing` 的中級距——**內距太小會讓包含關係看起來像重疊**。子項等寬等高。

`blueprint.shape` 寫 `nested-field`。

## 變體

- **不等寬**：主要的子項佔 50%，其餘平分——當子項有主次時。
- **雙層**：子項裡再包孫項，但不要超過兩層。
