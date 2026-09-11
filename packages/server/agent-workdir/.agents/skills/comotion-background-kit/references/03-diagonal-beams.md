# 03 · diagonal-beams（對角光束）

**氣氛**：三道從右上斜向左下的光束，左側被徑向漸層壓暗。**有方向、有速度**——這是這個配方最重要的性質，也是它的限制。

**適合**：`anchor`、`breathing`，以及 `order` 關係的頁面（光束的方向會強化閱讀方向）。
**不適合**：`membership` 的頁面。並列的內容配上有方向的背景，背景會說錯話。

**建議 opacity**：0.7。

**做法**：兩道 `primary`、一道 `accent` 的長條 path，角度一致；左側疊一層徑向漸層把文字區壓暗。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-beam-1" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<primary>" stop-opacity="0"/>
<stop offset="0.5" stop-color="<primary>" stop-opacity="0.22"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0"/>
</linearGradient>
<linearGradient id="bg-beam-2" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="<accent>" stop-opacity="0"/>
<stop offset="0.5" stop-color="<accent>" stop-opacity="0.14"/>
<stop offset="1" stop-color="<accent>" stop-opacity="0"/>
</linearGradient>
<radialGradient id="bg-beam-fall" cx="0.2" cy="0.5" r="0.8">
<stop offset="0" stop-color="<background>" stop-opacity="1"/>
<stop offset="0.45" stop-color="<background>" stop-opacity="0.7"/>
<stop offset="1" stop-color="<background>" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M520 720 L1280 -40 L1280 200 L760 720 Z" fill="url(#bg-beam-1)"/>
<path d="M820 720 L1280 260 L1280 420 L980 720 Z" fill="url(#bg-beam-2)"/>
<path d="M300 720 L1280 -240 L1280 -140 L400 720 Z" fill="<primary>" opacity="0.06"/>
<rect width="1280" height="720" fill="url(#bg-beam-fall)"/>
  <ellipse cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>
</svg>
```

**建議風格**：01 `editorial-tech`。淺底風格上光束會太顯眼，要用的話 opacity 降到 0.3 以下。
