# 09 · chain

**解的關係**：`link`
**單位數**：3–5
**一句話**：節點用箭頭依序連起來——跟 `spine-path` 的差別是：連接是畫出來的邊，而不是一條共用的軸。

**什麼時候用它**：每一步「導致」下一步，因果關係本身就是重點。
**什麼時候不要用**：只是先後順序而沒有因果——箭頭會宣稱一個不存在的因果。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="240" width="320" height="300" fill="#EDEDED" stroke="#BFBFBF"/><text x="240" y="400" font-size="28" fill="#2E2E2E" font-weight="700" text-anchor="middle">節點 1</text><text x="240" y="450" font-size="22" fill="#777777" text-anchor="middle">一句說明</text><line x1="416" y1="390" x2="506" y2="390" stroke="#909090" stroke-width="4"/><path d="M504 379l20 11l-20 11z" fill="#909090"/><rect x="460" y="240" width="320" height="300" fill="#EDEDED" stroke="#BFBFBF"/><text x="620" y="400" font-size="28" fill="#2E2E2E" font-weight="700" text-anchor="middle">節點 2</text><text x="620" y="450" font-size="22" fill="#777777" text-anchor="middle">一句說明</text><line x1="796" y1="390" x2="886" y2="390" stroke="#909090" stroke-width="4"/><path d="M884 379l20 11l-20 11z" fill="#909090"/><rect x="840" y="240" width="320" height="300" fill="#EDEDED" stroke="#BFBFBF"/><text x="1000" y="400" font-size="28" fill="#2E2E2E" font-weight="700" text-anchor="middle">節點 3</text><text x="1000" y="450" font-size="22" fill="#777777" text-anchor="middle">一句說明</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
