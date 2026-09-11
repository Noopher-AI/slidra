# 08 · stepped

**解的關係**：`order`
**單位數**：3–5
**一句話**：逐階升高（或降低）的色塊，高度本身就是訊息——看得出是在增長還是收斂。

**什麼時候用它**：有量值變化的順序：成長、衰退、逐步逼近。
**什麼時候不要用**：純粹的步驟（沒有量的概念）——階梯會讓人以為後面的比前面的「更大」。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="160" y="480" width="200" height="120" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="190" y="550" font-size="16" fill="#666666">階段一</text>
<rect x="400" y="400" width="200" height="200" fill="#E4E4E4" stroke="#AAAAAA"/>
<text x="430" y="510" font-size="16" fill="#666666">階段二</text>
<rect x="640" y="300" width="200" height="300" fill="#D8D8D8" stroke="#999999"/>
<text x="670" y="460" font-size="16" fill="#444444">階段三</text>
<rect x="880" y="200" width="200" height="400" fill="#CCCCCC" stroke="#888888"/>
<text x="910" y="410" font-size="16" fill="#333333">階段四</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 階梯 ×N | `node`（`field`） | 高度反映量值 | — | — |
| 階段名 | `label` | | 10 字 | 1 |
| 量值 | `label` | 可省，放在色塊頂端 | 8 字 | 1 |

## 節奏

色塊等寬、底部對齊，**高度必須反映真實比例**——如果沒有真實數字，就不要用這個版面（那是在用視覺撒謊）。顏色隨高度加深。

`blueprint.shape` 寫 `stepped`。

## 變體

- **下降版**：由高到低，講收斂或成本下降。
- **加箭頭**：最後一階右上加一個箭頭，強化「還會繼續」。
