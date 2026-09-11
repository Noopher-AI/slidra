# 30 · duotone-split

**氣氛**：左右兩個色塊各佔一半，中間一道漸層接縫。最直接的二分——天生為對照而生。

**適合**：`contrast` 關係的頁面。
**不適合**：其他所有關係。這個背景本身就在說「有兩邊」。

**建議 opacity**：0.65

**做法**：兩個半幅矩形分別用 `primary` 與 `secondary_accent`，接縫處一條窄的線性漸層把硬邊化開。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-seam" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="<primary>" stop-opacity="0.18"/>
<stop offset="0.5" stop-color="<background>" stop-opacity="0.9"/>
<stop offset="1" stop-color="<secondary_accent>" stop-opacity="0.18"/>
</linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect x="0" y="0" width="620" height="720" fill="<primary>" opacity="0.14"/>
<rect x="660" y="0" width="620" height="720" fill="<secondary_accent>" opacity="0.14"/>
<rect x="560" y="0" width="160" height="720" fill="url(#bg-seam)"/>
</svg>
```

**建議風格**：09、11、14、17。
