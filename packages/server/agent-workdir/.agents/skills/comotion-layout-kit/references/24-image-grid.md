# 24 · image-grid

**解的關係**：`membership`
**單位數**：3–6
**一句話**：等大的圖片格陣，每張配一行說明——作品集、案例、產品線的標準解。

**什麼時候用它**：有多張同性質的圖要並列。
**什麼時候不要用**：圖的重要性不一樣，或只有一兩張——那應該給其中一張更大的空間。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="176" width="340" height="200" fill="#E4E4E4" stroke="#AAAAAA"/>
<text x="80" y="400" font-size="16" fill="#666666">說明一</text>
<rect x="470" y="176" width="340" height="200" fill="#E4E4E4" stroke="#AAAAAA"/>
<text x="470" y="400" font-size="16" fill="#666666">說明二</text>
<rect x="860" y="176" width="340" height="200" fill="#E4E4E4" stroke="#AAAAAA"/>
<text x="860" y="400" font-size="16" fill="#666666">說明三</text>
<rect x="80" y="430" width="340" height="200" fill="#E4E4E4" stroke="#AAAAAA"/>
<rect x="470" y="430" width="340" height="200" fill="#E4E4E4" stroke="#AAAAAA"/>
<rect x="860" y="430" width="340" height="200" fill="#E4E4E4" stroke="#AAAAAA"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 圖 ×N | `node`（`image`） | **裁切成同一個比例** | — | — |
| 說明 ×N | `label` | 在各自圖的下方 | 12 字 | 1 |

## 節奏

圖**一定要同比例同尺寸**——大小不一的格陣會讓人以為有主次。間距用 `gutter`，六張時分兩列三欄。

`blueprint.shape` 寫 `image-grid`。

## 變體

- **不等格**：第一張佔兩格，其餘平分——當有一張明顯是主角時。
- **無說明**：拿掉文字，純圖牆，適合作品集。
