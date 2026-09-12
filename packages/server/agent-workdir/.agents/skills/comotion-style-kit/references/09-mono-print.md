# 09 · mono-print

**第一秒的感覺**：純黑白，只有一個紅。像一份還沒上色的報紙頭版——資訊優先，設計退到後面，但每個對齊都經過計算。

**適合**：調查報導、事實呈現、需要「我沒有在美化」的場合。
**不適合**：產品發表、品牌形象。它看起來太像證據，不像邀請。

**為什麼是這個配色**：黑白之外只留一個紅，而且紅**只給一個地方用**（通常是一個數字或一個關鍵詞）。一頁出現兩個紅，這個風格就失效了。secondary_bg 是極淺灰，用來分區而不是裝飾。

```json
{
  "density": "balanced",
  "palette": {"background": "#FFFFFF", "secondary_bg": "#F0F0F0", "primary": "#000000", "accent": "#D0021B", "secondary_accent": "#666666", "text": "#111111", "muted": "#767676"},
  "type_scale": {"cover": 64, "section": 48, "number": 128, "claim": 44, "title": 36, "subtitle": 25, "body": 21, "column": 19, "caption": 15},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64]},
  "typography": {"heading": "Noto Serif TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "brutalist",
  "visual": "editorial-tech"
}
```

**字型與對比**：標題襯線、內文黑體——報紙的排版邏輯。密度用 `balanced`，因為這個場合本來就會放比較多字。

**間距節奏**：級距標準（8/16/24/40/64）。這個風格靠嚴格的對齊，不靠節奏變化。

**建議背景**：建議 `background: off`。要用的話 02 `dot-grid` opacity 0.2 以下。 **明亮背景**（背景庫 46–54，為淺底畫的）：48、51、54。
