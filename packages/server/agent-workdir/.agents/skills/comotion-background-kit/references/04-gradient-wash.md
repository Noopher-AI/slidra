# 04 · gradient-wash

**氣氛**：從左下到右上的單向漸層，沒有任何圖形。最安靜的一種背景——它只是讓畫面不那麼平。

**適合**：任何節奏。這是最通用、最不會出錯的一個。
**不適合**：幾乎沒有。真的要挑，是需要質地感的紙感風格。

**建議 opacity**：0.8（深色風格）／0.4（淺色風格）

**做法**：一個線性漸層，從 `background` 過渡到 `secondary_bg`，角度 135 度。沒有第二個元素。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="bg-wash" x1="0" y1="1" x2="1" y2="0">
<stop offset="0" stop-color="<background>"/>
<stop offset="0.55" stop-color="<secondary_bg>"/>
<stop offset="1" stop-color="<background>"/>
</linearGradient>
</defs>
<rect width="1280" height="720" fill="url(#bg-wash)"/>
</svg>
```

**建議風格**：全部。特別適合 03、06、17、21、25 這些克制的風格。
