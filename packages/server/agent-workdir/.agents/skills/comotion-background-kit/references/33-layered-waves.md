# 33 · layered-waves

**氣氛**：三層波浪由上而下填滿，顏色愈往下愈實。像水面的剖面，有重量也有流動。

**適合**：`anchor`、`breathing`；內容集中在上半時也可用於 `dense`。
**不適合**：內容延伸到底部的頁面。

**建議 opacity**：0.8

**做法**：三條 path，上兩層用漸層、最底層用 `secondary_bg` 實色壓住。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="w1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.32"/><stop offset="1" stop-color="<primary>" stop-opacity="0.08"/></linearGradient><linearGradient id="w2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.2"/><stop offset="1" stop-color="<primary>" stop-opacity="0.05"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M0 300C200 250 380 360 560 330S920 230 1280 300V720H0Z" fill="url(#w1)"/><path d="M0 430C220 380 400 490 620 450S1020 370 1280 430V720H0Z" fill="url(#w2)"/><path d="M0 560C240 520 420 610 660 575S1060 510 1280 560V720H0Z" fill="<secondary_bg>" opacity="0.9"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：10、12、22、23。
