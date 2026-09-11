# 40 · chevron-stack

**氣氛**：下半部一疊之字形，愈往下愈實。有節奏、有前進感，但完全不碰上半的文字區。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.6

**做法**：六條粗折線，只佔畫面下半；上半完全留白。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<polyline points="-160,326 0,274 160,326 320,274 480,326 640,274 800,326 960,274 1120,326 1280,274 1440,326" fill="none" stroke="<primary>" stroke-width="12" opacity="0.07"/><polyline points="-160,414 0,362 160,414 320,362 480,414 640,362 800,414 960,362 1120,414 1280,362 1440,414" fill="none" stroke="<primary>" stroke-width="12" opacity="0.115"/><polyline points="-160,502 0,450 160,502 320,450 480,502 640,450 800,502 960,450 1120,502 1280,450 1440,502" fill="none" stroke="<primary>" stroke-width="12" opacity="0.16"/><polyline points="-160,590 0,538 160,590 320,538 480,590 640,538 800,590 960,538 1120,590 1280,538 1440,590" fill="none" stroke="<primary>" stroke-width="12" opacity="0.205"/><polyline points="-160,678 0,626 160,678 320,626 480,678 640,626 800,678 960,626 1120,678 1280,626 1440,678" fill="none" stroke="<primary>" stroke-width="12" opacity="0.25"/><polyline points="-160,766 0,714 160,766 320,714 480,766 640,714 800,766 960,714 1120,766 1280,714 1440,766" fill="none" stroke="<primary>" stroke-width="12" opacity="0.295"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted` |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：07、11、15、22。
