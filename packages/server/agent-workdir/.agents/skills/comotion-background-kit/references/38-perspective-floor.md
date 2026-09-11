# 38 · perspective-floor

**氣氛**：地平線上的透視格線，往右方的消失點收斂。有空間、有縱深，而且自帶方向。

**適合**：`anchor`、`breathing`，以及 `order` 關係的頁面。
**不適合**：`membership`。透視有方向，並列的內容不該有。

**建議 opacity**：0.6

**做法**：放射線全部指向同一個消失點；橫線間距以等比遞減模擬透視。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="pf" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="<primary>" stop-opacity="0.16"/><stop offset="1" stop-color="<primary>" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<line x1="-660" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-550" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-440" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-330" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-220" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="-110" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="0" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="110" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="220" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="330" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="440" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="550" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="660" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="770" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="880" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="990" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1100" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1210" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1320" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1430" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1540" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1650" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1760" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1870" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="1980" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="2090" y1="720" x2="980" y2="300" stroke="<primary>" stroke-width="1" opacity="0.22"/><line x1="0" y1="720" x2="1280" y2="720" stroke="<primary>" stroke-width="1" opacity="0.26"/><line x1="0" y1="709" x2="1280" y2="709" stroke="<primary>" stroke-width="1" opacity="0.25"/><line x1="0" y1="695" x2="1280" y2="695" stroke="<primary>" stroke-width="1" opacity="0.25"/><line x1="0" y1="676" x2="1280" y2="676" stroke="<primary>" stroke-width="1" opacity="0.24"/><line x1="0" y1="650" x2="1280" y2="650" stroke="<primary>" stroke-width="1" opacity="0.23"/><line x1="0" y1="615" x2="1280" y2="615" stroke="<primary>" stroke-width="1" opacity="0.21"/><line x1="0" y1="569" x2="1280" y2="569" stroke="<primary>" stroke-width="1" opacity="0.19"/><line x1="0" y1="507" x2="1280" y2="507" stroke="<primary>" stroke-width="1" opacity="0.16"/><line x1="0" y1="424" x2="1280" y2="424" stroke="<primary>" stroke-width="1" opacity="0.12"/><rect y="300" width="1280" height="420" fill="url(#pf)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：01、04、13、15。
