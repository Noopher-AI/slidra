# 15 · venn

**解的關係**：`overlap`
**單位數**：2–3
**一句話**：相交的圓，交集區被明確標示——共有與各有一眼看清。

**什麼時候用它**：兩三個東西有共同的部分，而那個共同部分正是這一頁的重點。
**什麼時候不要用**：只是比較兩者的差異——那是 `contrast`，用 `split-panel`。交集區沒有內容時不要用這個版面。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<defs><clipPath id="cA"><ellipse cx="500" cy="400" rx="270" ry="200"/></clipPath><clipPath id="cB"><ellipse cx="780" cy="400" rx="270" ry="200"/></clipPath></defs><ellipse cx="500" cy="400" rx="270" ry="200" fill="#EDEDED" stroke="#BFBFBF" stroke-width="2"/><ellipse cx="780" cy="400" rx="270" ry="200" fill="#EDEDED" stroke="#BFBFBF" stroke-width="2"/><g clip-path="url(#cA)"><ellipse cx="780" cy="400" rx="270" ry="200" fill="#DCDCDC"/></g><g clip-path="url(#cA)"><ellipse cx="780" cy="400" rx="270" ry="200" fill="none" stroke="#909090" stroke-width="2"/></g><text x="330" y="410" font-size="26" fill="#777777" text-anchor="middle">只有 A</text><text x="950" y="410" font-size="26" fill="#777777" text-anchor="middle">只有 B</text><text x="640" y="406" font-size="26" fill="#2E2E2E" font-weight="700" text-anchor="middle">共有</text><text x="640" y="634" font-size="22" fill="#A0A0A0" text-anchor="middle">交集的一句說明：這個共同點為什麼重要</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
