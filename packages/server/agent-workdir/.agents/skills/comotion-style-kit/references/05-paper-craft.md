# 05 · paper-craft

**第一秒的感覺**：牛皮紙的底、深褐的字、一點靛藍。像一本手作工作坊的講義——有纖維感、不精緻，但讓人想伸手摸。

**適合**：工作坊、手作、在地品牌、食物、教育現場。
**不適合**：科技產品、財報、任何需要「精準」印象的場合。紙感會讓數字顯得不嚴謹。

**為什麼是這個配色**：底色是偏黃的牛皮色（#EFE6D5），不是米白——差在那一點灰度，白會變成「乾淨」，灰黃才是「紙」；主色深褐幾乎是墨水色；accent 用靛藍，是紙上唯一的冷色，所以重點會自己跳出來。

```json
{
  "density": "presentation",
  "palette": {"background": "#EFE6D5", "secondary_bg": "#E2D5BE", "primary": "#4A3728", "accent": "#2F4B7C", "secondary_accent": "#8C6239", "text": "#2B2118", "muted": "#6F6252"},
  "type_scale": {"cover": 68, "section": 52, "number": 132, "claim": 46, "title": 38, "subtitle": 26, "body": 23, "column": 21, "caption": 17},
  "layout": {"side_margin": 72, "bottom_margin": 80, "footer_margin": 16, "gutter": 32, "spacing": [12, 20, 32, 48, 72]},
  "typography": {"heading": "cwTeXKai", "body": "Noto Sans TC", "heading_weight": 400, "body_weight": 400},
  "shape_language": "paper-cut",
  "visual": "editorial-tech"
}
```

**字型與對比**：標題用楷書（cwTeXKai），內文用黑體。楷書有筆順，一眼就有手寫的溫度——但**楷書不要用在小字**，24 以下會糊；標題與章節名以外一律黑體。

**間距節奏**：級距鬆（12/20/32/48/72），底部留白多（`bottom_margin` 80）。手作感需要空白，不要把頁面填滿。

**建議背景**：01 `soft-blobs`（opacity 0.6 以下，像紙的透光）。 **明亮背景**（背景庫 46–54，為淺底畫的）：47、50、51、54。
