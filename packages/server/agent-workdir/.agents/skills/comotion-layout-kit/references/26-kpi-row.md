# 26 · kpi-row

**解的關係**：`membership`
**單位數**：3–4
**一句話**：一排大數字並列，每個配一行標籤——儀表板的第一行。

**什麼時候用它**：幾個同等重要的指標要一起看。**每個數字都要是真的。**
**什麼時候不要用**：指標之間有因果或順序——那要換 `flow` 或 `spine-path`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<text x="140" y="420" font-size="96" fill="#2E2E2E" font-weight="700">128</text><text x="140" y="470" font-size="24" fill="#777777">指標一</text><line x1="470" y1="330" x2="470" y2="440" stroke="#E0E0E0" stroke-width="1"/><text x="540" y="420" font-size="96" fill="#2E2E2E" font-weight="700">94%</text><text x="540" y="470" font-size="24" fill="#777777">指標二</text><line x1="870" y1="330" x2="870" y2="440" stroke="#E0E0E0" stroke-width="1"/><text x="920" y="420" font-size="96" fill="#2E2E2E" font-weight="700">3.2x</text><text x="920" y="470" font-size="24" fill="#777777">指標三</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 數字 ×N | `node`（`label`，`claim`～`number` 字級） | | 6 字 | 1 |
| 標籤 ×N | `label`（`caption`） | 數字代表什麼 | 10 字 | 1 |
| 分隔線 | `garnish` | 數字之間，可省 | — | — |

## 節奏

數字**基線對齊**（不是置中對齊）——位數不同時基線對齊才整齊。等距分布，標籤緊貼數字下方。

`blueprint.shape` 寫 `kpi-row`。

## 變體

- **加變化量**：每個數字右上角一個小的 ↑↓ 與變化百分比。
- **兩列**：六個指標分兩列三欄。
