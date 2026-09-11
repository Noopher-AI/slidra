# 47 · funnel

**解的關係**：`order`
**單位數**：3–5
**一句話**：上寬下窄的轉換堆疊，寬度就是量——一眼看出每一層流失多少。

**什麼時候用它**：轉換流程（行銷漏斗、招募流程、銷售管線），而且**每一層有真實數字**。
**什麼時候不要用**：各層之間沒有量的遞減——漏斗的形狀會宣稱一個不存在的流失。沒有真實數字時不要用。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<path d="M140.0 190H1140.0L1052.5 296H227.5Z" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="252.0" font-size="26" fill="#777777" text-anchor="middle">階段1</text><text x="1180" y="251.0" font-size="22" fill="#555555" text-anchor="end">數值</text><path d="M227.5 296H1052.5L965.0 402H315.0Z" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="358.0" font-size="26" fill="#777777" text-anchor="middle">階段2</text><text x="1180" y="357.0" font-size="22" fill="#555555" text-anchor="end">數值</text><path d="M315.0 402H965.0L877.5 508H402.5Z" fill="#EDEDED" stroke="#BFBFBF"/><text x="640" y="464.0" font-size="26" fill="#777777" text-anchor="middle">階段3</text><text x="1180" y="463.0" font-size="22" fill="#555555" text-anchor="end">數值</text><path d="M402.5 508H877.5L790.0 614H490.0Z" fill="#DCDCDC" stroke="#BFBFBF"/><text x="640" y="570.0" font-size="26" fill="#2E2E2E" text-anchor="middle">階段4</text><text x="1180" y="569.0" font-size="22" fill="#555555" text-anchor="end">數值</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 漏斗層 ×N | `node` | **寬度反映真實數量** | — | — |
| 層名 | `label` | | 8 字 | 1 |
| 數值 | `label` | 右側對齊 | 8 字 | 1 |
| 轉換率 | `label` | 可省，放在層與層之間 | 6 字 | 1 |

## 節奏

每層等高，寬度依真實數字遞減。**最後一層加深**——那是這一頁真正要講的結果。層與層之間不留空隙。

`blueprint.shape` 寫 `funnel`。

## 變體

- **標轉換率**：每兩層之間寫一個百分比，講流失在哪一段最嚴重。
- **橫向**：改成由左至右變窄，適合搭配時間軸。
