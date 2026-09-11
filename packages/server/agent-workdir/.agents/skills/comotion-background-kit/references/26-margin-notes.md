# 26 · margin-notes

**氣氛**：左緣一條窄的淺色欄，像書頁的注記欄。安靜地把版面推向右邊。

**適合**：`dense`（文字多的頁面）。
**不適合**：`breathing`。

**建議 opacity**：0.5

**做法**：一條 200 寬的淺色欄貼左緣，加一條垂直分隔線。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<rect x="0" y="0" width="200" height="720" fill="<secondary_bg>" opacity="0.7"/>
<line x1="200" y1="0" x2="200" y2="720" stroke="<muted>" stroke-width="1" opacity="0.6"/>
</svg>
```

**建議風格**：14、09、21、24。
