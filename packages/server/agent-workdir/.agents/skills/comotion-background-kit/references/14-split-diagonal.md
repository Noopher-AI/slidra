# 14 · split-diagonal

**氣氛**：一條對角線把畫面分成深淺兩半。乾脆、有張力，而且天然適合左右對照。

**適合**：`anchor`、以及 `contrast` 關係的頁面。
**不適合**：`dense` 的卡片牆——分割線會穿過卡片。

**建議 opacity**：0.7

**做法**：一個三角形 path 蓋住右下半，顏色用 `secondary_bg`；交界處加一條 accent 細線。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<path d="M1280 0V720H0Z" fill="<secondary_bg>"/>
<line x1="0" y1="720" x2="1280" y2="0" stroke="<accent>" stroke-width="2" opacity="0.6"/>
</svg>
```

**建議風格**：07、09、11、15、22。
