# 27 · chart-focus

**解的關係**：`none`
**單位數**：1
**一句話**：一張圖表佔據主要空間，旁邊一句結論——圖表是證據，結論才是主張。

**什麼時候用它**：有一組數據，而且你要說的是它顯示了什麼。
**什麼時候不要用**：數據本身就是重點而沒有結論——那只是把表格貼上來。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="176" width="760" height="420" fill="#F4F4F4" stroke="#AAAAAA"/>
<text x="380" y="390" font-size="18" fill="#888888">圖表（chart）</text>
<text x="880" y="240" font-size="24" fill="#333333">結論一句話</text>
<text x="880" y="300" font-size="16" fill="#666666">補充說明，說明</text>
<text x="880" y="330" font-size="16" fill="#666666">這張圖為什麼重要</text>
<text x="880" y="580" font-size="14" fill="#999999">資料來源</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 圖表 | `node`（chart 元素） | | — | — |
| 結論 | `label`（`subtitle`～`claim`） | **這一頁真正的主張** | 18 字 | 1–2 |
| 說明 | `label` | | 30 字 | 2–3 |
| 來源 | `label`（`caption`） | | 20 字 | 1 |

## 節奏

圖表佔約 60% 寬，結論欄 30%，中間一個 `gutter`。結論的字級要明顯大於圖表的軸標籤——**否則讀者會先讀圖再自己下結論，那就失去了這一頁的目的**。

`blueprint.shape` 寫 `chart-focus`。

## 變體

- **上圖下結論**：圖表滿寬，結論在下方一整行——適合寬型的時間序圖。
- **雙圖**：兩張小圖並排，結論在下方。
