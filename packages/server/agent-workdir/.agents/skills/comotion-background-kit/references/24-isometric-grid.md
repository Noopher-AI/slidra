# 24 · isometric-grid

**氣氛**：30 度的等角格線，像工程的立體圖紙。有空間感但不喧鬧。

**適合**：`dense`，特別是講架構或系統的頁面。
**不適合**：`anchor`。

**建議 opacity**：0.4

**做法**：一個菱形 pattern：兩組相反斜率的線交織。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="iso" width="72" height="42" patternUnits="userSpaceOnUse"><path d="M0 42L36 0L72 42" fill="none" stroke="<primary>" stroke-width="1.6" opacity="0.85"/><path d="M0 0L36 42L72 0" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.5"/></pattern>
<linearGradient id="calm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="<background>" stop-opacity="0.92"/><stop offset="0.42" stop-color="<background>" stop-opacity="0.62"/><stop offset="1" stop-color="<background>" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#iso)"/>
<rect width="1280" height="720" fill="url(#calm)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent` |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：13、04、25。
