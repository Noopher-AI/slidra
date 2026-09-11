# 18 · shared-axis

**解的關係**：`contrast`
**單位數**：2
**一句話**：中央一條基準軸，兩邊的項目往左右展開——共用的尺度看得最清楚。

**什麼時候用它**：兩邊在同一個維度上有量的差異（正負、增減、贊成反對）。
**什麼時候不要用**：兩邊比較的是性質而不是量——那用 `split-panel`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<line x1="640" y1="176" x2="640" y2="616" stroke="#8A8A8A" stroke-width="4"/><text x="360" y="206" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">左邊</text><text x="920" y="206" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">右邊</text><rect x="320" y="240" width="300" height="72" fill="#EDEDED" stroke="#BFBFBF"/><rect x="660" y="240" width="200" height="72" fill="#EDEDED" stroke="#BFBFBF"/><text x="300" y="286" font-size="20" fill="#A0A0A0" text-anchor="end">項目</text><rect x="200" y="340" width="420" height="72" fill="#EDEDED" stroke="#BFBFBF"/><rect x="660" y="340" width="300" height="72" fill="#EDEDED" stroke="#BFBFBF"/><text x="180" y="386" font-size="20" fill="#A0A0A0" text-anchor="end">項目</text><rect x="440" y="440" width="180" height="72" fill="#EDEDED" stroke="#BFBFBF"/><rect x="660" y="440" width="380" height="72" fill="#EDEDED" stroke="#BFBFBF"/><text x="420" y="486" font-size="20" fill="#A0A0A0" text-anchor="end">項目</text><rect x="360" y="540" width="260" height="72" fill="#EDEDED" stroke="#BFBFBF"/><rect x="660" y="540" width="140" height="72" fill="#EDEDED" stroke="#BFBFBF"/><text x="340" y="586" font-size="20" fill="#A0A0A0" text-anchor="end">項目</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 中軸 | `spine` | 共用的基準 | — | — |
| 兩側標頭 | `label` | | 6 字 | 1 |
| 橫條 ×N | `node` | 長度反映量值 | — | — |
| 項目名 | `label` | 放在軸的外側或條上 | 10 字 | 1 |

## 節奏

**橫條長度必須反映真實數字**。左右的列要對齊成同一排——同一列的左右兩條是同一個項目的兩個值。

`blueprint.shape` 寫 `shared-axis`。

## 變體

- **無量值版**：兩邊改成等長，只靠位置表達歸屬——這時它退化成一個更輕的 `split-panel`。
- **水平軸**：軸改成橫的，項目往上下展開，適合時間序的正負值。
