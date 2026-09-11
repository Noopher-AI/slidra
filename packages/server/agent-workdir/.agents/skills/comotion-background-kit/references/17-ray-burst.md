# 17 · ray-burst

**氣氛**：從右下角射出的放射線，像陽光或聚光。有能量、有焦點。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`、以及 `membership` 的並列頁——放射有方向，會說錯話。

**建議 opacity**：0.5

**做法**：七條從同一點射出的細長三角形 path，角度等分。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="<accent>" opacity="0.16">
<path d="M1280 720L620 -60l90 0z"/>
<path d="M1280 720L860 -60l90 0z"/>
<path d="M1280 720L1100 -60l90 0z"/>
<path d="M1280 720L-60 300l0 80z"/>
<path d="M1280 720L-60 480l0 70z"/>
<path d="M1280 720L-60 620l0 60z"/>
<path d="M1280 720L300 -60l80 0z"/>
</g>
</svg>
```

**建議風格**：07、11、15、19。
