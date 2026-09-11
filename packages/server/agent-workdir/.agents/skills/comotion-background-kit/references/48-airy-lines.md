# 48 · airy-lines

**氣氛**：極細的水平線由密到疏往下排開，像信紙，右緣收在一道色帶裡。

**明亮風格**：這是為淺底配色畫的。深色配色（01、04、07、10、13、15、18、20）用它會太弱，要把透明度整組拉高一倍以上，或直接換一個深色系的配方。

**適合**：`dense`（內容頁）、`order` 關係的頁面。
**不適合**：`breathing`。線會把留白切碎。

**建議 opacity**：0.6

**做法**：間距等比遞增（×1.12），透明度同步遞減，所以視線自然往上收。線在淺底上要 1.4px／0.10–0.45 才看得見——深色版那種 0.05 在這裡等於沒畫。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<line x1="0" y1="110" x2="1280" y2="110" stroke="<primary>" stroke-width="1.4" opacity="0.45"/><line x1="0" y1="125" x2="1280" y2="125" stroke="<primary>" stroke-width="1.4" opacity="0.442"/><line x1="0" y1="141" x2="1280" y2="141" stroke="<primary>" stroke-width="1.4" opacity="0.434"/><line x1="0" y1="159" x2="1280" y2="159" stroke="<primary>" stroke-width="1.4" opacity="0.424"/><line x1="0" y1="180" x2="1280" y2="180" stroke="<primary>" stroke-width="1.4" opacity="0.413"/><line x1="0" y1="202" x2="1280" y2="202" stroke="<primary>" stroke-width="1.4" opacity="0.401"/><line x1="0" y1="228" x2="1280" y2="228" stroke="<primary>" stroke-width="1.4" opacity="0.387"/><line x1="0" y1="257" x2="1280" y2="257" stroke="<primary>" stroke-width="1.4" opacity="0.372"/><line x1="0" y1="289" x2="1280" y2="289" stroke="<primary>" stroke-width="1.4" opacity="0.355"/><line x1="0" y1="325" x2="1280" y2="325" stroke="<primary>" stroke-width="1.4" opacity="0.336"/><line x1="0" y1="366" x2="1280" y2="366" stroke="<primary>" stroke-width="1.4" opacity="0.314"/><line x1="0" y1="411" x2="1280" y2="411" stroke="<primary>" stroke-width="1.4" opacity="0.29"/><line x1="0" y1="461" x2="1280" y2="461" stroke="<primary>" stroke-width="1.4" opacity="0.263"/><line x1="0" y1="518" x2="1280" y2="518" stroke="<primary>" stroke-width="1.4" opacity="0.233"/><line x1="0" y1="582" x2="1280" y2="582" stroke="<primary>" stroke-width="1.4" opacity="0.199"/><line x1="0" y1="653" x2="1280" y2="653" stroke="<primary>" stroke-width="1.4" opacity="0.162"/><rect x="1150" y="0" width="130" height="720" fill="<accent>" opacity="0.16"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |
| `mono-ink` | 去彩度：全部改用 muted。最克制的處理，幾乎只剩明暗，適合資料頁與克制的風格。 | `<primary>` → `muted`；`<accent>` → `muted` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：03、06、09、14、17、21、25。
