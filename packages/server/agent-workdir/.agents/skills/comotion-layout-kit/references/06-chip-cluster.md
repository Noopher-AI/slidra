# 06 · chip-cluster

**解的關係**：`membership`
**單位數**：5–12
**一句話**：大小不一的標籤散落成一群，沒有對齊格線——像一面貼滿便利貼的牆。

**什麼時候用它**：項目很多、每個都很短（關鍵詞、技能、標籤、工具名）。
**什麼時候不要用**：項目需要被逐一講解。這個版面適合「一次看完整片」，不適合逐個揭露。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="100" y="200" width="240" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="128" y="239" font-size="24" fill="#777777">標籤一</text><rect x="360" y="200" width="180" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="388" y="239" font-size="24" fill="#777777">標籤二</text><rect x="560" y="186" width="320" height="68" fill="#EDEDED" stroke="#BFBFBF" rx="34"/><text x="588" y="229" font-size="28" fill="#2E2E2E">比較重要的標籤</text><rect x="900" y="200" width="220" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="928" y="239" font-size="24" fill="#777777">標籤四</text><rect x="140" y="300" width="200" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="168" y="339" font-size="24" fill="#777777">標籤五</text><rect x="360" y="300" width="280" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="388" y="339" font-size="24" fill="#777777">標籤六</text><rect x="660" y="300" width="190" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="688" y="339" font-size="24" fill="#777777">標籤七</text><rect x="870" y="300" width="250" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="898" y="339" font-size="24" fill="#777777">標籤八</text><rect x="200" y="400" width="260" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="228" y="439" font-size="24" fill="#777777">標籤九</text><rect x="480" y="400" width="210" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="508" y="439" font-size="24" fill="#777777">標籤十</text><rect x="710" y="400" width="300" height="60" fill="#EDEDED" stroke="#BFBFBF" rx="30"/><text x="738" y="439" font-size="24" fill="#777777">標籤十一</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
