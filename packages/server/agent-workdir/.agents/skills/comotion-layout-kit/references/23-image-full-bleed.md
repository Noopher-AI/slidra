# 23 · image-full-bleed

**解的關係**：`none`
**單位數**：1
**一句話**：整頁一張圖，文字壓在上面——最有氣勢，也最容易讀不清楚。

**什麼時候用它**：章節轉場、開場、或一張圖本身就是主張。
**什麼時候不要用**：任何需要讀清楚多行文字的頁面。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<rect x="0" y="0" width="1280" height="720" fill="#D0D0D0"/><text x="120" y="120" font-size="24" fill="#A0A0A0">滿版圖片</text><rect x="0" y="380" width="1280" height="340" fill="#FFFFFF" opacity="0.82"/><text x="140" y="510" font-size="48" fill="#2E2E2E" font-weight="700">壓在圖上的主張</text><text x="140" y="580" font-size="24" fill="#777777">補充說明</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 圖片 | `node`（`image`） | 滿版 | — | — |
| scrim | `field` | **必要**，涵蓋所有文字 | — | — |
| 主張 | `label`（`claim`） | | 22 字 | 1–2 |
| 補充 | `label` | 可省 | 20 字 | 1 |

## 節奏

**scrim 不是選配**：圖上的文字沒有底一定讀不清楚，`validate` 的 `structure.scrim` 也會擋。scrim 用單向漸層（從不透明到透明）比純色塊自然。文字集中在下半或單邊，不要散落。

`blueprint.shape` 寫 `image-full-bleed`。

## 變體

- **上壓版**：文字在上緣，scrim 從上往下淡出。
- **側欄版**：右側一條 40% 寬的 scrim 直欄，文字放在裡面。
