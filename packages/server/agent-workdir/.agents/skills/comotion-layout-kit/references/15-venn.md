# 15 · venn

**解的關係**：`overlap`
**單位數**：2–3
**一句話**：相交的圓，交集區被明確標示——共有與各有一眼看清。

**什麼時候用它**：兩三個東西有共同的部分，而那個共同部分正是這一頁的重點。
**什麼時候不要用**：只是比較兩者的差異——那是 `contrast`，用 `split-panel`。交集區沒有內容時不要用這個版面。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<ellipse cx="520" cy="380" rx="220" ry="180" fill="#E8E8E8" stroke="#999999"/>
<ellipse cx="760" cy="380" rx="220" ry="180" fill="#E8E8E8" stroke="#999999"/>
<text x="330" y="390" font-size="18" fill="#666666">只有 A</text>
<text x="880" y="390" font-size="18" fill="#666666">只有 B</text>
<text x="600" y="390" font-size="18" fill="#333333">共有</text>
<text x="560" y="600" font-size="16" fill="#888888">交集的說明（label）</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 圓 ×N | `node` | 半透明才看得到交集 | — | — |
| 各自區標籤 | `label` | | 8 字 | 1 |
| 交集標籤 | `label` | **這是重點** | 10 字 | 1 |
| 交集說明 | `label` | 放在圖下方 | 24 字 | 2 |

## 節奏

圓的重疊面積約為單圓的 25%——太少看不出共有，太多看不出各有。填色要半透明（opacity 0.5 上下），否則交集不會顯色。

`blueprint.shape` 寫 `venn`。

## 變體

- **三圓**：三個等距相交，中央是三者共有——但三圓的標籤位置很難擺，內容要非常短。
- **方形版**：改用兩個相交的圓角矩形，跟其他版面的語彙更一致。
