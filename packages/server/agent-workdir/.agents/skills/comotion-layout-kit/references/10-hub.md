# 10 · hub

**解的關係**：`link`
**單位數**：1 + 3–6
**一句話**：中心一個節點，其餘放射排列並各自連回中心——一眼看出誰是核心。

**什麼時候用它**：一個東西連結／支撐其他所有東西（平台與應用、核心團隊與專案）。
**什麼時候不要用**：各項目彼此也有關係——放射會宣稱「它們只跟中心有關」。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<ellipse cx="640" cy="400" rx="130" ry="130" fill="#DCDCDC" stroke="#909090" stroke-width="3"/><text x="640" y="410" font-size="28" fill="#2E2E2E" font-weight="700" text-anchor="middle">核心</text><line x1="640" y1="176" x2="640" y2="270" stroke="#BFBFBF" stroke-width="2"/><line x1="1000" y1="400" x2="770" y2="400" stroke="#BFBFBF" stroke-width="2"/><line x1="640" y1="616" x2="640" y2="530" stroke="#BFBFBF" stroke-width="2"/><line x1="280" y1="400" x2="510" y2="400" stroke="#BFBFBF" stroke-width="2"/><rect x="480" y="176" width="320" height="64" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="216" font-size="24" fill="#777777" text-anchor="middle">外圍一</text><rect x="1000" y="368" width="320" height="64" fill="#EDEDED" stroke="#BFBFBF"/><text x="1160" y="408" font-size="24" fill="#777777" text-anchor="middle">外圍二</text><rect x="480" y="560" width="320" height="64" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="600" font-size="24" fill="#777777" text-anchor="middle">外圍三</text><rect x="120" y="368" width="320" height="64" fill="#EDEDED" stroke="#BFBFBF"/><text x="280" y="408" font-size="24" fill="#777777" text-anchor="middle">外圍四</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 中心 | `node` | 核心的那一個 | 8 字 | 1 |
| 外圍 ×N | `node` | | 10 字 | 1 |
| 連線 ×N | `edge` | 每條都連回中心 | — | — |

## 節奏

外圍節點**等距分布在同一個圓周上**，不要上下左右隨意擺。中心節點明顯大於外圍——大小差就是主從。

`blueprint.shape` 寫 `hub`。

## 變體

- **半放射**：只往右半邊展開，左邊留給標題與說明。
- **雙中心**：兩個核心各自帶幾個外圍，中間再連一條——講兩個系統如何整合。
