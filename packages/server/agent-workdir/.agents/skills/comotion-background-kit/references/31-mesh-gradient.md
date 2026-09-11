# 31 · mesh-gradient

**氣氛**：四團顏色在畫面上互相滲透，邊界完全化開，像未乾的顏料。柔、有層次、沒有一條硬邊。

**適合**：任何節奏。這是最通用也最有質感的一個。
**不適合**：需要絕對乾淨的資料頁面。

**建議 opacity**：0.9（深色）／0.5（淺色）

**做法**：四個徑向漸層分別放在四個象限，由外往內疊。不用 `<filter>`，柔化全靠漸層的 stop 分布。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<radialGradient id="m1" cx="0.22" cy="0.18" r="0.7"><stop offset="0" stop-color="<primary>" stop-opacity="0.55"/><stop offset="1" stop-color="<primary>" stop-opacity="0"/></radialGradient><radialGradient id="m2" cx="0.82" cy="0.28" r="0.62"><stop offset="0" stop-color="<accent>" stop-opacity="0.42"/><stop offset="1" stop-color="<accent>" stop-opacity="0"/></radialGradient><radialGradient id="m3" cx="0.62" cy="0.88" r="0.75"><stop offset="0" stop-color="<secondary_accent>" stop-opacity="0.38"/><stop offset="1" stop-color="<secondary_accent>" stop-opacity="0"/></radialGradient><radialGradient id="m4" cx="0.05" cy="0.85" r="0.55"><stop offset="0" stop-color="<secondary_bg>" stop-opacity="0.9"/><stop offset="1" stop-color="<secondary_bg>" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#m4)"/><rect width="1280" height="720" fill="url(#m3)"/><rect width="1280" height="720" fill="url(#m2)"/><rect width="1280" height="720" fill="url(#m1)"/>
</svg>
```

**建議風格**：全部，特別是 01、10、15、23。
