# 11 · flow

**解的關係**：`link`
**單位數**：3–5
**一句話**：來源 → 轉換 → 結果的橫向流程，中間那一格明顯比較重要。

**什麼時候用它**：有輸入與輸出的過程（資料管線、製程、服務流程）。
**什麼時候不要用**：沒有明確輸入輸出的循環或並列。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="280" width="260" height="220" fill="#EDEDED" stroke="#BFBFBF"/><text x="210" y="400" font-size="26" fill="#777777" text-anchor="middle">輸入</text><line x1="356" y1="390" x2="428" y2="390" stroke="#909090" stroke-width="4"/><path d="M426 379l20 11l-20 11z" fill="#909090"/><rect x="460" y="216" width="360" height="348" fill="#DCDCDC" stroke="#909090"/><text x="640" y="368" font-size="32" fill="#2E2E2E" font-weight="700" text-anchor="middle">轉換</text><text x="640" y="420" font-size="24" fill="#777777" text-anchor="middle">這裡是重點</text><line x1="838" y1="390" x2="910" y2="390" stroke="#909090" stroke-width="4"/><path d="M908 379l20 11l-20 11z" fill="#909090"/><rect x="940" y="280" width="260" height="220" fill="#EDEDED" stroke="#BFBFBF"/><text x="1070" y="400" font-size="26" fill="#777777" text-anchor="middle">輸出</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
