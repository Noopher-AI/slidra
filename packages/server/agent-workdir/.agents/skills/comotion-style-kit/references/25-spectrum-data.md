# 25 · spectrum-data

**第一秒的感覺**：中性的淺灰底，配上一組彼此可分辨的分類色。專為「這一頁有圖表」設計——版面退到最後，數據是唯一的主角。

**適合**：儀表板、資料簡報、研究數據、任何一頁不只一張圖的場合。
**不適合**：沒有圖表的頁面。少了圖，這個配色會顯得沒有個性——那本來就是它的設計。

**為什麼是這個配色**：六個角色裡有四個是**分類色**（藍／橘／綠／紫），彼此在色相環上分得夠開，色盲friendly，而且明度接近所以沒有哪一條線看起來比較重要。背景與文字刻意極中性，不跟數據搶。

```json
{
  "density": "balanced",
  "palette": {"background": "#FAFAFB", "secondary_bg": "#EEF0F3", "primary": "#2E6FD9", "accent": "#E8833A", "secondary_accent": "#2AA07A", "text": "#1A1D21", "muted": "#6B7280"},
  "type_scale": {"cover": 62, "section": 48, "number": 132, "claim": 42, "title": 36, "subtitle": 25, "body": 21, "column": 19, "caption": 15},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56]},
  "typography": {"heading": "Inter", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "data-dense",
  "visual": "editorial-tech"
}
```

**字型與對比**：數字與座標軸標籤一律用 Inter（等寬數字對齊最好）。`caption` 只有 15——圖表的軸標籤要小才不搶。

**間距節奏**：級距密、邊界窄（72），把空間讓給圖。

**建議背景**：建議 `background: off`；圖表頁面上任何背景質地都會干擾讀數。
