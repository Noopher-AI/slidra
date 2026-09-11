# 19 · hero-number

**解的關係**：`none`
**單位數**：1
**一句話**：一個很大的數字置中，下面一句說明——整頁只講一件事。

**什麼時候用它**：有一個真實、來自作者的數字，而且它本身就是主張。
**什麼時候不要用**：沒有數字，或數字需要上下文才有意義（那要先鋪陳）。**絕不編造數字**。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="640" y="400" font-size="140" fill="#2E2E2E" font-weight="700" text-anchor="middle">25 億</text><text x="640" y="480" font-size="28" fill="#777777" text-anchor="middle">這個數字代表什麼</text><text x="640" y="600" font-size="18" fill="#A0A0A0" text-anchor="middle">來源（可省）</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 大數字 | `label`（`number` 字級） | 只能來自作者的大綱 | 8 字 | 1 |
| 說明 | `label` | 這個數字代表什麼 | 24 字 | 1–2 |
| 來源 | `label` | 可省 | 20 字 | 1 |

## 節奏

**不放標題**——數字本身就是標題。全部置中，垂直重心略高於畫布中央（視覺中心比幾何中心高）。沒有數字、只有一句主張時，改用 `claim` 字級。

`blueprint.shape` 寫 `hero-number`。

## 變體

- **左右分**：數字在左、說明在右，適合數字很長時。
- **兩個數字**：並排兩個，中間一條分隔——但那其實是 `contrast`，考慮換版面。
