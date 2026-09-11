# 09 · chain

**解的關係**：`link`
**單位數**：3–5
**一句話**：節點用箭頭依序連起來——跟 `spine-path` 的差別是：連接是畫出來的邊，而不是一條共用的軸。

**什麼時候用它**：每一步「導致」下一步，因果關係本身就是重點。
**什麼時候不要用**：只是先後順序而沒有因果——箭頭會宣稱一個不存在的因果。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="100" y="280" width="220" height="120" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="140" y="345" font-size="18" fill="#666666">node 1</text>
<path d="M330 340h80" stroke="#666666" stroke-width="3" marker-end="url(#a)"/>
<path d="M400 330l20 10l-20 10z" fill="#666666"/>
<rect x="430" y="280" width="220" height="120" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="470" y="345" font-size="18" fill="#666666">node 2</text>
<path d="M660 340h80" stroke="#666666" stroke-width="3"/>
<path d="M730 330l20 10l-20 10z" fill="#666666"/>
<rect x="760" y="280" width="220" height="120" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="800" y="345" font-size="18" fill="#666666">node 3</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 節點 ×N | `node`（`field` + `label`） | | 12 字 | 1–2 |
| 箭頭 ×(N−1) | `edge` | **必要的連接才畫** | — | — |
| 邊標籤 | `label` | 可省；寫「因為什麼」 | 8 字 | 1 |

## 節奏

節點等寬等高、水平等距。箭頭長度一致。**邊的數量必須是 N−1**，多一條就表示有分支，那要換 `flow`。

`blueprint.shape` 寫 `chain`。

## 變體

- **加邊標籤**：每個箭頭上方寫一個動詞，說明這一步靠什麼發生。
- **回饋**：最後一個節點拉一條弧線回到第一個，表示循環。
