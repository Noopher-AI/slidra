# 10 · side-band

**氣氛**：左緣或右緣一條滿高的色帶，把畫面切成主次兩塊。最結構性的一種背景。

**適合**：`anchor`（章節頁最合）、`dense`（色帶當側欄）。
**不適合**：`breathing`。色帶會壓縮本來要留白的空間。

**建議 opacity**：0.8

**做法**：一條 160 寬的滿高矩形貼左緣，再加一條 4 寬的 accent 細線當邊界。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<rect x="0" y="0" width="160" height="720" fill="<secondary_bg>"/>
<rect x="160" y="0" width="4" height="720" fill="<accent>" opacity="0.8"/>
</svg>
```

**建議風格**：01、13、18、21。
