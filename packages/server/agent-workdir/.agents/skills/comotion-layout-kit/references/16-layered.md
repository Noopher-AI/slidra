# 16 · layered

**解的關係**：`overlap`
**單位數**：2–4
**一句話**：疊放的方塊錯開排列，共同覆蓋的區域在最上層——比 `venn` 更適合放文字。

**什麼時候用它**：幾個東西有共用的基礎或共同的部分，而且每一層都要放得下一句話。
**什麼時候不要用**：只有兩個東西且交集很單純——`venn` 更直觀。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="180" y="200" width="540" height="300" fill="#EDEDED" stroke="#BFBFBF"/><text x="212" y="248" font-size="24" fill="#555555">層一</text><rect x="420" y="330" width="540" height="286" fill="#E3E3E3" stroke="#BFBFBF"/><text x="880" y="378" font-size="24" fill="#555555" text-anchor="end">層二</text><rect x="420" y="330" width="300" height="170" fill="#DCDCDC" stroke="#909090"/><text x="570" y="428" font-size="24" fill="#2E2E2E" font-weight="700" text-anchor="middle">共同區</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 層 ×N | `node`（`field`） | 錯開疊放 | — | — |
| 層名 | `label` | 放在各自不被遮住的角落 | 10 字 | 1 |
| 共同區 | `node` | 顏色最深 | 8 字 | 1 |

## 節奏

錯開的距離約為方塊寬的 40%。**共同區必須是最深的顏色**，否則看起來只是兩個方塊剛好疊到。層名一定要放在沒被遮住的地方。

`blueprint.shape` 寫 `layered`。

## 變體

- **三層階梯**：三個方塊依序錯開，像撲克牌攤開。
- **底層加寬**：最底層明顯較大，表示它是基礎而不是對等的一層。
