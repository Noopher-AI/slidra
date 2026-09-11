# 32 · blob-corners

**氣氛**：左上與右下各一團有機形狀，中間留出一條乾淨的斜向通道。有機、不對稱、但很平衡。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。有機形的邊緣會跟卡片的直角打架。

**建議 opacity**：0.85

**做法**：兩個自由 path，各自填一個雙色線性漸層；刻意讓左上那團延伸到畫布外。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="b1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.5"/><stop offset="1" stop-color="<secondary_accent>" stop-opacity="0.22"/></linearGradient><linearGradient id="b2" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="<accent>" stop-opacity="0.4"/><stop offset="1" stop-color="<primary>" stop-opacity="0.14"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M-40 -40h620c40 120-60 180-150 250S180 420 60 380-120 200-40 -40z" fill="url(#b1)"/><path d="M1320 760h-560c-60-130 70-190 180-250s210-140 330-92 90 232 50 342z" fill="url(#b2)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted`、`<accent>` → `text`、`<secondary_accent>` → `muted` |
| `warm` | 全部收斂到暖色：主色與第三色都改用 accent。整張圖只剩一個色相的深淺，最熱。 | `<primary>` → `accent`、`<secondary_accent>` → `accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：02、08、11、16、23。
