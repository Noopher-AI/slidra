# 34 · stacked-peaks

**氣氛**：三層山稜線由高到低疊起。有地形感、有遠近，而且天然把視線帶到上方。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.75

**做法**：三條折線 path，愈前面的愈實；峰的高度刻意不規則。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="p1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.28"/><stop offset="1" stop-color="<primary>" stop-opacity="0.1"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M0 560L220 400L380 500L560 330L760 470L940 360L1120 470L1280 400V720H0Z" fill="url(#p1)"/><path d="M0 640L200 520L400 600L600 470L820 580L1020 500L1280 590V720H0Z" fill="<secondary_bg>" opacity="0.9"/><path d="M0 690L260 620L520 680L780 610L1040 670L1280 630V720H0Z" fill="<primary>" opacity="0.18"/>
</svg>
```

**建議風格**：10、12、24。
