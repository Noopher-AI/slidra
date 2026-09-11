# 29 · timeline-vertical

**解的關係**：`order`
**單位數**：4–7
**一句話**：垂直主軸由上而下，節點在軸上、說明在右——比水平時間軸能放更多站。

**什麼時候用它**：步驟或年份較多（五個以上），每站有一兩句說明。
**什麼時候不要用**：只有三站——水平的 `spine-path` 更有氣勢。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<line x1="200" y1="170" x2="200" y2="620" stroke="#666666" stroke-width="4"/>
<ellipse cx="200" cy="210" rx="16" ry="16" fill="#FFFFFF" stroke="#666666" stroke-width="3"/>
<text x="250" y="205" font-size="18" fill="#444444">2021　第一站</text>
<text x="250" y="235" font-size="14" fill="#888888">說明</text>
<ellipse cx="200" cy="330" rx="16" ry="16" fill="#FFFFFF" stroke="#666666" stroke-width="3"/>
<text x="250" y="325" font-size="18" fill="#444444">2023　第二站</text>
<ellipse cx="200" cy="450" rx="16" ry="16" fill="#FFFFFF" stroke="#666666" stroke-width="3"/>
<text x="250" y="445" font-size="18" fill="#444444">2025　第三站</text>
<ellipse cx="200" cy="570" rx="18" ry="18" fill="#666666"/>
<text x="250" y="565" font-size="18" fill="#222222">2026　現在（填實）</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 主軸 | `spine` | 一條，滿高 | — | — |
| 節點 ×N | `node` | **最後一個填實** | — | — |
| 年份／站名 | `label` | | 10 字 | 1 |
| 說明 | `label` | 可省 | 20 字 | 1–2 |

## 節奏

節點等距。說明**一律在軸的同一側**——左右交錯會讓閱讀順序變得不確定。最後一個節點填實或加大，端點才分得出來。

`blueprint.shape` 寫 `timeline-vertical`。

## 變體

- **分段**：用兩三條較粗的橫線把時間軸分成幾個時期。
- **未來虛線**：已發生的用實線、未來的用虛線。
