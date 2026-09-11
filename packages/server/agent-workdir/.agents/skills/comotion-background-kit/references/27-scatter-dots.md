# 27 · scatter-dots

**氣氛**：大小不一的圓點隨機散布在右半，像粒子或星點。輕、有隨機感，不規律所以不呆板。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.55

**做法**：十二個半徑與透明度都不同的圓，全部落在右半，左半保持乾淨。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="<accent>">
<circle cx="880" cy="110" r="5" opacity="0.7"/><circle cx="1010" cy="200" r="3" opacity="0.5"/>
<circle cx="1180" cy="130" r="7" opacity="0.6"/><circle cx="940" cy="330" r="2.5" opacity="0.45"/>
<circle cx="1090" cy="420" r="4" opacity="0.55"/><circle cx="1230" cy="330" r="3" opacity="0.4"/>
<circle cx="820" cy="480" r="3.5" opacity="0.5"/><circle cx="1150" cy="560" r="6" opacity="0.5"/>
<circle cx="980" cy="620" r="2.5" opacity="0.35"/><circle cx="1240" cy="660" r="4" opacity="0.45"/>
<circle cx="760" cy="230" r="2" opacity="0.3"/><circle cx="1060" cy="80" r="2.5" opacity="0.4"/>
</g>
</svg>
```

**建議風格**：01、04、15、23。
