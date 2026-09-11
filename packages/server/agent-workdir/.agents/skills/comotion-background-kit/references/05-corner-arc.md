# 05 · corner-arc

**氣氛**：右下角一道大圓弧切進畫面，像一枚被放大的印記。安靜但有存在感。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。圓弧會跟卡片邊界打架。

**建議 opacity**：0.7

**做法**：一個超出畫布的大圓，只露出左上那一段弧；描邊而非填色，所以它是「線」不是「塊」。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<circle cx="1180" cy="640" r="420" fill="none" stroke="<primary>" stroke-width="2" opacity="0.5"/>
<circle cx="1180" cy="640" r="300" fill="none" stroke="<primary>" stroke-width="1" opacity="0.35"/>
<circle cx="1180" cy="640" r="180" fill="<primary>" opacity="0.08"/>
</svg>
```

**建議風格**：01、06、13、20、23。
