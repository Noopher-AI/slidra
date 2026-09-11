# 11 · grid-blueprint

**氣氛**：完整的方格網加上較粗的主格線，像製圖紙。精密、可測量。

**適合**：`dense`。這是資訊頁的背景。
**不適合**：`anchor`。格線會讓開場失去氣勢。

**建議 opacity**：0.5

**做法**：兩層 pattern：40px 的細格與 200px 的粗格，疊在一起。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-grid-fine" width="40" height="40" patternUnits="userSpaceOnUse">
<path d="M40 0H0V40" fill="none" stroke="<primary>" stroke-width="0.5" opacity="0.35"/>
</pattern>
<pattern id="bg-grid-bold" width="200" height="200" patternUnits="userSpaceOnUse">
<path d="M200 0H0V200" fill="none" stroke="<primary>" stroke-width="1" opacity="0.5"/>
</pattern>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-grid-fine)"/>
<rect width="1280" height="720" fill="url(#bg-grid-bold)"/>
</svg>
```

**建議風格**：13、04、25。
