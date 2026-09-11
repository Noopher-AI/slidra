# 07 · edge-frame

**氣氛**：距離邊界一段距離的細框，像展場的畫框或證書的邊。正式、有儀式感。

**適合**：`anchor`。開場與結尾各用一次最有效。
**不適合**：`dense`。框會把已經很滿的頁面關起來。

**建議 opacity**：0.6

**做法**：兩個同心矩形細框，內框較淡；四個角各一小段加粗，模擬裱框的角件。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<rect x="40" y="40" width="1200" height="640" fill="none" stroke="<primary>" stroke-width="1.5" opacity="0.6"/>
<rect x="56" y="56" width="1168" height="608" fill="none" stroke="<primary>" stroke-width="0.75" opacity="0.3"/>
<path d="M40 80V40h40M1200 40h40v40M1240 640v40h-40M80 680H40v-40" fill="none" stroke="<accent>" stroke-width="3"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `warm` | 全部收斂到暖色：主色與第三色都改用 accent。整張圖只剩一個色相的深淺，最熱。 | `<primary>` → `accent` |
| `low-key` | 降一階：主色退成 muted，accent 升為主角。圖樣退到更後面，適合內容已經很滿的頁面。 | `<primary>` → `muted`、`<accent>` → `primary` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：14、18、20、21、24。
