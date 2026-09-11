# 21 · civic-plain

**第一秒的感覺**：灰白、橄欖綠、標楷般的端正。像一份政府文宣——不美，但每個人都看得懂，而且不會覺得被推銷。

**適合**：公部門、公共政策、說明會、非營利組織。
**不適合**：商業提案。這個風格的中立會被讀成缺乏企圖心。

**為什麼是這個配色**：橄欖綠是唯一的識別色，彩度刻意壓低到「不像品牌」；其餘全是灰階。公共溝通的目標是不偏不倚，任何強烈的顏色都會被解讀成立場。

```json
{
  "density": "balanced",
  "palette": {"background": "#F7F7F5", "secondary_bg": "#E8E8E4", "primary": "#5A6B4A", "accent": "#8C6A3F", "secondary_accent": "#4A5A6B", "text": "#1F2220", "muted": "#6B6F6B"},
  "type_scale": {"cover": 62, "section": 48, "number": 124, "claim": 42, "title": 36, "subtitle": 25, "body": 22, "column": 20, "caption": 17},
  "layout": {"side_margin": 80, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64]},
  "typography": {"heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "plain",
  "visual": "editorial-tech"
}
```

**字型與對比**：單一字族、字級偏大一點（`caption` 17 而不是 16）——公共場合的觀眾年齡分布最廣，最小的字要留餘裕。

**間距節奏**：級距標準。密度 `balanced`，政策說明句子長。

**建議背景**：建議 `background: off`。
