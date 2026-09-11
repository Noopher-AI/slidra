# 37 · bokeh-orbs

**氣氛**：大小不一的光圈散布在右半，像失焦的夜景。柔、有深度、有隨機感。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.7

**做法**：每個光圈是一個極淡的填色圓加一圈描邊；右上疊一層徑向漸層當光源。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<radialGradient id="bk" cx="0.88" cy="0.28" r="0.85"><stop offset="0" stop-color="<primary>" stop-opacity="0.24"/><stop offset="1" stop-color="<primary>" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<rect width="1280" height="720" fill="url(#bk)"/><circle cx="663" cy="493" r="71" fill="<accent>" opacity="0.055"/><circle cx="663" cy="493" r="71" fill="none" stroke="<accent>" stroke-width="1.2" opacity="0.2"/><circle cx="679" cy="97" r="43" fill="<primary>" opacity="0.056"/><circle cx="679" cy="97" r="43" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.27"/><circle cx="790" cy="-7" r="40" fill="<primary>" opacity="0.055"/><circle cx="790" cy="-7" r="40" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.17"/><circle cx="1202" cy="720" r="75" fill="<primary>" opacity="0.103"/><circle cx="1202" cy="720" r="75" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.23"/><circle cx="1039" cy="717" r="37" fill="<accent>" opacity="0.098"/><circle cx="1039" cy="717" r="37" fill="none" stroke="<accent>" stroke-width="1.2" opacity="0.25"/><circle cx="768" cy="577" r="82" fill="<primary>" opacity="0.074"/><circle cx="768" cy="577" r="82" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.21"/><circle cx="797" cy="577" r="57" fill="<primary>" opacity="0.081"/><circle cx="797" cy="577" r="57" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.37"/><circle cx="689" cy="587" r="83" fill="<primary>" opacity="0.064"/><circle cx="689" cy="587" r="83" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.18"/><circle cx="822" cy="458" r="58" fill="<accent>" opacity="0.07"/><circle cx="822" cy="458" r="58" fill="none" stroke="<accent>" stroke-width="1.2" opacity="0.24"/><circle cx="956" cy="166" r="35" fill="<primary>" opacity="0.104"/><circle cx="956" cy="166" r="35" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.38"/><circle cx="874" cy="562" r="23" fill="<primary>" opacity="0.062"/><circle cx="874" cy="562" r="23" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.2"/><circle cx="663" cy="277" r="32" fill="<primary>" opacity="0.101"/><circle cx="663" cy="277" r="32" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.34"/><circle cx="666" cy="426" r="56" fill="<accent>" opacity="0.063"/><circle cx="666" cy="426" r="56" fill="none" stroke="<accent>" stroke-width="1.2" opacity="0.27"/><circle cx="1152" cy="22" r="47" fill="<primary>" opacity="0.064"/><circle cx="1152" cy="22" r="47" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.33"/><circle cx="1136" cy="187" r="38" fill="<primary>" opacity="0.105"/><circle cx="1136" cy="187" r="38" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.34"/><circle cx="1172" cy="-0" r="49" fill="<primary>" opacity="0.052"/><circle cx="1172" cy="-0" r="49" fill="none" stroke="<primary>" stroke-width="1.2" opacity="0.32"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted`、`<accent>` → `text` |
| `warm` | 全部收斂到暖色：主色與第三色都改用 accent。整張圖只剩一個色相的深淺，最熱。 | `<primary>` → `accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：01、15、20、23。
