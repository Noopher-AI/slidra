# 15 · soft-vignette

**氣氛**：四周略暗、中央略亮，像打了一盞柔光。看不出有東西，只覺得注意力被帶到中間。

**適合**：`breathing`（大數字、一句主張）。
**不適合**：`dense`。中央變亮會讓卡片牆的上下兩排看起來不一樣。

**建議 opacity**：0.8

**做法**：一個橢圓徑向漸層，中心透明、邊緣是 `background` 的深色版；不用 `<filter>`。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<radialGradient id="bg-vignette" cx="0.5" cy="0.5" r="0.75">
<stop offset="0" stop-color="<secondary_bg>" stop-opacity="0.5"/>
<stop offset="0.6" stop-color="<background>" stop-opacity="0"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0.18"/>
</radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-vignette)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted` |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：07、15、19、20。
