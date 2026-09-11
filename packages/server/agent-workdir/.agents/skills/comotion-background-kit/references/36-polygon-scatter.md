# 36 · polygon-scatter

**氣氛**：七個大小不一的多邊形散在右半，只有描邊沒有實心。幾何、克制、有呼吸。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.65

**做法**：三角形與六角形交錯，位置手動指定而不是隨機——隨機會擠成一團。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<polygon points="826,86 756,194 698,80" fill="<primary>" opacity="0.06"/><polygon points="826,86 756,194 698,80" fill="none" stroke="<primary>" stroke-width="2" opacity="0.5"/><polygon points="1101,219 1082,313 991,344 919,281 938,187 1029,156" fill="<accent>" opacity="0.06"/><polygon points="1101,219 1082,313 991,344 919,281 938,187 1029,156" fill="none" stroke="<accent>" stroke-width="2" opacity="0.5"/><polygon points="1258,71 1220,171 1152,88" fill="<primary>" opacity="0.06"/><polygon points="1258,71 1220,171 1152,88" fill="none" stroke="<primary>" stroke-width="2" opacity="0.5"/><polygon points="995,525 900,580 805,525 805,415 900,360 995,415" fill="<primary>" opacity="0.06"/><polygon points="995,525 900,580 805,525 805,415 900,360 995,415" fill="none" stroke="<primary>" stroke-width="2" opacity="0.5"/><polygon points="1093,516 1231,524 1156,640" fill="<primary>" opacity="0.06"/><polygon points="1093,516 1231,524 1156,640" fill="none" stroke="<primary>" stroke-width="2" opacity="0.5"/><polygon points="641,651 644,585 703,554 759,589 756,655 697,686" fill="<accent>" opacity="0.06"/><polygon points="641,651 644,585 703,554 759,589 756,655 697,686" fill="none" stroke="<accent>" stroke-width="2" opacity="0.5"/><polygon points="1193,369 1288,336 1269,435" fill="<primary>" opacity="0.06"/><polygon points="1193,369 1288,336 1269,435" fill="none" stroke="<primary>" stroke-width="2" opacity="0.5"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted`、`<accent>` → `text` |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent`、`<accent>` → `primary` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：01、04、13、25。
