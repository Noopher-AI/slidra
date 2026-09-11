# 24 · archive-sepia

**第一秒的感覺**：泛黃的紙、褐墨、暗金。像一份從檔案櫃裡拿出來的文件——有時間的重量，但整理得很好。

**適合**：歷史、博物館、品牌沿革、回顧與年鑑。
**不適合**：未來導向的內容（藍圖、預測、發表）。這個配色的時態是過去式。

**為什麼是這個配色**：底色是老紙的暖黃；主色褐墨比黑軟，像褪色的墨水；暗金只用在年份與標號上。**不要加任何高飽和色**——那會立刻把年代感打掉。

```json
{
  "density": "text",
  "palette": {"background": "#F4EDE0", "secondary_bg": "#E7DCC8", "primary": "#5A4632", "accent": "#A07C2C", "secondary_accent": "#7A6A55", "text": "#2E2619", "muted": "#7D7260"},
  "type_scale": {"cover": 64, "section": 50, "number": 128, "claim": 44, "title": 36, "subtitle": 26, "body": 22, "column": 20, "caption": 17},
  "layout": {"side_margin": 88, "bottom_margin": 80, "footer_margin": 16, "gutter": 28, "spacing": [8, 16, 28, 44, 72]},
  "typography": {"heading": "Source Han Serif TC", "body": "Noto Serif TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "ink-wash",
  "visual": "editorial-tech"
}
```

**字型與對比**：整份襯線。密度 `text`，史料類內容需要完整的句子。

**間距節奏**：級距中等。

**建議背景**：01 `soft-blobs`（opacity 0.4，像紙的斑駁）。
