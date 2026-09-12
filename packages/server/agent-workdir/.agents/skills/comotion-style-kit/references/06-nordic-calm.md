# 06 · nordic-calm

**第一秒的感覺**：灰藍的白、幾乎看不出彩度的字。像北歐的冬天下午——安靜、低溫、什麼都沒有多說。留白本身就是內容。

**適合**：設計提案、產品哲學、需要「沉住氣」的場合。
**不適合**：需要熱情或急迫感的場合（募資、促銷、動員）。它太冷靜了。

**為什麼是這個配色**：整組彩度都壓在 20% 以下——主色是灰藍不是藍，accent 是霧橘不是橘。這是唯一一組「沒有任何顏色想被看見」的配色，所以版面的留白與對齊會變成唯一的視覺重點，做不好就無處可躲。

```json
{
  "density": "presentation",
  "palette": {"background": "#F4F6F7", "secondary_bg": "#E6EAEC", "primary": "#5C7A8C", "accent": "#C98B6B", "secondary_accent": "#8FA396", "text": "#2A3236", "muted": "#7C888E"},
  "type_scale": {"cover": 64, "section": 48, "number": 120, "claim": 42, "title": 34, "subtitle": 24, "body": 21, "column": 19, "caption": 16},
  "layout": {"side_margin": 112, "bottom_margin": 88, "footer_margin": 16, "gutter": 40, "spacing": [16, 24, 40, 64, 96]},
  "typography": {"heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 400, "body_weight": 400},
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**字型與對比**：**標題不用粗體**（weight 400）——這是這個風格最反直覺也最關鍵的一點。層級靠字級與留白建立，不靠粗細。加粗會立刻毀掉它。

**間距節奏**：級距最鬆的一組（16/24/40/64/96），邊界 112。一頁最多 3 個單位，寧可拆頁。

**建議背景**：01 `soft-blobs`（opacity 0.4 以下）或乾脆 `background: off`。 **明亮背景**（背景庫 46–54，為淺底畫的）：48、52。
