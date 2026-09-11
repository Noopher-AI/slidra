# 04 · midnight-lab

**第一秒的感覺**：近乎全黑的底，配上一道螢光青。像深夜還亮著的實驗室螢幕——專注、冷、有一點孤獨。資訊可以堆得很密而不覺得吵。

**適合**：研究成果、資料分析、監控儀表、深度技術主題。
**不適合**：面向一般大眾的說明、需要溫度的品牌故事。這個配色會讓人覺得「這不是講給我聽的」。

**為什麼是這個配色**：底色壓到 #0A0C10 才有「螢幕」的感覺；主色用高飽和的青，在近黑上是唯一能亮起來的顏色；accent 的萊姆綠只給數字與警示，面積控制在 3% 以內，多了就變成電競。

```json
{
  "density": "presentation",
  "palette": {"background": "#0A0C10", "secondary_bg": "#141A22", "primary": "#22D3EE", "accent": "#A3E635", "secondary_accent": "#818CF8", "text": "#E8EDF2", "muted": "#7C8794"},
  "type_scale": {"cover": 68, "section": 52, "number": 150, "claim": 46, "title": 38, "subtitle": 26, "body": 22, "column": 20, "caption": 16},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56]},
  "typography": {"heading": "IBM Plex Mono", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "visual": "editorial-tech"
}
```

**字型與對比**：標題用等寬的 IBM Plex Mono，內文用 Noto Sans TC。等寬字讓標題像終端機輸出——這是這個風格的來源，也是它唯一的裝飾。**中文標題不要用 IBM Plex Mono**（它沒有中文字），中文標題改用 Noto Sans TC 700。

**間距節奏**：級距密（8/16/24/32/56），字級整體比 01 小一號。這個風格預期一頁放很多東西。

**建議背景**：02 `dot-grid`（最搭，格線像示波器）。色團與光束都太柔，不建議。
