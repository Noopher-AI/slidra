# 07 · edge-frame

**氣氛**：距離邊界一段距離的細框，像展場的畫框或證書的邊。正式、有儀式感。

**適合**：`anchor`。開場與結尾各用一次最有效。
**不適合**：`dense`。框會把已經很滿的頁面關起來。

**建議 opacity**：0.6

**做法**：兩個同心矩形細框，內框較淡；四個角各一小段加粗，模擬裱框的角件。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<rect x="40" y="40" width="1200" height="640" fill="none" stroke="<primary>" stroke-width="1.5" opacity="0.6"/>
<rect x="56" y="56" width="1168" height="608" fill="none" stroke="<primary>" stroke-width="0.75" opacity="0.3"/>
<path d="M40 80V40h40M1200 40h40v40M1240 640v40h-40M80 680H40v-40" fill="none" stroke="<accent>" stroke-width="3"/>
</svg>
```

**建議風格**：14、18、20、21、24。
