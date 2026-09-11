# 06 · chip-cluster

**解的關係**：`membership`
**單位數**：5–12
**一句話**：大小不一的標籤散落成一群，沒有對齊格線——像一面貼滿便利貼的牆。

**什麼時候用它**：項目很多、每個都很短（關鍵詞、技能、標籤、工具名）。
**什麼時候不要用**：項目需要被逐一講解。這個版面適合「一次看完整片」，不適合逐個揭露。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="120" y="200" width="220" height="56" rx="28" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="150" y="234" font-size="16" fill="#666666">標籤一</text>
<rect x="360" y="200" width="160" height="56" rx="28" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="390" y="234" font-size="16" fill="#666666">標籤二</text>
<rect x="540" y="180" width="280" height="68" rx="34" fill="#E4E4E4" stroke="#999999"/>
<text x="570" y="220" font-size="20" fill="#444444">較重要的標籤</text>
<rect x="200" y="290" width="260" height="56" rx="28" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="230" y="324" font-size="16" fill="#666666">標籤四</text>
<rect x="480" y="290" width="180" height="56" rx="28" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="510" y="324" font-size="16" fill="#666666">標籤五</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 標籤 ×N | `node`（圓角 `field` + `label`） | 一個關鍵詞 | 8 字 | 1 |

## 節奏

**不要對齊成格線**——對齊會讓它變成一個很醜的表格。標籤寬度隨字長，高度一致，換行時左緣錯開。重要的標籤可以放大一級，但一頁最多兩個放大的。

`blueprint.shape` 寫 `chip-cluster`。

## 變體

- **分組**：用兩三個留白帶把標籤分成幾群，每群上方一個小標。
- **實心／外框混用**：已有的用實心、規劃中的用外框。
