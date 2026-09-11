# 12 · indent-tree

**解的關係**：`parent`
**單位數**：1 + 3–6
**一句話**：縮排的層級清單——最樸素、也最不會誤解的統轄關係。

**什麼時候用它**：一個東西分解成幾個子項，層數不超過三層。
**什麼時候不要用**：層級超過三層或每層項目很多——那需要 `nested-field` 的空間感。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<text x="120" y="220" font-size="22" fill="#333333">根：一個整體</text>
<line x1="140" y1="240" x2="140" y2="520" stroke="#CCCCCC" stroke-width="2"/>
<line x1="140" y1="290" x2="200" y2="290" stroke="#CCCCCC" stroke-width="2"/>
<text x="220" y="298" font-size="18" fill="#666666">子項一</text>
<line x1="140" y1="370" x2="200" y2="370" stroke="#CCCCCC" stroke-width="2"/>
<text x="220" y="378" font-size="18" fill="#666666">子項二</text>
<line x1="260" y1="378" x2="260" y2="440" stroke="#DDDDDD" stroke-width="2"/>
<line x1="260" y1="440" x2="320" y2="440" stroke="#DDDDDD" stroke-width="2"/>
<text x="340" y="448" font-size="16" fill="#888888">孫項</text>
<line x1="140" y1="520" x2="200" y2="520" stroke="#CCCCCC" stroke-width="2"/>
<text x="220" y="528" font-size="18" fill="#666666">子項三</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
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
