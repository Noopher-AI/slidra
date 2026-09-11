# 29 · cross-ticks

**氣氛**：均勻分布的小十字標記，像設計稿的定位點或星圖。細緻、有精密感，比點陣多一點個性。

**適合**：任何節奏。
**不適合**：需要絕對乾淨的頁面。

**建議 opacity**：0.4

**做法**：一個 80px 的 pattern，中心一個 8px 的十字。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="tk" width="64" height="64" patternUnits="userSpaceOnUse"><path d="M32 22v20M22 32h20" stroke="<muted>" stroke-width="1.8" opacity="0.75"/></pattern>
<linearGradient id="calm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="<background>" stop-opacity="0.92"/><stop offset="0.42" stop-color="<background>" stop-opacity="0.62"/><stop offset="1" stop-color="<background>" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#tk)"/>
<rect width="1280" height="720" fill="url(#calm)"/>
</svg>
```

**建議風格**：04、06、13、25。
