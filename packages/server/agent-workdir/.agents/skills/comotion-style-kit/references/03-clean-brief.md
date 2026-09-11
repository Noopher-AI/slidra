# 03 · clean-brief

**第一秒的感覺**：白底、深藍、幾乎沒有裝飾。像一份不想被記住外觀、只想被相信內容的顧問簡報——克制到近乎無聊，而那正是它的目的。

**適合**：顧問簡報、內部報告、提案、董事會、任何「外觀出錯的代價大於外觀出色的收益」的場合。
**不適合**：需要情緒與記憶點的場合（發表會、招募、品牌）。它不會給你驚喜，那是設計上的取捨。

**為什麼是這個配色**：底色是帶灰的白（#FCFCFD）而不是純白，避免與投影幕的反光打架；主色是低彩度的深藍，看起來像機構而不是品牌；accent 幾乎只用在數字與一條底線上，整份簡報的彩色面積控制在 5% 以內。

```json
{
  "density": "balanced",
  "palette": { "background": "#FCFCFD", "secondary_bg": "#F1F3F6", "primary": "#1F3A5F", "accent": "#C8102E", "secondary_accent": "#4A7C59", "text": "#14181D", "muted": "#5E6773" },
  "type_scale": { "cover": 64, "section": 48, "number": 120, "claim": 44, "title": 36, "subtitle": 26, "body": 22, "column": 20, "caption": 16 },
  "layout": { "side_margin": 96, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**字級對比**：整體比 01／02 小一級（標題 36、內文 22），密度改成 `balanced`——這個場合的頁面本來就會放比較多字，與其硬壓不如把字級收小、把邊界拉寬（`side_margin` 96）。

**間距節奏**：級距克制（8/16/24/32/56），沒有大跳。這個風格靠的是對齊與一致，不是節奏變化。

**建議背景**：02（點陣格線，opacity 壓到 0.3 以下）。多數情況**建議 `background: off`**——這個風格的說服力來自乾淨。
