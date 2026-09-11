# 24 · isometric-grid

**氣氛**：30 度的等角格線，像工程的立體圖紙。有空間感但不喧鬧。

**適合**：`dense`，特別是講架構或系統的頁面。
**不適合**：`anchor`。

**建議 opacity**：0.4

**做法**：一個菱形 pattern：兩組相反斜率的線交織。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-iso" width="60" height="34" patternUnits="userSpaceOnUse">
<path d="M0 34L30 0L60 34" fill="none" stroke="<primary>" stroke-width="0.6" opacity="0.4"/>
<path d="M0 0L30 34L60 0" fill="none" stroke="<primary>" stroke-width="0.6" opacity="0.25"/>
</pattern>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-iso)"/>
</svg>
```

**建議風格**：13、04、25。
