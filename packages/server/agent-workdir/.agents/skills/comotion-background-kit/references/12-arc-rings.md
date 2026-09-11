# 12 · arc-rings

**氣氛**：右上角一組同心細環，像雷達或聲波的擴散。有中心、有外擴的動勢。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.6

**做法**：五個同心圓環，圓心在畫布外的右上角，半徑等差；最外圈最淡。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<g fill="none" stroke="<primary>">
<circle cx="1240" cy="-40" r="220" stroke-width="2" opacity="0.5"/>
<circle cx="1240" cy="-40" r="340" stroke-width="1.5" opacity="0.4"/>
<circle cx="1240" cy="-40" r="460" stroke-width="1.2" opacity="0.3"/>
<circle cx="1240" cy="-40" r="580" stroke-width="1" opacity="0.2"/>
<circle cx="1240" cy="-40" r="700" stroke-width="1" opacity="0.12"/>
</g>
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

**建議風格**：01、04、10、15、23。
