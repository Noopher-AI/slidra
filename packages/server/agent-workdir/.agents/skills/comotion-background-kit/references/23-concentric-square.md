# 23 · concentric-square

**氣氛**：同心的方框由外往內縮，像靶心或層層的框。對稱、穩定、有中心。

**適合**：`breathing`（大數字放在正中央最有力）。
**不適合**：`dense`。

**建議 opacity**：0.5

**做法**：五個同心矩形細框，等差內縮，愈內愈淡。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="none" stroke="<primary>">
<rect x="80" y="40" width="1120" height="640" stroke-width="2" opacity="0.35"/>
<rect x="180" y="100" width="920" height="520" stroke-width="1.5" opacity="0.28"/>
<rect x="280" y="160" width="720" height="400" stroke-width="1.2" opacity="0.2"/>
<rect x="380" y="220" width="520" height="280" stroke-width="1" opacity="0.14"/>
<rect x="480" y="280" width="320" height="160" stroke-width="1" opacity="0.09"/>
</g>
</svg>
```

**建議風格**：07、14、18、20。
