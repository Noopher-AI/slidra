# 04 · gradient-wash

**氣氛**：從左下到右上的單向漸層，沒有任何圖形。最安靜的一種背景——它只是讓畫面不那麼平。

**適合**：任何節奏。這是最通用、最不會出錯的一個。
**不適合**：幾乎沒有。真的要挑，是需要質地感的紙感風格。

**建議 opacity**：0.8（深色風格）／0.4（淺色風格）

**做法**：一個線性漸層，從 `background` 過渡到 `secondary_bg`，角度 135 度。沒有第二個元素。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-wash" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="<background>" stop-opacity="1"/><stop offset="0.4" stop-color="<secondary_bg>" stop-opacity="1"/><stop offset="0.72" stop-color="<primary>" stop-opacity="0.28"/><stop offset="1" stop-color="<accent>" stop-opacity="0.16"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-wash)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent`、`<accent>` → `primary` |
| `duotone` | 只留兩色：除了底色之外全部收斂成主色的深淺。最安靜的處理。 | `<accent>` → `primary` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：全部。特別適合 03、06、17、21、25 這些克制的風格。
