# 28 · step-blocks

**氣氛**：右下角一組階梯狀的方塊，由低到高。有成長、有進度的暗示。

**適合**：`order` 關係的頁面、以及 `breathing` 的成果頁。
**不適合**：`membership`。階梯有高低，並列的內容不該有。

**建議 opacity**：0.6

**做法**：五個等寬、遞增高度的矩形貼在底部右側，透明度隨高度遞增。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="<primary>">
<rect x="780" y="620" width="88" height="100" opacity="0.12"/>
<rect x="880" y="560" width="88" height="160" opacity="0.18"/>
<rect x="980" y="480" width="88" height="240" opacity="0.24"/>
<rect x="1080" y="380" width="88" height="340" opacity="0.3"/>
<rect x="1180" y="260" width="88" height="460" opacity="0.36"/>
</g>
</svg>
```

**建議風格**：11、12、18、25。
