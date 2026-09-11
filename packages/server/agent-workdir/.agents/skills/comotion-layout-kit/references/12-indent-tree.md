# 12 · indent-tree

**解的關係**：`parent`
**單位數**：1 + 3–6
**一句話**：縮排的層級清單——最樸素、也最不會誤解的統轄關係。

**什麼時候用它**：一個東西分解成幾個子項，層數不超過三層。
**什麼時候不要用**：層級超過三層或每層項目很多——那需要 `nested-field` 的空間感。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<text x="120" y="220" font-size="28" fill="#2E2E2E" font-weight="700">根：一個整體</text><line x1="140" y1="240" x2="140" y2="560" stroke="#BFBFBF" stroke-width="2"/><line x1="140" y1="310" x2="210" y2="310" stroke="#BFBFBF" stroke-width="2"/><text x="232" y="319" font-size="24" fill="#777777">子項一</text><line x1="140" y1="420" x2="210" y2="420" stroke="#BFBFBF" stroke-width="2"/><text x="232" y="429" font-size="24" fill="#777777">子項二</text><line x1="140" y1="560" x2="210" y2="560" stroke="#BFBFBF" stroke-width="2"/><text x="232" y="569" font-size="24" fill="#777777">子項三</text><line x1="268" y1="430" x2="268" y2="500" stroke="#DDDDDD" stroke-width="2"/><line x1="268" y1="500" x2="338" y2="500" stroke="#DDDDDD" stroke-width="2"/><text x="360" y="509" font-size="20" fill="#A0A0A0">孫項</text><text x="700" y="310" font-size="20" fill="#A0A0A0">右側可留給說明或一張圖</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 根 | `node` | 被分解的那一個 | 12 字 | 1 |
| 子項 ×N | `node` | | 14 字 | 1 |
| 連接線 | `edge` | 縮排的直角線 | — | — |

## 節奏

每層縮排一個 `layout.gutter`。**同層的項目左緣必須完全對齊**——層級的可讀性全靠這個。字級每下一層小一級。

`blueprint.shape` 寫 `indent-tree`。

## 變體

- **無線版**：拿掉連接線，只靠縮排與字級。更安靜，但層級超過兩層就會看不清。
- **右側說明欄**：每個子項右邊配一句說明。
