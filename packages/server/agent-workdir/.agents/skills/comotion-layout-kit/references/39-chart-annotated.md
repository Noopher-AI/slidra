# 39 · chart-annotated

**解的關係**：`none`
**單位數**：1
**一句話**：一張圖表放大置中，關鍵處拉出註解線——把「你該看這裡」畫在圖上。

**什麼時候用它**：圖表有一個明確的轉折、異常或高點，而那正是這一頁的主張。
**什麼時候不要用**：圖表要講的是整體趨勢而沒有特定的點——那用 27 `chart-focus`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="780" height="400" fill="#F1F1F1" stroke="#BFBFBF"/><path d="M140 500L300 452L460 468L620 300L820 250" fill="none" stroke="#7A7A7A" stroke-width="5"/><ellipse cx="620" cy="300" rx="18" ry="18" fill="#FFFFFF" stroke="#333333" stroke-width="5"/><line x1="642" y1="288" x2="900" y2="244" stroke="#8A8A8A" stroke-width="2"/><text x="900" y="236" font-size="28" fill="#2E2E2E" font-weight="700">這裡開始轉折</text><text x="900" y="282" font-size="22" fill="#777777">原因的一句話</text><text x="80" y="614" font-size="18" fill="#A0A0A0">資料來源</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 圖表 | `node`（chart） | 放大置中 | — | — |
| 標記點 | `node` | 圈出關鍵處 | — | — |
| 引線 | `edge` | 從標記點拉到註解 | — | — |
| 註解 | `label` | **一頁最多兩個** | 14 字 | 1–2 |
| 來源 | `label`（`caption`） | | 20 字 | 1 |

## 節奏

註解放在圖的留白處，引線不要穿過資料。**註解超過兩個就表示這張圖講太多事**，該拆頁。

`blueprint.shape` 寫 `chart-annotated`。

## 變體

- **區間標記**：用一塊半透明色塊圈出一段時間，而不是單點。
- **雙註解**：一個標高點、一個標低點，講落差。
