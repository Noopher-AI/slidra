# 49 · infographic

**解的關係**：`membership`
**單位數**：2–5
**一句話**：平行的直欄，每欄一個圖示、一個編號、一句極簡標籤——資訊圖的標準解。

**什麼時候用它**：幾件並列的事，而且每件都能用一個圖示代表（步驟摘要、KPI 概覽、要素清單）。
**什麼時候不要用**：每件事需要兩行以上的說明——圖示會變成裝飾，改用 `30 split-thirds`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="200" width="250" height="340" fill="#EDEDED" stroke="#BFBFBF"/><ellipse cx="205" cy="290" rx="44" ry="44" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><text x="205" y="300" font-size="24" fill="#A0A0A0" text-anchor="middle">圖示</text><text x="205" y="400" font-size="32" fill="#555555" font-weight="700" text-anchor="middle">01</text><text x="205" y="450" font-size="22" fill="#777777" text-anchor="middle">極簡標籤</text><rect x="370" y="200" width="250" height="340" fill="#EDEDED" stroke="#BFBFBF"/><ellipse cx="495" cy="290" rx="44" ry="44" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><text x="495" y="300" font-size="24" fill="#A0A0A0" text-anchor="middle">圖示</text><text x="495" y="400" font-size="32" fill="#555555" font-weight="700" text-anchor="middle">02</text><text x="495" y="450" font-size="22" fill="#777777" text-anchor="middle">極簡標籤</text><rect x="660" y="200" width="250" height="340" fill="#EDEDED" stroke="#BFBFBF"/><ellipse cx="785" cy="290" rx="44" ry="44" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><text x="785" y="300" font-size="24" fill="#A0A0A0" text-anchor="middle">圖示</text><text x="785" y="400" font-size="32" fill="#555555" font-weight="700" text-anchor="middle">03</text><text x="785" y="450" font-size="22" fill="#777777" text-anchor="middle">極簡標籤</text><rect x="950" y="200" width="250" height="340" fill="#EDEDED" stroke="#BFBFBF"/><ellipse cx="1075" cy="290" rx="44" ry="44" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><text x="1075" y="300" font-size="24" fill="#A0A0A0" text-anchor="middle">圖示</text><text x="1075" y="400" font-size="32" fill="#555555" font-weight="700" text-anchor="middle">04</text><text x="1075" y="450" font-size="22" fill="#777777" text-anchor="middle">極簡標籤</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 欄 ×N | `node`（`field`） | 等寬等高 | — | — |
| 圖示 | `node` | 每欄一個，同一套圖示庫 | — | — |
| 編號 | `label` | | 2 字 | 1 |
| 標籤 | `label` | **極簡**，一行 | 10 字 | 1 |

## 節奏

欄等寬等高、圖示垂直位置一致。**標籤要極簡**——這個版面的價值在於一眼掃完，一旦文字變多就失去意義。四欄是甜蜜點，五欄是上限。

`blueprint.shape` 寫 `infographic`。

## 變體

- **無框**：拿掉欄的底色，只靠圖示與間距分組。
- **加數值**：標籤下面再放一個數字，變成 KPI 概覽。
