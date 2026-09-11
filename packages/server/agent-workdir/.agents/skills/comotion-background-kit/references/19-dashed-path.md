# 19 · dashed-path

**氣氛**：一條虛線從左下彎到右上，像地圖上的路徑或流程的軌跡。有起點、有終點、有方向。

**適合**：`order` 關係的頁面（它會強化 `spine-path` 的方向）。
**不適合**：`membership`。

**建議 opacity**：0.6

**做法**：一條 `stroke-dasharray` 的曲線，兩端各一個小圓標出起點與終點。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<path d="M60 660 C 360 620, 420 300, 700 320 S 1060 240, 1230 90" fill="none" stroke="<primary>" stroke-width="3" stroke-dasharray="14 12" opacity="0.45"/>
<circle cx="60" cy="660" r="10" fill="<primary>" opacity="0.5"/>
<circle cx="1230" cy="90" r="14" fill="<accent>" opacity="0.6"/>
</svg>
```

**建議風格**：05、10、12、23。
