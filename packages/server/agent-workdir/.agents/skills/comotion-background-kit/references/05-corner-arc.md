# 05 · corner-arc

**氣氛**：右下角一道大圓弧切進畫面，像一枚被放大的印記。安靜但有存在感。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。圓弧會跟卡片邊界打架。

**建議 opacity**：0.7

**做法**：一個超出畫布的大圓，只露出左上那一段弧；描邊而非填色，所以它是「線」不是「塊」。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<circle cx="1180" cy="640" r="420" fill="none" stroke="<primary>" stroke-width="2" opacity="0.5"/>
<circle cx="1180" cy="640" r="300" fill="none" stroke="<primary>" stroke-width="1" opacity="0.35"/>
<circle cx="1180" cy="640" r="180" fill="<primary>" opacity="0.08"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent` |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：01、06、13、20、23。
