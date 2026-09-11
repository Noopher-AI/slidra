# 29 · cross-ticks

**氣氛**：均勻分布的小十字標記，像設計稿的定位點或星圖。細緻、有精密感，比點陣多一點個性。

**適合**：任何節奏。
**不適合**：需要絕對乾淨的頁面。

**建議 opacity**：0.4

**做法**：一個 80px 的 pattern，中心一個 8px 的十字。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-ticks" width="80" height="80" patternUnits="userSpaceOnUse">
<path d="M40 34v12M34 40h12" stroke="<muted>" stroke-width="1" opacity="0.6"/>
</pattern>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-ticks)"/>
</svg>
```

**建議風格**：04、06、13、25。
