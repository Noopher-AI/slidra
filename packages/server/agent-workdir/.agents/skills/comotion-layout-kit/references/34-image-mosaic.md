# 34 · image-mosaic

**解的關係**：`membership`
**單位數**：4–7
**一句話**：不等大的圖片馬賽克，一張主圖配幾張小圖——比格陣有層次，適合有主次的一組圖。

**什麼時候用它**：一組圖裡有一張明顯是主角（主視覺、代表作、封面照）。
**什麼時候不要用**：所有圖同等重要——那用 24 `image-grid`，等大才不會誤導。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="640" height="440" fill="#D5D5D5" stroke="#909090"/><text x="400" y="400" font-size="24" fill="#777777" text-anchor="middle">主圖</text><rect x="740" y="176" width="220" height="210" fill="#E4E4E4" stroke="#BFBFBF"/><rect x="980" y="176" width="220" height="210" fill="#E4E4E4" stroke="#BFBFBF"/><rect x="740" y="406" width="220" height="210" fill="#E4E4E4" stroke="#BFBFBF"/><rect x="980" y="406" width="220" height="210" fill="#E4E4E4" stroke="#BFBFBF"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 主圖 | `node`（`image`） | 約佔一半版面 | — | — |
| 小圖 ×N | `node`（`image`） | 等大，排在右側 | — | — |
| 圖說 | `label` | 可省；只給主圖一句 | 20 字 | 1 |

## 節奏

主圖與小圖群的間距用一個 `gutter`，小圖之間用半個。**小圖一律等大**——主次只有兩級，三級會變亂。

`blueprint.shape` 寫 `image-mosaic`。

## 變體

- **左小右大**：主圖放右側，閱讀從小圖開始。
- **橫幅主圖**：主圖改成上方滿寬，小圖排在下方一列。
