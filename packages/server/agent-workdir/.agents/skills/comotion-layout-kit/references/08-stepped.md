# 08 · stepped

**解的關係**：`order`
**單位數**：3–5
**一句話**：逐階升高（或降低）的色塊，高度本身就是訊息——看得出是在增長還是收斂。

**什麼時候用它**：有量值變化的順序：成長、衰退、逐步逼近。
**什麼時候不要用**：純粹的步驟（沒有量的概念）——階梯會讓人以為後面的比前面的「更大」。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="160" y="476" width="220" height="140" fill="#EDEDED" stroke="#BFBFBF"/><text x="270" y="458" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">數值</text><text x="270" y="554" font-size="24" fill="#777777" text-anchor="middle">階段1</text><rect x="400" y="376" width="220" height="240" fill="#EDEDED" stroke="#BFBFBF"/><text x="510" y="358" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">數值</text><text x="510" y="504" font-size="24" fill="#777777" text-anchor="middle">階段2</text><rect x="640" y="286" width="220" height="330" fill="#EDEDED" stroke="#BFBFBF"/><text x="750" y="268" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">數值</text><text x="750" y="459" font-size="24" fill="#777777" text-anchor="middle">階段3</text><rect x="880" y="176" width="220" height="440" fill="#DCDCDC" stroke="#BFBFBF"/><text x="990" y="158" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">數值</text><text x="990" y="404" font-size="24" fill="#777777" text-anchor="middle">階段4</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
