# 03 · diagonal-beams（對角光束）

**氣氛**：三道從右上斜向左下的光束，左側被徑向漸層壓暗。**有方向、有速度**——這是這個配方最重要的性質，也是它的限制。

**適合**：`anchor`、`breathing`，以及 `order` 關係的頁面（光束的方向會強化閱讀方向）。
**不適合**：`membership` 的頁面。並列的內容配上有方向的背景，背景會說錯話。

**建議 opacity**：0.7。

**做法**：兩道 `primary`、一道 `accent` 的長條 path，角度一致；左側疊一層徑向漸層把文字區壓暗。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-beam-1" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<primary>" stop-opacity="0"/>
<stop offset="0.5" stop-color="<primary>" stop-opacity="0.22"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0"/>
</linearGradient>
<linearGradient id="bg-beam-2" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<accent>" stop-opacity="0"/>
<stop offset="0.5" stop-color="<accent>" stop-opacity="0.14"/>
<stop offset="1" stop-color="<accent>" stop-opacity="0"/>
</linearGradient>
<radialGradient id="bg-beam-fall" cx="0.2" cy="0.5" r="0.8">
<stop offset="0" stop-color="<background>" stop-opacity="1"/>
<stop offset="0.45" stop-color="<background>" stop-opacity="0.7"/>
<stop offset="1" stop-color="<background>" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M520 720 L1280 -40 L1280 200 L760 720 Z" fill="url(#bg-beam-1)"/>
<path d="M820 720 L1280 260 L1280 420 L980 720 Z" fill="url(#bg-beam-2)"/>
<path d="M300 720 L1280 -240 L1280 -140 L400 720 Z" fill="<primary>" opacity="0.06"/>
<rect width="1280" height="720" fill="url(#bg-beam-fall)"/>
  <ellipse cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `cool` | 全部收斂到冷色：暖的 accent 改用第三色。同一張圖會安靜下來，適合需要冷靜的內容。 | `<accent>` → `secondary_accent` |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted`、`<accent>` → `text` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：01 `editorial-tech`。淺底風格上光束會太顯眼，要用的話 opacity 降到 0.3 以下。
