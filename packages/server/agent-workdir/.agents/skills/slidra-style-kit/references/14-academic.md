# 14 · academic

**第一秒的感覺**：米白的紙、暗紅的標題、襯線字。像一篇印出來的論文——克制、有引用感、不試圖取悅。

**適合**：研究發表、學術報告、口試、白皮書。
**不適合**：需要速度感或情緒的場合。它的節奏是慢的。

**為什麼是這個配色**：主色是暗紅（oxblood），那是精裝書封與學位袍的顏色；底色米白降低長時間閱讀的疲勞；除了暗紅之外幾乎沒有彩色——學術場合的視覺重點應該是圖表，不是版面。

```json
{
  "density": "text",
  "palette": {"background": "#FBF9F4", "secondary_bg": "#EFEBE1", "primary": "#6B1D2B", "accent": "#A8703A", "secondary_accent": "#3F5B6B", "text": "#1F1B18", "muted": "#6E675E"},
  "type_scale": {"cover": 60, "section": 46, "number": 120, "claim": 42, "title": 34, "subtitle": 24, "body": 21, "column": 19, "caption": 16},
  "layout": {"side_margin": 96, "bottom_margin": 80, "footer_margin": 16, "gutter": 28, "spacing": [8, 16, 24, 40, 64]},
  "typography": {"heading": "Source Han Serif TC", "body": "Noto Serif TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**字型與對比**：**整份都用襯線**（標題思源宋、內文 Noto Serif TC）——這是唯一一個內文也用襯線的風格，因為學術文本預期被「讀」而不是被「看」。密度 `text`，允許比較長的句子。

**間距節奏**：級距標準、邊界寬（96）。頁面像書頁，不像投影片。

**建議背景**：建議 `background: off`。 **明亮背景**（背景庫 46–54，為淺底畫的）：48、51、54。
