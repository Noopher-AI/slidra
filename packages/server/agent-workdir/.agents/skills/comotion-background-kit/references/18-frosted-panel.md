# 18 · frosted-panel

**氣氛**：右半一塊半透明的霧面板，像玻璃壓在畫面上。文字放右邊會自然被托住。

**適合**：`anchor`、`dense`。這是少數自帶 scrim 的背景。
**不適合**：`breathing`。面板會佔掉留白。

**建議 opacity**：0.85

**做法**：一塊圓角矩形用 `background` 色、opacity 0.7，加一條左緣亮線模擬玻璃邊。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-frost" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<primary>" stop-opacity="0.25"/>
<stop offset="1" stop-color="<secondary_accent>" stop-opacity="0.12"/>
</linearGradient>
</defs>
<rect width="1280" height="720" fill="url(#bg-frost)"/>
<rect x="600" y="0" width="680" height="720" fill="<background>" opacity="0.72"/>
<rect x="600" y="0" width="2" height="720" fill="<text>" opacity="0.18"/>
</svg>
```

**建議風格**：01、15、20、23。
