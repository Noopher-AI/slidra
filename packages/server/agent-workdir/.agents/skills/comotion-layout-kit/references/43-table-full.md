# 43 · table-full

**解的關係**：`membership`
**單位數**：1（表格）
**一句話**：一張表格佔滿內容區——需要被查的資料，不是被看的圖。

**什麼時候用它**：欄位多、需要逐格比對（規格、價目、排程）。
**什麼時候不要用**：只有兩三列兩三欄——那不如用 30 `split-thirds` 或 01 `card-wall`，表格的格線會顯得小題大作。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="1120" height="72" fill="#E4E4E4" stroke="#BFBFBF"/><text x="112" y="222" font-size="24" fill="#2E2E2E" font-weight="700">表頭一</text><text x="432" y="222" font-size="24" fill="#2E2E2E" font-weight="700">表頭二</text><text x="752" y="222" font-size="24" fill="#2E2E2E" font-weight="700">表頭三</text><text x="1032" y="222" font-size="24" fill="#2E2E2E" font-weight="700">表頭四</text><rect x="80" y="248" width="1120" height="68" fill="#FFFFFF" stroke="#BFBFBF"/><text x="112" y="292" font-size="22" fill="#777777">儲存格</text><text x="432" y="292" font-size="22" fill="#777777">儲存格</text><text x="752" y="292" font-size="22" fill="#777777">儲存格</text><text x="1032" y="292" font-size="22" fill="#777777">儲存格</text><rect x="80" y="316" width="1120" height="68" fill="#FAFAFA" stroke="#BFBFBF"/><text x="112" y="360" font-size="22" fill="#777777">儲存格</text><text x="432" y="360" font-size="22" fill="#777777">儲存格</text><text x="752" y="360" font-size="22" fill="#777777">儲存格</text><text x="1032" y="360" font-size="22" fill="#777777">儲存格</text><rect x="80" y="384" width="1120" height="68" fill="#FFFFFF" stroke="#BFBFBF"/><text x="112" y="428" font-size="22" fill="#777777">儲存格</text><text x="432" y="428" font-size="22" fill="#777777">儲存格</text><text x="752" y="428" font-size="22" fill="#777777">儲存格</text><text x="1032" y="428" font-size="22" fill="#777777">儲存格</text><rect x="80" y="452" width="1120" height="68" fill="#FAFAFA" stroke="#BFBFBF"/><text x="112" y="496" font-size="22" fill="#777777">儲存格</text><text x="432" y="496" font-size="22" fill="#777777">儲存格</text><text x="752" y="496" font-size="22" fill="#777777">儲存格</text><text x="1032" y="496" font-size="22" fill="#777777">儲存格</text><text x="80" y="600" font-size="18" fill="#A0A0A0">資料來源與截止日期</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 表格 | `node`（table） | 表頭列必開 | — | — |
| 儲存格 | — | 每格 ≤ 10 字 | 10 字 | 1 |
| 來源 | `label`（`caption`） | 含資料截止日 | 24 字 | 1 |

## 節奏

**列數上限 7、欄數上限 5**——超過就不是簡報而是報表，該改發附件。數字欄右對齊、文字欄左對齊。表頭列用 `secondary_bg`，內容列用斑馬紋或不用，不要加垂直格線。

`blueprint.shape` 寫 `table-full`。

## 怎麼放進去

```
co-motion table create <id> slides/00N.svg --rows 5 --cols 4 --x 80 --y 176 --header true
co-motion table cell set <id> slides/00N.svg <element-id> --row 0 --col 0 --text '表頭一'
```

## 變體

- **首欄加寬**：第一欄放名稱，比其餘欄寬一倍。
- **搭配結論**：表格縮到 70% 寬，右側放一句「這張表要看的是什麼」。
