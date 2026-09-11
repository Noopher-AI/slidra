# 55 · square-kpi

**畫布**：1080×1080（1:1）　**這不是 16:9 的版面**
**解的關係**：`none`
**單位數**：1
**一句話**：方形數字：一個大數字置中，上有標題下有補充——單張分享的數據卡。

**什麼時候用它**：一個值得被單獨轉發的數字。
**什麼時候不要用**：多個指標——方形放不下，改用 `26 kpi-row` 的橫式。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080">
<rect x="0" y="0" width="1080" height="1080" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="90" y="180" font-size="44" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="90" y="208" width="88" height="7" fill="#909090"/><text x="540" y="520" font-size="180" fill="#2E2E2E" font-weight="700" text-anchor="middle">25 億</text><text x="540" y="620" font-size="40" fill="#777777" text-anchor="middle">這個數字代表什麼</text><rect x="90" y="720" width="900" height="4" fill="#E4E4E4"/><text x="90" y="820" font-size="32" fill="#777777">・補充一</text><text x="90" y="890" font-size="32" fill="#777777">・補充二</text><text x="90" y="1010" font-size="28" fill="#A0A0A0">資料來源</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 12 字 | 1 |
| 大數字 | `label` | 置中，字要極大 | 6 字 | 1 |
| 說明 | `label` | | 16 字 | 1 |
| 補充 ×2 | `label` | 可省 | 12 字 | 1 |
| 來源 | `label` | | 14 字 | 1 |

## 節奏

數字置中、佔畫面高度約 20%。**數字只能來自作者**。上下留白對稱。

`blueprint.shape` 寫 `square-kpi`。

## 怎麼設定畫布

```
co-motion presentation canvas set <presentation-id> --width 1080 --height 1080
```

畫布要在建第一頁**之前**設定。非 16:9 的畫布**不要用 `k = width ÷ 1280` 換算字級**——那個規則只在同比例時成立。直式與方形的字級直接照上面的槽位表。

## 變體

- **加變化量**：數字右上角一個小的 ↑↓ 與百分比。
- **深色底**：整張反白，在動態牆上更跳。
