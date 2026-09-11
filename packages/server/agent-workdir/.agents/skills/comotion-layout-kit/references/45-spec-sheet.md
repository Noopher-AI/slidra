# 45 · spec-sheet

**解的關係**：`membership`
**單位數**：1 圖 + 4–8 規格
**一句話**：左圖右規格表——產品頁的標準解，看得到東西也查得到數字。

**什麼時候用它**：實體產品、方案、硬體規格。
**什麼時候不要用**：規格只有兩三項——那用 26 `kpi-row`，表格會顯得繁瑣。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="520" height="440" fill="#D5D5D5" stroke="#BFBFBF"/><text x="340" y="400" font-size="24" fill="#777777" text-anchor="middle">產品圖</text><text x="660" y="232" font-size="22" fill="#A0A0A0">尺寸</text><text x="960" y="232" font-size="26" fill="#2E2E2E">數值</text><line x1="660" y1="262" x2="1200" y2="262" stroke="#E6E6E6" stroke-width="1"/><text x="660" y="340" font-size="22" fill="#A0A0A0">重量</text><text x="960" y="340" font-size="26" fill="#2E2E2E">數值</text><line x1="660" y1="370" x2="1200" y2="370" stroke="#E6E6E6" stroke-width="1"/><text x="660" y="448" font-size="22" fill="#A0A0A0">材質</text><text x="960" y="448" font-size="26" fill="#2E2E2E">數值</text><line x1="660" y1="478" x2="1200" y2="478" stroke="#E6E6E6" stroke-width="1"/><text x="660" y="556" font-size="22" fill="#A0A0A0">價格</text><text x="960" y="556" font-size="26" fill="#2E2E2E">數值</text><line x1="660" y1="586" x2="1200" y2="586" stroke="#E6E6E6" stroke-width="1"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
