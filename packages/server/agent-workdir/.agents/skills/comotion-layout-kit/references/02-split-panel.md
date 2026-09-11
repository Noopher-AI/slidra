# 02 · split-panel

**解的關係**：`contrast`（A vs B、之前／之後、選項比較）
**單位數**：2
**一句話**：左右等寬等高的面板，兩欄共用同一條基準線——差異看得出來，是因為其他東西都一樣。

**什麼時候用它**：兩個東西在同一個維度上比較。
**什麼時候不要用**：三個以上的東西（那是 `membership` 或要換 `shared-axis`）；兩者其實有先後（那是 `order`）。

**最容易做錯的一件事**：兩欄條數不一樣多、欄標高度不齊。**對比的力量來自不變量對齊**，一旦兩邊排版不同，讀者會先看到排版差異而不是內容差異。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="520" height="440" fill="#EDEDED" stroke="#BFBFBF"/><rect x="80" y="176" width="520" height="6" fill="#909090"/><text x="112" y="232" font-size="28" fill="#2E2E2E" font-weight="700">左欄標</text><text x="112" y="296" font-size="24" fill="#777777">・左欄要點一</text><text x="112" y="344" font-size="24" fill="#777777">・左欄要點二</text><text x="112" y="392" font-size="24" fill="#777777">・左欄要點三</text><rect x="680" y="176" width="520" height="440" fill="#EDEDED" stroke="#BFBFBF"/><rect x="680" y="176" width="520" height="6" fill="#6E6E6E"/><text x="712" y="232" font-size="28" fill="#2E2E2E" font-weight="700">右欄標</text><text x="712" y="296" font-size="24" fill="#777777">・右欄要點一</text><text x="712" y="344" font-size="24" fill="#777777">・右欄要點二</text><text x="712" y="392" font-size="24" fill="#777777">・右欄要點三</text><ellipse cx="640" cy="396" rx="44" ry="44" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><text x="640" y="406" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">VS</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | 這一頁的主張（通常是「A vs B」） | 15 字（上限 24） | 1 |
| 左／右面板 | `node`（內含 `field`） | 各一方 | — | — |
| 頂線 ×2 | `garnish` | 左 `primary`、右 `secondary_accent`——**顏色是兩邊唯一該不同的東西** | — | — |
| 欄標 ×2 | `label` | 這一欄是誰 | 8 字 | 1 |
| 欄內文 ×2 | `label` | 條列，**兩欄條數必須一樣** | 每條 18 字（上限 32） | 2–4 條 |
| VS 圓 | `node` 的分界（不是 `garnish`） | 可省 | 2 字 | 1 |
| 頁尾三件 | — | | — | — |

## 節奏

兩欄等寬（各佔安全區的 40%，中間留 `gutter × 2` 以上）、等高、頂線對齊、首行基準線對齊。**條數不一樣時，補到一樣或刪到一樣**，不要留一欄空著。

`blueprint.shape` 寫 `split-panel`；`type` 可一併填 `compare`。

**動畫**：3 步——標題 → 左欄整組 → 右欄整組。VS 圓跟左欄一起（它是分界，不該自成一步）。

## 變體

- **上下對照**（`before-after`）：改成上下兩塊，中間一條分界線。適合「之前／之後」這種有時間感的對比。
- **共用基準線**（`shared-axis`）：拿掉面板，只留中央一條垂直軸線，兩邊的項目往兩側展開——更輕，適合項目少的時候。
