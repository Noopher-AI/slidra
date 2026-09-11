# 05 · banded-list

**解的關係**：`membership`
**單位數**：3–5
**一句話**：單欄橫條，靠底色深淺交替分層——像表格的斑馬紋，但沒有格線。

**什麼時候用它**：條目多、每條都短，而且彼此地位相等。
**什麼時候不要用**：條目只有兩三個——交替的底色需要足夠的列數才看得出規律。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="176" width="1120" height="110" fill="#EDEDED"/><text x="120" y="246" font-size="24" fill="#777777">第 1 條，交替底色分層</text><rect x="80" y="286" width="1120" height="110" fill="#F7F7F7"/><text x="120" y="356" font-size="24" fill="#777777">第 2 條，交替底色分層</text><rect x="80" y="396" width="1120" height="110" fill="#EDEDED"/><text x="120" y="466" font-size="24" fill="#777777">第 3 條，交替底色分層</text><rect x="80" y="506" width="1120" height="110" fill="#F7F7F7"/><text x="120" y="576" font-size="24" fill="#777777">第 4 條，交替底色分層</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 橫條 ×N | `node`（內含 `field`） | 交替兩種底色 | — | — |
| 關鍵詞 | `label` | | 24 字 | 1 |

## 節奏

橫條之間**沒有間距**（靠底色分，不靠留白分）。這是它跟 `card-wall` 最大的差別，也是它能放更多條的原因。

`blueprint.shape` 寫 `banded-list`。

## 變體

- **右對齊數值**：每條右側放一個數字，變成輕量的資料表。
- **首條加重**：第一條用 `primary` 底色，當作重點。
