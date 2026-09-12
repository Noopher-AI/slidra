# table-full

**解的關係**：`membership`
**單位數**：1（表格）
**一句話**：一張表格佔滿內容區——需要被查的資料，不是被看的圖。

**什麼時候用它**：欄位多、需要逐格比對（規格、價目、排程）。
**什麼時候不要用**：只有兩三列兩三欄——那不如用 30 `split-thirds` 或 01 `card-wall`，表格的格線會顯得小題大作。

## 線框

完整 SVG：見同資料夾 `table-full.svg`。

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
slidra table create <id> slides/00N.svg --rows 5 --cols 4 --x 80 --y 176 --header true
slidra table cell set <id> slides/00N.svg <element-id> --row 0 --col 0 --text '表頭一'
```

## 變體

- **首欄加寬**：第一欄放名稱，比其餘欄寬一倍。
- **搭配結論**：表格縮到 70% 寬，右側放一句「這張表要看的是什麼」。
