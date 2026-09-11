# 22 · wave-band

**氣氛**：畫面下緣一道起伏的波形帶，像水面或聲波。柔軟、有流動感，而且只佔底部。

**適合**：`anchor`、`breathing`。內容區完全不受影響。
**不適合**：`dense` 且內容延伸到底部時。

**建議 opacity**：0.7

**做法**：兩條錯開的波形 path 填滿下緣，後面那條較淡。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<path d="M0 600 C 200 550, 340 650, 560 600 S 940 520, 1280 580 V720 H0Z" fill="<primary>" opacity="0.18"/>
<path d="M0 650 C 240 610, 420 700, 660 650 S 1020 590, 1280 640 V720 H0Z" fill="<secondary_accent>" opacity="0.25"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `mono-ink` | 去彩度：全部改用文字色與 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted`、`<secondary_accent>` → `muted` |
| `verdant` | 改用第三色領頭。多數配色的 secondary_accent 是另一個色系，整張圖的色溫會整個換掉。 | `<primary>` → `secondary_accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：10、12、23、08。
