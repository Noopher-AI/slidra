# 02 · warm-editorial

**第一秒的感覺**：奶油色的紙、深酒紅的字、橘褐色的重點。像一本印刷精美的食譜或文化雜誌內頁——有溫度、有手感，字看起來是「被排版過」而不是「被輸出」。

**適合**：飲食、旅行、文化、品牌故事、教學、任何希望聽眾放鬆的場合。
**不適合**：財報、技術規格、需要大量數字與圖表的場合——暖色底會讓密集的數據顯得吵。

**為什麼是這個配色**：底色不是純白而是帶黃的米色（#FAF6F0），純白在投影時太刺眼也太冷；主色酒紅是「印刷感」的來源；accent 的橘褐與底色同調，重點看起來是紙上本來就有的，不是貼上去的。

```json
{
  "density": "presentation",
  "palette": { "background": "#FAF6F0", "secondary_bg": "#EDE7DD", "primary": "#7B2D26", "accent": "#C8651B", "secondary_accent": "#3E5C4B", "text": "#1A1A1A", "muted": "#6B6560" },
  "type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 },
  "layout": { "side_margin": 64, "bottom_margin": 72, "footer_margin": 16, "gutter": 32, "spacing": [12, 24, 32, 48, 72] },
  "typography": { "heading": "Noto Serif TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "paper-cut",
  "visual": "editorial-tech"
}
```

**字級對比**：跟 01 相同的字級表，但**標題用襯線、內文用黑體**——對比來自字族而不是字級。這是這個風格最重要的一件事，只換配色不換字型會失去一半的性格。

**間距節奏**：級距比 01 鬆（12/24/32/48/72），邊界也收窄到 64 讓內容區更寬。紙感需要留白，一頁放 3～4 個單位就好。

**建議背景**：01（柔焦色團，全部頁面都合）。點陣格線在暖底上會顯得像方格紙，不建議。 **明亮背景**（背景庫 46–54，為淺底畫的）：46、47、50、51、54。
