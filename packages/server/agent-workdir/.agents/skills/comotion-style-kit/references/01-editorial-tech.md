# 01 · editorial-tech

**第一秒的感覺**：深色底、冷色主調、字級對比大。像一篇排版講究的技術文章開了深色模式——安靜、精準、不喧嘩，資訊密度可以拉很高而不亂。

**適合**：產品說明、技術分享、開發者活動、任何「聽眾是專業人士」的場合。
**不適合**：兒少教學、手作與食物、需要溫度與親近感的品牌故事。深色底會讓這些主題顯得疏離。

**為什麼是這個配色**：背景不是純黑而是帶藍的深灰（#101418），純黑在投影機上會失去層次；主色是高明度的藍，在深底上仍然清楚；accent 用暖黃，冷底配暖點才有呼吸。

```json
{
  "density": "presentation",
  "palette": { "background": "#101418", "secondary_bg": "#1B2129", "primary": "#4F8DFF", "accent": "#F5B942", "secondary_accent": "#6DD3A5", "text": "#F4F6F8", "muted": "#9AA7B4" },
  "type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 },
  "layout": { "side_margin": 80, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "visual": "editorial-tech"
}
```

**字級對比**：標題 40 對內文 24，比例 1.67——中等對比，讓標題領頭但不壓過內容。大數字 140 是唯一的高音，一份簡報用一次就好。

**間距節奏**：級距偏密（8/16/24/40/64），適合一頁放 3～5 個單位。要更鬆的話換風格，不要只改 spacing——密度是這個風格的一部分。

**建議背景**：02（點陣格線，內容頁）、03（對角光束，定錨頁）。柔焦色團在這個深底上會糊掉，不建議。
