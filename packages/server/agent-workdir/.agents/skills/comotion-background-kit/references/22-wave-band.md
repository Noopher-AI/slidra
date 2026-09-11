# 22 · wave-band

**氣氛**：畫面下緣一道起伏的波形帶，像水面或聲波。柔軟、有流動感，而且只佔底部。

**適合**：`anchor`、`breathing`。內容區完全不受影響。
**不適合**：`dense` 且內容延伸到底部時。

**建議 opacity**：0.7

**做法**：兩條錯開的波形 path 填滿下緣，後面那條較淡。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<path d="M0 600 C 200 550, 340 650, 560 600 S 940 520, 1280 580 V720 H0Z" fill="<primary>" opacity="0.18"/>
<path d="M0 650 C 240 610, 420 700, 660 650 S 1020 590, 1280 640 V720 H0Z" fill="<secondary_accent>" opacity="0.25"/>
</svg>
```

**建議風格**：10、12、23、08。
