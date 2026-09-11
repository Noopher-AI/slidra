# 18 · shared-axis

**解的關係**：`contrast`
**單位數**：2
**一句話**：中央一條基準軸，兩邊的項目往左右展開——共用的尺度看得最清楚。

**什麼時候用它**：兩邊在同一個維度上有量的差異（正負、增減、贊成反對）。
**什麼時候不要用**：兩邊比較的是性質而不是量——那用 `split-panel`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<line x1="640" y1="170" x2="640" y2="600" stroke="#666666" stroke-width="3"/>
<text x="300" y="160" font-size="18" fill="#666666">左邊</text>
<text x="900" y="160" font-size="18" fill="#666666">右邊</text>
<rect x="380" y="210" width="240" height="60" fill="#E8E8E8" stroke="#AAAAAA"/>
<rect x="660" y="210" width="160" height="60" fill="#E8E8E8" stroke="#AAAAAA"/>
<rect x="300" y="300" width="320" height="60" fill="#E8E8E8" stroke="#AAAAAA"/>
<rect x="660" y="300" width="280" height="60" fill="#E8E8E8" stroke="#AAAAAA"/>
<rect x="460" y="390" width="160" height="60" fill="#E8E8E8" stroke="#AAAAAA"/>
<rect x="660" y="390" width="360" height="60" fill="#E8E8E8" stroke="#AAAAAA"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
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
