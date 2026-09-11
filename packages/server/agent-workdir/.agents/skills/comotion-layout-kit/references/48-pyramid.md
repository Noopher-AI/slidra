# 48 · pyramid

**解的關係**：`parent`
**單位數**：3–5
**一句話**：下寬上窄的層級堆疊，底層是基礎、頂層是結果。

**什麼時候用它**：有「必須先有下面才有上面」關係的層級（能力堆疊、價值層級、需求層次）。
**什麼時候不要用**：各層平行並列——那是 `membership`。金字塔會宣稱一個不存在的依賴。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<path d="M540.0 190H740.0L840.0 296H440.0Z" fill="#DCDCDC" stroke="#BFBFBF"/><text x="640" y="252.0" font-size="24" fill="#2E2E2E" text-anchor="middle">第1層</text><path d="M440.0 296H840.0L940.0 402H340.0Z" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="358.0" font-size="24" fill="#777777" text-anchor="middle">第2層</text><path d="M340.0 402H940.0L1040.0 508H240.0Z" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="464.0" font-size="24" fill="#777777" text-anchor="middle">第3層</text><path d="M240.0 508H1040.0L1140.0 614H140.0Z" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="570.0" font-size="24" fill="#777777" text-anchor="middle">第4層</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 層 ×N | `node` | 由下而上變窄 | — | — |
| 層名 | `label` | 置中 | 10 字 | 1 |
| 層說明 | `label` | 可省，放在右側 | 18 字 | 1 |

## 節奏

每層等高，寬度線性遞減。**頂層加深**——它是這個結構要導向的結論。層與層之間不留空隙，空隙會讓「堆疊」變成「並列」。

`blueprint.shape` 寫 `pyramid`。

## 變體

- **倒金字塔**：上寬下窄，講「從大範圍收斂到一個結論」。
- **右側說明欄**：每層右邊配一句話，適合層數少的時候。
