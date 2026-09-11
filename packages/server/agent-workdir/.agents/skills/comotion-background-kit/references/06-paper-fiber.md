# 06 · paper-fiber

**氣氛**：極細的斜向短線隨機分布，像紙的纖維。近看才發現，遠看只覺得「這不是螢幕」。

**適合**：任何節奏，尤其是紙感風格的全部頁面。
**不適合**：純數據頁面。任何質地都會干擾讀數。

**建議 opacity**：0.35

**做法**：一個 24px 的 pattern，裡面三條角度略異的短線。線用 `muted`，透明度低。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-fiber" width="24" height="24" patternUnits="userSpaceOnUse">
<line x1="2" y1="20" x2="10" y2="4" stroke="<muted>" stroke-width="0.6" opacity="0.5"/>
<line x1="14" y1="22" x2="19" y2="10" stroke="<muted>" stroke-width="0.5" opacity="0.4"/>
<line x1="6" y1="14" x2="21" y2="2" stroke="<muted>" stroke-width="0.4" opacity="0.3"/>
</pattern>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-fiber)"/>
</svg>
```

**建議風格**：02、05、14、16、24。
