# 09 · topo-lines

**氣氛**：層層疊起的等高線，像地形圖。有層次、有地理感，而且每一頁都可以不一樣（改變 path 的彎度）。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。曲線會跟表格與卡片衝突。

**建議 opacity**：0.45

**做法**：五條平行但彎度不同的曲線，由下往上排列，愈上面愈淡。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="none" stroke="<secondary_accent>" stroke-width="1.5">
<path d="M-40 620 C 260 560, 520 660, 820 590 S 1180 520, 1320 560" opacity="0.55"/>
<path d="M-40 560 C 240 500, 540 600, 840 520 S 1180 450, 1320 500" opacity="0.45"/>
<path d="M-40 500 C 220 445, 560 540, 860 455 S 1180 385, 1320 440" opacity="0.35"/>
<path d="M-40 440 C 200 390, 580 480, 880 390 S 1180 320, 1320 380" opacity="0.25"/>
<path d="M-40 380 C 180 335, 600 420, 900 325 S 1180 255, 1320 320" opacity="0.15"/>
</g>
</svg>
```

**建議風格**：10、12、23、24。
