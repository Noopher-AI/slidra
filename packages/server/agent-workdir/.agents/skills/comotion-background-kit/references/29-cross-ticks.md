# 29 · cross-ticks

**氣氛**：均勻分布的小十字標記，像設計稿的定位點或星圖。細緻、有精密感，比點陣多一點個性。

**適合**：任何節奏。
**不適合**：需要絕對乾淨的頁面。

**建議 opacity**：0.4

**做法**：一個 80px 的 pattern，中心一個 8px 的十字。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="tk" width="64" height="64" patternUnits="userSpaceOnUse"><path d="M32 22v20M22 32h20" stroke="<muted>" stroke-width="1.8" opacity="0.75"/></pattern>
<linearGradient id="calm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="<background>" stop-opacity="0.92"/><stop offset="0.42" stop-color="<background>" stop-opacity="0.62"/><stop offset="1" stop-color="<background>" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#tk)"/>
<rect width="1280" height="720" fill="url(#calm)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `tinted` | 把質地染上主色：中性的紋理變成有色的紋理，跟風格綁得更緊。 | `<muted>` → `primary` |
| `inked` | 把質地加深到文字色：顆粒與線條變明顯，整面更有印刷感。淺色風格上效果最好。 | `<muted>` → `text` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：04、06、13、25。
