# 11 · flow

**解的關係**：`link`
**單位數**：3–5
**一句話**：來源 → 轉換 → 結果的橫向流程，中間那一格明顯比較重要。

**什麼時候用它**：有輸入與輸出的過程（資料管線、製程、服務流程）。
**什麼時候不要用**：沒有明確輸入輸出的循環或並列。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="100" y="300" width="200" height="120" fill="#F2F2F2" stroke="#AAAAAA"/>
<text x="140" y="365" font-size="16" fill="#666666">輸入</text>
<path d="M310 360h60" stroke="#666666" stroke-width="3"/><path d="M360 350l20 10l-20 10z" fill="#666666"/>
<rect x="390" y="260" width="320" height="200" fill="#E0E0E0" stroke="#888888"/>
<text x="430" y="340" font-size="20" fill="#333333">轉換（較大）</text>
<text x="430" y="380" font-size="14" fill="#777777">這裡是重點</text>
<path d="M720 360h60" stroke="#666666" stroke-width="3"/><path d="M770 350l20 10l-20 10z" fill="#666666"/>
<rect x="800" y="300" width="200" height="120" fill="#F2F2F2" stroke="#AAAAAA"/>
<text x="840" y="365" font-size="16" fill="#666666">輸出</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 輸入 | `node` | | 10 字 | 1 |
| 轉換 | `node`（**最大的那個**） | 這一頁真正要講的 | 18 字 | 2 |
| 輸出 | `node` | | 10 字 | 1 |
| 箭頭 | `edge` | | — | — |

## 節奏

中間的轉換節點要明顯大（寬 1.5 倍、高 1.6 倍）——**如果三個一樣大，這就變成 `chain` 了**，那表示你其實沒有在講轉換。

`blueprint.shape` 寫 `flow`。

## 變體

- **多輸入**：左側兩三個小節點各自箭頭指向中央。
- **分岔輸出**：右側分成兩個結果，講「同一個過程的兩種結局」。
