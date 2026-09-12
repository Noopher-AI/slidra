# 20 · luxury-noir

**第一秒的感覺**：全黑、香檳白、極細的字。像一則精品廣告的最後一頁——留白比內容多，而那正是訊息。

**適合**：品牌、精品、形象影片的搭配簡報、開場與結尾。
**不適合**：任何需要說明細節的頁面。它一頁只能承載一句話。

**為什麼是這個配色**：黑與米白之間沒有中間色，唯一的第三色是香檳金的細線。**這個風格禁止色塊**——所有分區靠留白與線。

```json
{
  "density": "presentation",
  "palette": {"background": "#000000", "secondary_bg": "#0E0E0E", "primary": "#D9C9A8", "accent": "#D9C9A8", "secondary_accent": "#7A7267", "text": "#F5F1E8", "muted": "#8C857A"},
  "type_scale": {"cover": 88, "section": 64, "number": 168, "claim": 56, "title": 44, "subtitle": 28, "body": 24, "column": 22, "caption": 17},
  "layout": {"side_margin": 120, "bottom_margin": 96, "footer_margin": 16, "gutter": 40, "spacing": [16, 32, 56, 88, 128]},
  "typography": {"heading": "Playfair Display", "body": "Noto Serif TC", "heading_weight": 400, "body_weight": 400},
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**字型與對比**：**不用粗體**（weight 400），字級靠大取勝。英文用 Playfair Display 的高對比襯線；中文用 Noto Serif TC。

**間距節奏**：級距最大、邊界 120。一頁 1 個單位。

**建議背景**：建議 `background: off`，或 01 `soft-blobs` opacity 0.25。
