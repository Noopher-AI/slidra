# 54 · square-quote

**畫布**：1080×1080（1:1）　**這不是 16:9 的版面**
**解的關係**：`none`
**單位數**：1
**一句話**：方形引用：一句話置中偏上，出處在下——最適合被轉發的單張。

**什麼時候用它**：一句有力的原話、金句卡、系列語錄。
**什麼時候不要用**：需要說明的內容。方形的空間放不下論證。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080">
<rect x="0" y="0" width="1080" height="1080" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="90" y="300" font-size="140" fill="#DDDDDD" font-weight="700">“</text><text x="140" y="400" font-size="60" fill="#2E2E2E">被引用的那一句話，</text><text x="140" y="500" font-size="60" fill="#2E2E2E">可以到第二行。</text><rect x="140" y="570" width="110" height="6" fill="#909090"/><text x="140" y="660" font-size="36" fill="#555555">受訪者・身分</text><line x1="90" y1="940" x2="990" y2="940" stroke="#D0D0D0" stroke-width="2"/><text x="90" y="1010" font-size="30" fill="#A0A0A0">帳號或出處</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 引號 | `garnish` | | — | — |
| 引文 | `label` | ≤ 2 行 | 每行 10 字 | 1–2 |
| 短線 | `garnish` | | — | — |
| 出處 | `label` | | 14 字 | 1 |
| 帳號 | `label` | 最下方 | 14 字 | 1 |

## 節奏

引文貼左緣、垂直置中偏上（視覺中心比幾何中心高）。方形的四邊留白要一致，否則會看起來歪。

`blueprint.shape` 寫 `square-quote`。

## 怎麼設定畫布

```
co-motion presentation canvas set <presentation-id> --width 1080 --height 1080
```

畫布要在建第一頁**之前**設定。非 16:9 的畫布**不要用 `k = width ÷ 1280` 換算字級**——那個規則只在同比例時成立。直式與方形的字級直接照上面的槽位表。

## 變體

- **置中版**：引文水平置中，更像海報。
- **配頭像**：左上一個圓形頭像。
