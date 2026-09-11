# 17 · before-after

**解的關係**：`contrast`
**單位數**：2
**一句話**：上下兩塊，中間一條分界——上面是之前，下面是之後。時間感比左右更強。

**什麼時候用它**：同一個東西的兩個時間點（改版前後、導入前後）。
**什麼時候不要用**：兩個不同的東西在比較——那用 `split-panel`，左右沒有時間暗示。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="1120" height="180" fill="#EDEDED" stroke="#BFBFBF"/><text x="120" y="224" font-size="28" fill="#555555" font-weight="700">之前</text><text x="120" y="286" font-size="24" fill="#777777">・內容一　　・內容二　　・內容三</text><line x1="80" y1="396" x2="1200" y2="396" stroke="#8A8A8A" stroke-width="4"/><text x="640" y="386" font-size="22" fill="#555555" text-anchor="middle">↓</text><rect x="80" y="436" width="1120" height="180" fill="#DCDCDC" stroke="#909090"/><text x="120" y="484" font-size="28" fill="#2E2E2E" font-weight="700">之後</text><text x="120" y="546" font-size="24" fill="#777777">・內容一　　・內容二　　・內容三</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 上下兩塊 | `node`（`field`） | 等高 | — | — |
| 區塊名 | `label` | 「之前」「之後」或日期 | 6 字 | 1 |
| 內容 | `label` | **兩邊條數必須一樣** | 每條 18 字 | 2–3 條 |
| 分界線 | `garnish` | 可加一個向下的箭頭 | — | — |

## 節奏

上下等高、內容首行對齊。**「之後」那塊的顏色要略深或加一條 accent 邊**——不然讀者分不出哪個是結果。

`blueprint.shape` 寫 `before-after`。

## 變體

- **左右版**：改成左右，時間感減弱但更適合並排比較長的清單。
- **三段**：之前／過程／之後，中段窄一點。
