# 10 · hub

**解的關係**：`link`
**單位數**：1 + 3–6
**一句話**：中心一個節點，其餘放射排列並各自連回中心——一眼看出誰是核心。

**什麼時候用它**：一個東西連結／支撐其他所有東西（平台與應用、核心團隊與專案）。
**什麼時候不要用**：各項目彼此也有關係——放射會宣稱「它們只跟中心有關」。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<ellipse cx="640" cy="380" rx="110" ry="110" fill="#DDDDDD" stroke="#888888"/>
<text x="595" y="388" font-size="18" fill="#333333">核心</text>
<g stroke="#AAAAAA" stroke-width="2">
<line x1="640" y1="270" x2="640" y2="200"/><line x1="750" y1="380" x2="900" y2="380"/>
<line x1="640" y1="490" x2="640" y2="560"/><line x1="530" y1="380" x2="380" y2="380"/>
</g>
<rect x="540" y="150" width="200" height="56" fill="#F0F0F0" stroke="#AAAAAA"/>
<rect x="900" y="352" width="200" height="56" fill="#F0F0F0" stroke="#AAAAAA"/>
<rect x="540" y="560" width="200" height="56" fill="#F0F0F0" stroke="#AAAAAA"/>
<rect x="180" y="352" width="200" height="56" fill="#F0F0F0" stroke="#AAAAAA"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
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
