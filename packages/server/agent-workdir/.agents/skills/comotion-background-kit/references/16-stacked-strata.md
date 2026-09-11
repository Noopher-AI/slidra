# 16 · stacked-strata

**氣氛**：水平的色帶由下往上逐層變淡，像地層剖面。穩、有累積感。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.55

**做法**：五條等高的橫向矩形由下往上排，透明度遞減。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="<primary>">
<rect x="0" y="620" width="1280" height="100" opacity="0.22"/>
<rect x="0" y="540" width="1280" height="80" opacity="0.16"/>
<rect x="0" y="470" width="1280" height="70" opacity="0.11"/>
<rect x="0" y="410" width="1280" height="60" opacity="0.07"/>
<rect x="0" y="360" width="1280" height="50" opacity="0.04"/>
</g>
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

**建議風格**：10、12、18、24。
