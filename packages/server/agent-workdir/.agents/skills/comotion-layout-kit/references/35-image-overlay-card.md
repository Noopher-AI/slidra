# 35 · image-overlay-card

**解的關係**：`none`
**單位數**：1
**一句話**：滿版圖上壓一張偏一側的卡片，文字在卡片裡——比 23 `image-full-bleed` 更能放多行字。

**什麼時候用它**：有一張氣氛很強的圖，但文字不只一句。
**什麼時候不要用**：圖本身資訊很滿（圖表、截圖）——卡片會蓋掉重要的部分。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="0" y="0" width="1280" height="720" fill="#DADADA"/>
<text x="180" y="120" font-size="18" fill="#999999">滿版圖片</text>
<rect x="680" y="140" width="520" height="440" fill="#FFFFFF" stroke="#BBBBBB"/>
<text x="720" y="210" font-size="28" fill="#333333">標題（label）</text>
<text x="720" y="280" font-size="16" fill="#666666">內文第一行</text>
<text x="720" y="320" font-size="16" fill="#666666">內文第二行</text>
<text x="720" y="360" font-size="16" fill="#666666">內文第三行</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 圖片 | `node`（`image`） | 滿版 | — | — |
| 卡片 | `field` | **同時是 scrim** | — | — |
| 標題 | `label` | 在卡片裡 | 14 字 | 1 |
| 內文 | `label` | | 每條 20 字 | 2–4 條 |

## 節奏

卡片佔版面約 40%，貼一側（通常是右側，因為背景配方的亮部也在右側）。卡片與畫布邊界留一個 `side_margin`。**卡片不透明或 opacity ≥ 0.85**——半透明的卡片配上複雜的圖會讀不清楚。

`blueprint.shape` 寫 `image-overlay-card`。

## 變體

- **卡片出血**：卡片貼齊右邊界，只留上下邊距，更現代。
- **左卡片**：圖的主體在右側時改放左邊。
