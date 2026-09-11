# 52 · edge-glow

**氣氛**：右緣與上緣各一道窄而亮的光帶，中央與左側完全乾淨。

**明亮風格**：這是為淺底配色畫的。深色配色（01、04、07、10、13、15、18、20）用它會太弱，要把透明度整組拉高一倍以上，或直接換一個深色系的配方。

**適合**：任何節奏——它是這一批裡最不干擾內容的一個。
**不適合**：—

**建議 opacity**：0.8

**做法**：關鍵是**窄**。光帶在 16% 寬度內就要衰減到近乎 0；第一版讓它擴散到三分之一頁寬，在暖色配色上整個右側糊成褐色。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="eg1" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="<accent>" stop-opacity="0.9"/><stop offset="0.05" stop-color="<accent>" stop-opacity="0.3"/><stop offset="0.16" stop-color="<accent>" stop-opacity="0.05"/><stop offset="1" stop-color="<accent>" stop-opacity="0"/></linearGradient><linearGradient id="eg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.45"/><stop offset="0.07" stop-color="<primary>" stop-opacity="0.12"/><stop offset="0.2" stop-color="<primary>" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#eg2)"/><rect width="1280" height="720" fill="url(#eg1)"/>
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

**建議風格**：全部。淺色風格 02、03、06、08、11、12、14、16、17、19、21、23、25 都合用。
