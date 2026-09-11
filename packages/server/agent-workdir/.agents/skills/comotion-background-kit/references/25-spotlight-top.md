# 25 · spotlight-top

**氣氛**：從頂端中央打下來的一束光，往下逐漸散開。舞台感，注意力自然往上。

**適合**：`anchor`（封面）、`breathing`。
**不適合**：`dense`。上亮下暗會讓後排的卡片看起來比較不重要。

**建議 opacity**：0.7

**做法**：一個上寬下窄的梯形 path 填線性漸層，由上往下淡出。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-spot" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="<primary>" stop-opacity="0.35"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0"/>
</linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M420 0H860L1140 720H140Z" fill="url(#bg-spot)"/>
</svg>
```

**建議風格**：07、15、19、20。
