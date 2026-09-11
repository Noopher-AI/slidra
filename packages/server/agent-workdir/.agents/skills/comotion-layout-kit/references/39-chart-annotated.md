# 39 · chart-annotated

**解的關係**：`none`
**單位數**：1
**一句話**：一張圖表放大置中，關鍵處拉出註解線——把「你該看這裡」畫在圖上。

**什麼時候用它**：圖表有一個明確的轉折、異常或高點，而那正是這一頁的主張。
**什麼時候不要用**：圖表要講的是整體趨勢而沒有特定的點——那用 27 `chart-focus`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="140" y="170" width="1000" height="400" fill="#F4F4F4" stroke="#AAAAAA"/>
<path d="M200 500 L400 460 L600 470 L760 300 L1000 260" fill="none" stroke="#666666" stroke-width="3"/>
<ellipse cx="760" cy="300" rx="12" ry="12" fill="#FFFFFF" stroke="#333333" stroke-width="3"/>
<line x1="772" y1="292" x2="880" y2="220" stroke="#666666" stroke-width="1.5"/>
<text x="890" y="215" font-size="16" fill="#333333">這裡開始轉折</text>
<text x="890" y="245" font-size="14" fill="#888888">原因的一句話</text>
<text x="140" y="620" font-size="14" fill="#999999">資料來源</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
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
