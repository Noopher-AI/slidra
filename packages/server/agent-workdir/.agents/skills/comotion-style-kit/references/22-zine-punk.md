# 22 · zine-punk

**第一秒的感覺**：影印機吃掉一層灰的黑白，加一塊螢光。像一本手工釘起來的地下刊物——粗糙、偏移、故意不對齊。

**適合**：文化、音樂、次文化、實驗性內容、藝術節。
**不適合**：需要信任的場合（醫療、金融、法律）。粗糙會被讀成不可靠。

**為什麼是這個配色**：底色是影印紙的灰白（不是白）；黑是影印黑（#1A1A1A，不是純黑）；螢光粉是唯一的彩色，模擬螢光筆畫過的痕跡。**這個配色的重點是髒一點**。

```json
{
  "density": "presentation",
  "palette": {"background": "#EFEFEA", "secondary_bg": "#DEDED6", "primary": "#1A1A1A", "accent": "#FF2D78", "secondary_accent": "#00C2A8", "text": "#1A1A1A", "muted": "#5E5E58"},
  "type_scale": {"cover": 84, "section": 64, "number": 160, "claim": 52, "title": 44, "subtitle": 28, "body": 23, "column": 21, "caption": 17},
  "layout": {"side_margin": 64, "bottom_margin": 64, "footer_margin": 16, "gutter": 20, "spacing": [8, 16, 28, 44, 72]},
  "typography": {"heading": "Space Grotesk", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "visual": "editorial-tech"
}
```

**字型與對比**：字級大、邊界窄（64）——刊物的版面是擠的。標題可以壓到邊界甚至出血，這是這個風格少數允許破格的地方。

**間距節奏**：級距不規則（8/16/28/44/72），刻意不成等比。

**建議背景**：02 `dot-grid`（opacity 0.5，像網點印刷）。
