# 29 · timeline-vertical

**解的關係**：`order`
**單位數**：4–7
**一句話**：垂直主軸由上而下，節點在軸上、說明在右——比水平時間軸能放更多站。

**什麼時候用它**：步驟或年份較多（五個以上），每站有一兩句說明。
**什麼時候不要用**：只有三站——水平的 `spine-path` 更有氣勢。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<line x1="200" y1="176" x2="200" y2="616" stroke="#8A8A8A" stroke-width="5"/><ellipse cx="200" cy="220" rx="22" ry="22" fill="#FFFFFF" stroke="#909090" stroke-width="4"/><text x="266" y="230" font-size="28" fill="#555555" font-weight="700">2021　第一站</text><text x="266" y="268" font-size="20" fill="#A0A0A0">一句說明</text><ellipse cx="200" cy="330" rx="22" ry="22" fill="#FFFFFF" stroke="#909090" stroke-width="4"/><text x="266" y="340" font-size="28" fill="#555555" font-weight="700">2023　第二站</text><text x="266" y="378" font-size="20" fill="#A0A0A0">一句說明</text><ellipse cx="200" cy="440" rx="22" ry="22" fill="#FFFFFF" stroke="#909090" stroke-width="4"/><text x="266" y="450" font-size="28" fill="#555555" font-weight="700">2025　第三站</text><text x="266" y="488" font-size="20" fill="#A0A0A0">一句說明</text><ellipse cx="200" cy="570" rx="22" ry="22" fill="#8A8A8A" stroke="#909090" stroke-width="4"/><text x="266" y="580" font-size="28" fill="#2E2E2E" font-weight="700">2026　現在</text><text x="266" y="618" font-size="20" fill="#A0A0A0">一句說明</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
