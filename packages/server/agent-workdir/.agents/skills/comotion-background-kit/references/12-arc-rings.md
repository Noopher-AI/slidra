# 12 · arc-rings

**氣氛**：右上角一組同心細環，像雷達或聲波的擴散。有中心、有外擴的動勢。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.6

**做法**：五個同心圓環，圓心在畫布外的右上角，半徑等差；最外圈最淡。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="none" stroke="<primary>">
<circle cx="1240" cy="-40" r="220" stroke-width="2" opacity="0.5"/>
<circle cx="1240" cy="-40" r="340" stroke-width="1.5" opacity="0.4"/>
<circle cx="1240" cy="-40" r="460" stroke-width="1.2" opacity="0.3"/>
<circle cx="1240" cy="-40" r="580" stroke-width="1" opacity="0.2"/>
<circle cx="1240" cy="-40" r="700" stroke-width="1" opacity="0.12"/>
</g>
</svg>
```

**建議風格**：01、04、10、15、23。
