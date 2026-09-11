# 17 · before-after

**解的關係**：`contrast`
**單位數**：2
**一句話**：上下兩塊，中間一條分界——上面是之前，下面是之後。時間感比左右更強。

**什麼時候用它**：同一個東西的兩個時間點（改版前後、導入前後）。
**什麼時候不要用**：兩個不同的東西在比較——那用 `split-panel`，左右沒有時間暗示。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="170" width="1120" height="200" fill="#F2F2F2" stroke="#AAAAAA"/>
<text x="110" y="210" font-size="20" fill="#666666">之前</text>
<text x="110" y="260" font-size="16" fill="#888888">內容（label）</text>
<line x1="80" y1="390" x2="1200" y2="390" stroke="#666666" stroke-width="3"/>
<text x="590" y="382" font-size="16" fill="#444444">↓</text>
<rect x="80" y="410" width="1120" height="200" fill="#E4E4E4" stroke="#888888"/>
<text x="110" y="450" font-size="20" fill="#333333">之後</text>
<text x="110" y="500" font-size="16" fill="#666666">內容（label）</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
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
