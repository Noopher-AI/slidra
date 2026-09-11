# 08 · halftone-fade

**氣氛**：從右下往左上逐漸變稀的網點，像印刷的半色調。有顆粒、有方向、有年代感。

**適合**：`anchor`、`dense` 皆可。
**不適合**：需要極乾淨的資料頁面。

**建議 opacity**：0.5

**做法**：一個 12px 的圓點 pattern 鋪滿，上面疊一層從左上到右下的漸層遮罩，讓網點在左上完全消失。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-halftone" width="12" height="12" patternUnits="userSpaceOnUse">
<circle cx="6" cy="6" r="2.2" fill="<primary>"/>
</pattern>
<linearGradient id="bg-halftone-mask" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<background>" stop-opacity="1"/>
<stop offset="0.75" stop-color="<background>" stop-opacity="0"/>
</linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-halftone)" opacity="0.5"/>
<rect width="1280" height="720" fill="url(#bg-halftone-mask)"/>
</svg>
```

**建議風格**：09、22、24。
