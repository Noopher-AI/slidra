# 13 · blueprint

**第一秒的感覺**：深海軍藍的底，白色細線畫出格線，像一張攤開的工程藍圖。精密、有系統、每條線都有理由。

**適合**：架構說明、工程流程、系統設計、建築與製造。
**不適合**：情感訴求、品牌故事。藍圖的語言只講「它怎麼運作」，不講「它為什麼重要」。

**為什麼是這個配色**：底色是藍圖的靛藍（#12284C），線與字用接近白的淺藍——這組顏色的來源是曬圖，所以不要加第三個彩色；accent 的橘只用在「這裡要注意」的地方，面積極小。

```json
{
  "density": "balanced",
  "palette": {"background": "#12284C", "secondary_bg": "#1B3763", "primary": "#7FB3FF", "accent": "#FF9F45", "secondary_accent": "#A9C9F0", "text": "#EAF1FB", "muted": "#8FA6C4"},
  "type_scale": {"cover": 64, "section": 50, "number": 132, "claim": 44, "title": 36, "subtitle": 26, "body": 22, "column": 20, "caption": 16},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56]},
  "typography": {"heading": "IBM Plex Mono", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "visual": "editorial-tech"
}
```

**字型與對比**：英文標號與數字用等寬 IBM Plex Mono（圖面標註的語言），中文用 Noto Sans TC。密度 `balanced`，架構圖本來就要放比較多標籤。

**間距節奏**：級距密（8/16/24/32/56）。格線的世界裡，間距要能被整除。

**建議背景**：02 `dot-grid`（這個風格幾乎一定要它，opacity 0.6）。
