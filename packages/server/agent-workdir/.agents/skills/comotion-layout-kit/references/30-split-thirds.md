# 30 · split-thirds

**解的關係**：`membership`
**單位數**：3
**一句話**：三個等寬直欄，各自從頂到底——比 `card-wall` 更適合每欄放多行文字。

**什麼時候用它**：剛好三件事，而且每件都有標題加幾行說明。
**什麼時候不要用**：四件以上（欄會太窄）或每件只有一句話（那用 `card-wall` 更省空間）。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="340" height="440" fill="#EDEDED" stroke="#BFBFBF"/><rect x="80" y="176" width="340" height="6" fill="#909090"/><text x="108" y="238" font-size="28" fill="#2E2E2E" font-weight="700">欄標1</text><text x="108" y="300" font-size="22" fill="#777777">・內文1</text><text x="108" y="348" font-size="22" fill="#777777">・內文2</text><text x="108" y="396" font-size="22" fill="#777777">・內文3</text><text x="108" y="444" font-size="22" fill="#777777">・內文4</text><rect x="470" y="176" width="340" height="440" fill="#EDEDED" stroke="#BFBFBF"/><rect x="470" y="176" width="340" height="6" fill="#909090"/><text x="498" y="238" font-size="28" fill="#2E2E2E" font-weight="700">欄標2</text><text x="498" y="300" font-size="22" fill="#777777">・內文1</text><text x="498" y="348" font-size="22" fill="#777777">・內文2</text><text x="498" y="396" font-size="22" fill="#777777">・內文3</text><text x="498" y="444" font-size="22" fill="#777777">・內文4</text><rect x="860" y="176" width="340" height="440" fill="#EDEDED" stroke="#BFBFBF"/><rect x="860" y="176" width="340" height="6" fill="#909090"/><text x="888" y="238" font-size="28" fill="#2E2E2E" font-weight="700">欄標3</text><text x="888" y="300" font-size="22" fill="#777777">・內文1</text><text x="888" y="348" font-size="22" fill="#777777">・內文2</text><text x="888" y="396" font-size="22" fill="#777777">・內文3</text><text x="888" y="444" font-size="22" fill="#777777">・內文4</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 欄 ×3 | `node`（`field`） | 等寬等高 | — | — |
| 頂線 ×3 | `garnish` | 同色（不同色會變成對照） | — | — |
| 欄標 ×3 | `label` | | 8 字 | 1 |
| 欄內文 ×3 | `label` | **三欄行數要一樣** | 每條 16 字 | 2–4 條 |

## 節奏

三欄等寬等高、欄標與首行基準線對齊。**頂線要同色**——顏色不同會讓人以為在比較，那是 `contrast` 不是 `membership`。

`blueprint.shape` 寫 `split-thirds`。

## 變體

- **中欄加重**：中間一欄略寬或底色較深，當它是主推的那一個。
- **四欄**：改成四欄，但每欄只能放標題加一句。
