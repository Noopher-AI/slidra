# 34 · stacked-peaks

**氣氛**：三層山稜線由高到低疊起。有地形感、有遠近，而且天然把視線帶到上方。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.75

**做法**：三條折線 path，愈前面的愈實；峰的高度刻意不規則。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="p1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.28"/><stop offset="1" stop-color="<primary>" stop-opacity="0.1"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M0 560L220 400L380 500L560 330L760 470L940 360L1120 470L1280 400V720H0Z" fill="url(#p1)"/><path d="M0 640L200 520L400 600L600 470L820 580L1020 500L1280 590V720H0Z" fill="<secondary_bg>" opacity="0.9"/><path d="M0 690L260 620L520 680L780 610L1040 670L1280 630V720H0Z" fill="<primary>" opacity="0.18"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：10、12、24。
