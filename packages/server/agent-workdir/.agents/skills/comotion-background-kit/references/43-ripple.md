# 43 · ripple

**氣氛**：從右下角擴散出去的同心圓。有中心、有擴散，而且愈遠愈淡。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.6

**做法**：二十二圈同心圓，每四圈加粗一次做出節拍。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="calm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="<background>" stop-opacity="0.92"/><stop offset="0.42" stop-color="<background>" stop-opacity="0.62"/><stop offset="1" stop-color="<background>" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<circle cx="1180" cy="620" r="40" fill="none" stroke="<primary>" stroke-width="2.6" opacity="0.75"/><circle cx="1180" cy="620" r="84" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.72"/><circle cx="1180" cy="620" r="128" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.69"/><circle cx="1180" cy="620" r="172" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.67"/><circle cx="1180" cy="620" r="216" fill="none" stroke="<primary>" stroke-width="2.6" opacity="0.64"/><circle cx="1180" cy="620" r="260" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.61"/><circle cx="1180" cy="620" r="304" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.58"/><circle cx="1180" cy="620" r="348" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.55"/><circle cx="1180" cy="620" r="392" fill="none" stroke="<primary>" stroke-width="2.6" opacity="0.53"/><circle cx="1180" cy="620" r="436" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.5"/><circle cx="1180" cy="620" r="480" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.47"/><circle cx="1180" cy="620" r="524" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.44"/><circle cx="1180" cy="620" r="568" fill="none" stroke="<primary>" stroke-width="2.6" opacity="0.41"/><circle cx="1180" cy="620" r="612" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.39"/><circle cx="1180" cy="620" r="656" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.36"/><circle cx="1180" cy="620" r="700" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.33"/><circle cx="1180" cy="620" r="744" fill="none" stroke="<primary>" stroke-width="2.6" opacity="0.3"/><circle cx="1180" cy="620" r="788" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.27"/><circle cx="1180" cy="620" r="832" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.25"/><circle cx="1180" cy="620" r="876" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.22"/><circle cx="1180" cy="620" r="920" fill="none" stroke="<primary>" stroke-width="2.6" opacity="0.19"/><circle cx="1180" cy="620" r="964" fill="none" stroke="<primary>" stroke-width="1.4" opacity="0.16"/>
<rect width="1280" height="720" fill="url(#calm)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent` |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：01、10、15、23。
