# 28 · matrix-2x2

**解的關係**：`contrast`
**單位數**：4
**一句話**：兩軸切出四個象限，每格一個位置——同時比較兩個維度。

**什麼時候用它**：有兩個獨立的維度，而項目落在不同象限（成本與效益、緊急與重要）。
**什麼時候不要用**：只有一個維度。四格會逼你硬湊出四個項目。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<line x1="640" y1="176" x2="640" y2="616" stroke="#8A8A8A" stroke-width="3"/><line x1="120" y1="396" x2="1160" y2="396" stroke="#8A8A8A" stroke-width="3"/><text x="600" y="196" font-size="18" fill="#A0A0A0" text-anchor="end">高</text><text x="1160" y="424" font-size="18" fill="#A0A0A0" text-anchor="end">高</text><rect x="150" y="216" width="440" height="150" fill="#EDEDED" stroke="#BFBFBF"/><text x="180" y="300" font-size="24" fill="#777777">象限一</text><rect x="690" y="216" width="440" height="150" fill="#DCDCDC" stroke="#909090"/><text x="720" y="300" font-size="24" fill="#2E2E2E">象限二（重點）</text><rect x="150" y="426" width="440" height="150" fill="#EDEDED" stroke="#BFBFBF"/><text x="180" y="510" font-size="24" fill="#777777">象限三</text><rect x="690" y="426" width="440" height="150" fill="#EDEDED" stroke="#BFBFBF"/><text x="720" y="510" font-size="24" fill="#777777">象限四</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 兩軸 | `spine` ×2 | 各自標出方向 | — | — |
| 軸標 ×4 | `label`（`caption`） | 高／低、各維度的名字 | 6 字 | 1 |
| 象限 ×4 | `node`（`field`） | | — | — |
| 象限內容 | `label` | | 16 字 | 1–2 |

## 節奏

四格等大。**通常有一格是重點**（你想帶大家去的那一格），那一格加深或加 accent 邊——四格一樣重會讓人不知道要看哪。

`blueprint.shape` 寫 `matrix-2x2`。

## 變體

- **只填兩格**：只有對角的兩格有內容，強調取捨。
- **散點版**：拿掉格線，改成在象限裡散布圓點，每點一個項目。
