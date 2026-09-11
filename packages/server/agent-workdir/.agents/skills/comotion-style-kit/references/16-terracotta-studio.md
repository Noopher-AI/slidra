# 16 · terracotta-studio

**第一秒的感覺**：陶土色、沙色、一點窯燒的黑。像一間設計工作室的牆面——有質感但不緊張，作品才是主角。

**適合**：設計提案、空間、工藝品牌、作品集。
**不適合**：資料密集的報告。這個配色預期頁面上有圖，全是字會顯得空。

**為什麼是這個配色**：主色是燒過的陶土紅，比磚紅暗、比酒紅暖；secondary_bg 的沙色與底色差很少，分區靠的是邊界不是對比；黑只用在文字，不當色塊——工作室的牆不會有純黑。

```json
{
  "density": "presentation",
  "palette": {"background": "#F7F2EC", "secondary_bg": "#EBE0D4", "primary": "#B4552D", "accent": "#D99058", "secondary_accent": "#5C6B5D", "text": "#221D19", "muted": "#7A6E62"},
  "type_scale": {"cover": 72, "section": 54, "number": 140, "claim": 48, "title": 38, "subtitle": 27, "body": 23, "column": 21, "caption": 17},
  "layout": {"side_margin": 88, "bottom_margin": 80, "footer_margin": 16, "gutter": 36, "spacing": [12, 24, 36, 56, 88]},
  "typography": {"heading": "Playfair Display", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "visual": "editorial-tech"
}
```

**字型與對比**：英文標題用 Playfair Display（高對比襯線，工作室的招牌感），中文用 Noto Serif TC 700。內文黑體。

**間距節奏**：級距鬆、邊界 88。這個風格需要大量留白給圖片。

**建議背景**：01 `soft-blobs`（opacity 0.5）。
