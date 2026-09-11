# 46 · sunlit-wash

**氣氛**：晨光從右上角斜灑進來，亮到近乎過曝，左半整片留白。

**明亮風格**：這是為淺底配色畫的。深色配色（01、04、07、10、13、15、18、20）用它會太弱，要把透明度整組拉高一倍以上，或直接換一個深色系的配方。

**適合**：`anchor`、`breathing`（封面、章節、一句主張）。
**不適合**：`dense`。右上的高光會蓋掉放在那裡的卡片。

**建議 opacity**：0.9

**做法**：光源只有一顆：一團大的 accent 徑向漸層定調，中心再壓一小顆白色高光當反光點。左半完全不畫東西。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<radialGradient id="sw1" cx="1.0" cy="0.0" r="0.72"><stop offset="0" stop-color="<accent>" stop-opacity="0.8"/><stop offset="0.35" stop-color="<accent>" stop-opacity="0.3"/><stop offset="0.7" stop-color="<accent>" stop-opacity="0.07"/><stop offset="1" stop-color="<accent>" stop-opacity="0"/></radialGradient><radialGradient id="sw2" cx="0.93" cy="0.05" r="0.16"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#sw1)"/><rect width="1280" height="720" fill="url(#sw2)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |
| `cool` | 整張退到冷調：亮部也交給主色，只留明度差。 | `<accent>` → `primary` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：02、08、11、16、19、23。
