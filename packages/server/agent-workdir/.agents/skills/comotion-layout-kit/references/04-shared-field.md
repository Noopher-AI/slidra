# 04 · shared-field

**解的關係**：`membership`
**單位數**：3–6
**一句話**：所有單位放在同一塊大場域裡，靠細分隔線或留白分開——沒有個別的卡片，所以看起來是「一件事的幾個面向」而不是「幾件事」。

**什麼時候用它**：幾件事同屬一個更大的東西（一個系統的幾個模組、一份計畫的幾個面向）。
**什麼時候不要用**：幾件事其實各自獨立——那用 `card-wall`，個別的卡片才會讓它們看起來可以分開談。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="1120" height="440" fill="#EDEDED" stroke="#BFBFBF"/><text x="128" y="248" font-size="40" fill="#555555" font-weight="700">01</text><text x="232" y="246" font-size="24" fill="#777777">這個單位的一行關鍵詞</text><line x1="128" y1="304" x2="1152" y2="304" stroke="#DADADA" stroke-width="1"/><text x="128" y="388" font-size="40" fill="#555555" font-weight="700">02</text><text x="232" y="386" font-size="24" fill="#777777">這個單位的一行關鍵詞</text><line x1="128" y1="444" x2="1152" y2="444" stroke="#DADADA" stroke-width="1"/><text x="128" y="528" font-size="40" fill="#555555" font-weight="700">03</text><text x="232" y="526" font-size="24" fill="#777777">這個單位的一行關鍵詞</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | 這一頁的主張 | 15 字 | 1 |
| 大場域 | `field` | 涵蓋全部單位 | — | — |
| 單位 ×N | `node` | 每個一列 | — | — |
| 編號 | `label` | `01`… | 2 字 | 1 |
| 關鍵詞 | `label` | | 18 字 | 1–2 |
| 分隔線 | `garnish` | 單位之間，**最後一個之後不加** | — | — |

## 節奏

單位等高、分隔線落在中間。場域的高度由單位數決定，不要留一大塊空白在底部——寧可把場域縮短。

`blueprint.shape` 寫 `shared-field`。

## 變體

- **無線版**：拿掉分隔線，只靠留白分組，更安靜。
- **左標右文**：編號與關鍵詞分成左右兩欄，適合關鍵詞較長時。
