# 52 · vertical-list

**畫布**：1242×1660（3:4）　**這不是 16:9 的版面**
**解的關係**：`membership`
**單位數**：3–6
**一句話**：直式編號清單：一個標題加一列橫條，捲動式閱讀的知識貼文。

**什麼時候用它**：圖文知識貼文、清單型內容、社群長圖。
**什麼時候不要用**：需要一眼看完的場合——這個比例預期讀者會捲動。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1242 1660">
<rect x="0" y="0" width="1242" height="1660" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="180" font-size="64" fill="#2E2E2E" font-weight="700">標題放這裡</text><rect x="80" y="214" width="96" height="8" fill="#909090"/><text x="80" y="290" font-size="36" fill="#555555">一句副標，說明這篇在講什麼</text><rect x="80" y="400" width="1082" height="180" fill="#EDEDED" stroke="#BFBFBF"/><text x="130" y="512" font-size="72" fill="#909090" font-weight="700">01</text><text x="270" y="486" font-size="40" fill="#2E2E2E" font-weight="700">第 1 條的標題</text><text x="270" y="540" font-size="32" fill="#777777">一行補充說明</text><rect x="80" y="620" width="1082" height="180" fill="#EDEDED" stroke="#BFBFBF"/><text x="130" y="732" font-size="72" fill="#909090" font-weight="700">02</text><text x="270" y="706" font-size="40" fill="#2E2E2E" font-weight="700">第 2 條的標題</text><text x="270" y="760" font-size="32" fill="#777777">一行補充說明</text><rect x="80" y="840" width="1082" height="180" fill="#EDEDED" stroke="#BFBFBF"/><text x="130" y="952" font-size="72" fill="#909090" font-weight="700">03</text><text x="270" y="926" font-size="40" fill="#2E2E2E" font-weight="700">第 3 條的標題</text><text x="270" y="980" font-size="32" fill="#777777">一行補充說明</text><rect x="80" y="1060" width="1082" height="180" fill="#EDEDED" stroke="#BFBFBF"/><text x="130" y="1172" font-size="72" fill="#909090" font-weight="700">04</text><text x="270" y="1146" font-size="40" fill="#2E2E2E" font-weight="700">第 4 條的標題</text><text x="270" y="1200" font-size="32" fill="#777777">一行補充說明</text><rect x="80" y="1280" width="1082" height="180" fill="#EDEDED" stroke="#BFBFBF"/><text x="130" y="1392" font-size="72" fill="#909090" font-weight="700">05</text><text x="270" y="1366" font-size="40" fill="#2E2E2E" font-weight="700">第 5 條的標題</text><text x="270" y="1420" font-size="32" fill="#777777">一行補充說明</text><text x="80" y="1600" font-size="32" fill="#A0A0A0">帳號或出處</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 12 字 | 1 |
| 副標 | `label` | 說明這篇在講什麼 | 20 字 | 1 |
| 橫條 ×N | `node`（`field`） | 等高 | — | — |
| 編號 | `label` | 大號、淡色 | 2 字 | 1 |
| 條目標題 | `label` | | 12 字 | 1 |
| 補充 | `label` | 一行 | 16 字 | 1 |
| 帳號出處 | `label` | | 14 字 | 1 |

## 節奏

橫條等高等間距，五條是甜蜜點。**編號用大號淡色**，它是節奏標記不是重點。左右邊界比 16:9 更窄（畫面本來就窄）。

`blueprint.shape` 寫 `vertical-list`。

## 怎麼設定畫布

```
co-motion presentation canvas set <presentation-id> --width 1242 --height 1660
```

畫布要在建第一頁**之前**設定。非 16:9 的畫布**不要用 `k = width ÷ 1280` 換算字級**——那個規則只在同比例時成立。直式與方形的字級直接照上面的槽位表。

## 變體

- **加圖**：每條左側放一個小方圖。
- **兩欄**：條目多時分兩欄，但只在 3:4 成立，9:16 太窄。
