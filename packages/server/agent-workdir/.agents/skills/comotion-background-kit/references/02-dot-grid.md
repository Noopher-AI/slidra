# 02 · dot-grid（點陣格線）

**氣氛**：均勻的細點陣鋪滿整頁，像方格筆記本或工程圖紙。安靜、規律、幾乎察覺不到——但拿掉之後畫面會突然變空。

**適合**：`dense`（內容頁）。點陣提供一層極淡的質地，讓卡片與面板有東西可以浮在上面。
**不適合**：`breathing`。喘息頁要的是空，點陣會把空填掉。

**建議 opacity**：0.5（深色風格）／0.3 以下（淺色風格，否則會像方格紙）。

**做法**：一個 16px 的 `<pattern>` 鋪滿，點用 `muted` 色、半徑 2。右上角一團極淡的 `primary` 徑向漸層打破完全均勻。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-dots" width="32" height="32" patternUnits="userSpaceOnUse">
<circle cx="16" cy="16" r="2" fill="<muted>" opacity="0.75"/>
</pattern>
<radialGradient id="bg-dots-mask" cx="0.3" cy="0.45" r="0.75">
<stop offset="0" stop-color="<background>" stop-opacity="1"/>
<stop offset="0.5" stop-color="<background>" stop-opacity="0.7"/>
<stop offset="1" stop-color="<background>" stop-opacity="0"/>
</radialGradient>
<linearGradient id="bg-dots-edge" x1="0" y1="1" x2="1" y2="0">
<stop offset="0.6" stop-color="<secondary_bg>" stop-opacity="0"/>
<stop offset="1" stop-color="<primary>" stop-opacity="0.32"/>
</linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-dots-edge)"/>
<rect width="1280" height="720" fill="url(#bg-dots)"/>
<rect width="1280" height="720" fill="url(#bg-dots-mask)"/>
<line x1="1040" y1="0" x2="1040" y2="720" stroke="<accent>" stroke-width="1" opacity="0.35"/>
  <ellipse cx="1180" cy="60" rx="420" ry="420" fill="<primary>" opacity="0.12"/>
</svg>
```

**建議風格**：01 `editorial-tech`、03 `clean-brief`（opacity 要壓低）。02 `warm-editorial` 的紙感跟格線衝突，不建議。
