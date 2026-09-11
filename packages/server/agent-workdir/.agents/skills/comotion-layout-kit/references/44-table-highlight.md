# 44 · table-highlight

**解的關係**：`contrast`
**單位數**：1（表格）+ 1 強調
**一句話**：表格裡有一欄（或一列）被明顯標出——表是背景，被標的那一格才是主張。

**什麼時候用它**：在一組選項裡推薦其中一個，或指出一個異常值。
**什麼時候不要用**：沒有要推薦或指出任何東西——那用 43 `table-full`，強調會誤導。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="176" width="1120" height="60" fill="#E4E4E4" stroke="#AAAAAA"/>
<rect x="640" y="176" width="280" height="384" fill="#D8D8D8" stroke="#666666" stroke-width="3"/>
<text x="110" y="214" font-size="16" fill="#444444">項目　　　方案 A　　方案 B（推薦）　方案 C</text>
<rect x="80" y="236" width="1120" height="56" fill="#FFFFFF" stroke="#DDDDDD"/>
<rect x="80" y="292" width="1120" height="56" fill="#FAFAFA" stroke="#DDDDDD"/>
<rect x="80" y="348" width="1120" height="56" fill="#FFFFFF" stroke="#DDDDDD"/>
<text x="80" y="610" font-size="16" fill="#444444">推薦的理由（label）</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 表格 | `node`（table） | | — | — |
| 強調欄／列 | `node` | 底色加深或加 accent 邊框 | — | — |
| 理由 | `label` | **為什麼是它** | 24 字 | 1–2 |

## 節奏

**一頁只強調一處**。強調用底色或邊框二選一，不要同時用。理由那一行是必要的——被標記的格子自己不會說明為什麼。

`blueprint.shape` 寫 `table-highlight`。

## 怎麼放進去

```
co-motion table cell style set <id> slides/00N.svg <element-id> --row 0 --col 2 --fill '<secondary_bg>'
```

## 變體

- **標一列**：橫向強調某一個項目在各方案下的表現。
- **打叉**：不推薦的欄位用 `muted` 淡化而不是強調推薦的那欄——反向的做法有時更有說服力。
