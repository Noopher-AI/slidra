# 21 · corner-brackets

**氣氛**：四個角落各一組直角括號，像取景框或掃描的定位標記。精準、有科技感。

**適合**：任何節奏。它只佔四個角，不干涉內容區。
**不適合**：幾乎沒有。

**建議 opacity**：0.6

**做法**：四組兩段直線組成的直角，距離邊界 48。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g stroke="<accent>" stroke-width="3" fill="none" opacity="0.7">
<path d="M48 120V48h72"/>
<path d="M1160 48h72v72"/>
<path d="M1232 600v72h-72"/>
<path d="M120 672H48v-72"/>
</g>
</svg>
```

**建議風格**：04、07、13、22、25。
