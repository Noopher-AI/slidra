# 01 · soft-blobs（柔焦色團）

**氣氛**：三團重疊的光暈從右側漫進來，邊界完全化開。像光透過紙，或一杯飲料被逆光拍下——溫暖、鬆、沒有稜角。

**適合**：`anchor`（封面、章節、結語）。這些頁面字少、留白多，光暈有地方可以漫。
**不適合**：`dense`。內容頁的卡片壓在漸層上會顯得髒。

**建議 opacity**：0.9（一般）／0.6（頁面底色是 `primary` 的結語頁，色團會變成同色系的層次）。

**做法**：三個徑向漸層分別用 `primary`、`accent`、`secondary_accent`，全部集中在右半；不用 `<filter>`，柔化靠漸層本身的 stop 分布。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<radialGradient id="bg-blob-1" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="<primary>" stop-opacity="0.55"/>
<stop offset="0.45" stop-color="<primary>" stop-opacity="0.2"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0"/>
</radialGradient>
<radialGradient id="bg-blob-2" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="<accent>" stop-opacity="0.4"/>
<stop offset="0.5" stop-color="<accent>" stop-opacity="0.12"/>
<stop offset="1" stop-color="<accent>" stop-opacity="0"/>
</radialGradient>
<radialGradient id="bg-blob-3" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="<secondary_accent>" stop-opacity="0.3"/>
<stop offset="1" stop-color="<secondary_accent>" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<ellipse cx="1120" cy="140" rx="560" ry="420" fill="url(#bg-blob-1)"/>
<ellipse cx="1000" cy="640" rx="480" ry="320" fill="url(#bg-blob-2)"/>
<ellipse cx="1300" cy="480" rx="360" ry="300" fill="url(#bg-blob-3)"/>
  <ellipse cx="1120" cy="120" rx="460" ry="460" fill="<primary>" opacity="0.12"/>
  <ellipse cx="1320" cy="440" rx="300" ry="300" fill="<primary>" opacity="0.06"/>
  <line x1="760" y1="720" x2="1280" y2="200" stroke="<accent>" stroke-width="2" opacity="0.6"/>
</svg>
```

**建議風格**：02 `warm-editorial`（最搭）。01 `editorial-tech` 的深底會把色團吃掉，要用的話 opacity 拉到 1.0 並把漸層的 stop-opacity 調高。
