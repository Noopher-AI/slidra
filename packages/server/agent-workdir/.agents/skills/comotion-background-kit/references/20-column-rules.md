# 20 · column-rules

**氣氛**：等距的垂直細線，像報紙的欄線。安靜地暗示「這頁是分欄的」。

**適合**：`dense`，尤其是多欄版面。
**不適合**：`breathing`、`anchor`。

**建議 opacity**：0.4

**做法**：五條等距垂直線，落在 12 欄格線的欄界上。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g stroke="<muted>" stroke-width="1" opacity="0.5">
<line x1="280" y1="0" x2="280" y2="720"/>
<line x1="480" y1="0" x2="480" y2="720"/>
<line x1="680" y1="0" x2="680" y2="720"/>
<line x1="880" y1="0" x2="880" y2="720"/>
<line x1="1080" y1="0" x2="1080" y2="720"/>
</g>
</svg>
```

**建議風格**：09、14、21、22。
