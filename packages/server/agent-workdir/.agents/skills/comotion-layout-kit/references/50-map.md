# 50 · map

**解的關係**：`membership`
**單位數**：2–6
**一句話**：地理輪廓加上標記點，右側一個圖例——空間分布本身就是訊息。

**什麼時候用它**：據點分布、市場覆蓋、區域數據、供應鏈。
**什麼時候不要用**：資料跟地理位置無關。地圖會讓人去找空間關係，找不到就是浪費了整頁。**不要為了好看放地圖**。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<path d="M262 318 L330 262 L396 286 L432 240 L508 252 L556 216 L628 246 L672 214 L742 252 L786 232 L814 288 L872 316 L856 372 L898 416 L862 468 L878 520 L812 548 L758 520 L706 566 L642 540 L580 572 L516 538 L462 556 L408 514 L342 522 L306 470 L246 440 L276 384 Z" fill="#EDEDED" stroke="#BFBFBF" stroke-width="3" stroke-linejoin="round"/><ellipse cx="430" cy="336" rx="14" ry="14" fill="#DCDCDC" stroke="#3A3A3A" stroke-width="4"/><text x="458" y="345" font-size="22" fill="#777777">北部據點</text><ellipse cx="600" cy="404" rx="20" ry="20" fill="#DCDCDC" stroke="#3A3A3A" stroke-width="4"/><text x="634" y="413" font-size="22" fill="#777777">中部據點</text><ellipse cx="742" cy="474" rx="11" ry="11" fill="#DCDCDC" stroke="#3A3A3A" stroke-width="4"/><text x="767" y="483" font-size="22" fill="#777777">南部據點</text><rect x="960" y="240" width="240" height="290" fill="#FAFAFA" stroke="#BFBFBF"/><text x="986" y="286" font-size="24" fill="#2E2E2E" font-weight="700">圖例</text><ellipse cx="1000" cy="336" rx="10" ry="10" fill="#DCDCDC" stroke="#3A3A3A" stroke-width="3"/><text x="1026" y="344" font-size="20" fill="#777777">據點（大小＝量）</text><line x1="986" y1="372" x2="1176" y2="372" stroke="#E6E6E6" stroke-width="1"/><text x="986" y="412" font-size="20" fill="#777777">・北部　數值</text><text x="986" y="452" font-size="20" fill="#777777">・中部　數值</text><text x="986" y="492" font-size="20" fill="#777777">・南部　數值</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 輪廓 | `field` | 簡化的地理形狀 | — | — |
| 標記 ×N | `node` | 點的大小可反映量 | — | — |
| 標記名 | `label` | 貼在點旁邊 | 8 字 | 1 |
| 圖例 | `field` + `label` | 說明點代表什麼 | 每行 12 字 | 1 |

## 節奏

輪廓佔版面約 55%，圖例放右側。**標記不要互相重疊**；密集區域改用一個大點加數字，不要擠一堆小點。輪廓用單色，不要做地形起伏——那會搶走標記。

`blueprint.shape` 寫 `map`。

## 變體

- **點大小反映量**：標記半徑對應數值，圖例要標出比例尺。
- **區域著色**：輪廓分區上色而不是放點，適合比較區域之間的強弱。
