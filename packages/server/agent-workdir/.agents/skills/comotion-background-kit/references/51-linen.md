# 51 · linen

**氣氛**：極細的交織紋鋪滿整面，像亞麻布，左上被一團底色的光暈化開。

**明亮風格**：這是為淺底配色畫的。深色配色（01、04、07、10、13、15、18、20）用它會太弱，要把透明度整組拉高一倍以上，或直接換一個深色系的配方。

**適合**：任何節奏，尤其是紙感風格的全部頁面。
**不適合**：—

**建議 opacity**：0.5

**做法**：經緯兩個方向的透明度要差一級（0.34／0.20），平均了就變成方格紙而不是布。左上的光暈用 `<background>` 自己畫，讓標題區退回乾淨的紙。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="ln" width="9" height="9" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="9" stroke="<primary>" stroke-width="1" opacity="0.34"/><line x1="0" y1="0" x2="9" y2="0" stroke="<primary>" stroke-width="1" opacity="0.20"/></pattern><radialGradient id="lnw" cx="0.22" cy="0.4" r="0.5"><stop offset="0" stop-color="<background>" stop-opacity="0.8"/><stop offset="1" stop-color="<background>" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#ln)"/><rect width="1280" height="720" fill="url(#lnw)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |
| `mono-ink` | 去彩度：全部改用 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted`；`<accent>` → `muted` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：02、05、09、14、16、21、24。
