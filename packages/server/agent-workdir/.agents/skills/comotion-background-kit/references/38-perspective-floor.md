# 38 · perspective-floor

**氣氛**：地平線上的透視格線，往右方的消失點收斂。有空間、有縱深，而且自帶方向。

**適合**：`anchor`、`breathing`，以及 `order` 關係的頁面。
**不適合**：`membership`。透視有方向，並列的內容不該有。

**建議 opacity**：0.6

**做法**：放射線全部指向同一個消失點；橫線間距以等比遞減模擬透視。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="pf" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="<primary>" stop-opacity="0.16"/><stop offset="1" stop-color="<primary>" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<line x1="-660" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-550" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-440" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-330" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-220" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-110" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="0" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="110" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="220" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="330" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="440" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="550" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="660" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="770" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="880" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="990" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1100" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1210" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1320" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1430" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1540" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1650" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1760" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1870" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1980" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="2090" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="0" y1="720" x2="1280" y2="720" stroke="<primary>" stroke-width="1" opacity="0.26"/><line x1="0" y1="709" x2="1280" y2="709" stroke="<primary>" stroke-width="1" opacity="0.25"/><line x1="0" y1="695" x2="1280" y2="695" stroke="<primary>" stroke-width="1" opacity="0.25"/><line x1="0" y1="676" x2="1280" y2="676" stroke="<primary>" stroke-width="1" opacity="0.24"/><line x1="0" y1="650" x2="1280" y2="650" stroke="<primary>" stroke-width="1" opacity="0.23"/><line x1="0" y1="615" x2="1280" y2="615" stroke="<primary>" stroke-width="1" opacity="0.21"/><line x1="0" y1="569" x2="1280" y2="569" stroke="<primary>" stroke-width="1" opacity="0.19"/><line x1="0" y1="507" x2="1280" y2="507" stroke="<primary>" stroke-width="1" opacity="0.16"/><line x1="0" y1="424" x2="1280" y2="424" stroke="<primary>" stroke-width="1" opacity="0.12"/><rect y="300" width="1280" height="420" fill="url(#pf)"/>
</svg>
```

**建議風格**：01、04、13、15。
