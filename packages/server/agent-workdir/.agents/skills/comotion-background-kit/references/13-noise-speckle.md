# 13 · noise-speckle

**氣氛**：極細的隨機斑點，像底片顆粒或影印的雜訊。讓純色底不那麼「數位」。

**適合**：任何節奏。
**不適合**：需要絕對乾淨的醫療與資料頁面。

**建議 opacity**：0.3

**做法**：一個 60px 的 pattern，裡面放七個位置不規則、大小不一的小圓。不用 `<filter>` 產生雜訊（濾鏡在匯出時不穩）。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="bg-speckle" width="60" height="60" patternUnits="userSpaceOnUse">
<circle cx="7" cy="11" r="0.9" fill="<muted>" opacity="0.5"/>
<circle cx="34" cy="5" r="0.6" fill="<muted>" opacity="0.4"/>
<circle cx="52" cy="23" r="1" fill="<muted>" opacity="0.45"/>
<circle cx="18" cy="38" r="0.7" fill="<muted>" opacity="0.35"/>
<circle cx="44" cy="47" r="0.5" fill="<muted>" opacity="0.5"/>
<circle cx="3" cy="54" r="0.8" fill="<muted>" opacity="0.3"/>
<circle cx="27" cy="26" r="0.4" fill="<muted>" opacity="0.4"/>
</pattern>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bg-speckle)"/>
</svg>
```

**建議風格**：02、05、09、22、24。
