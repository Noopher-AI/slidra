# 16 · stacked-strata

**氣氛**：水平的色帶由下往上逐層變淡，像地層剖面。穩、有累積感。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.55

**做法**：五條等高的橫向矩形由下往上排，透明度遞減。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="<primary>">
<rect x="0" y="620" width="1280" height="100" opacity="0.22"/>
<rect x="0" y="540" width="1280" height="80" opacity="0.16"/>
<rect x="0" y="470" width="1280" height="70" opacity="0.11"/>
<rect x="0" y="410" width="1280" height="60" opacity="0.07"/>
<rect x="0" y="360" width="1280" height="50" opacity="0.04"/>
</g>
</svg>
```

**建議風格**：10、12、18、24。
