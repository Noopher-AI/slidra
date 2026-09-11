# 19 · dashed-path

**氣氛**：一條虛線從左下彎到右上，像地圖上的路徑或流程的軌跡。有起點、有終點、有方向。

**適合**：`order` 關係的頁面（它會強化 `spine-path` 的方向）。
**不適合**：`membership`。

**建議 opacity**：0.6

**做法**：一條 `stroke-dasharray` 的曲線，兩端各一個小圓標出起點與終點。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<path d="M60 660 C 360 620, 420 300, 700 320 S 1060 240, 1230 90" fill="none" stroke="<primary>" stroke-width="3" stroke-dasharray="14 12" opacity="0.45"/>
<circle cx="60" cy="660" r="10" fill="<primary>" opacity="0.5"/>
<circle cx="1230" cy="90" r="14" fill="<accent>" opacity="0.6"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `duotone` | 只留兩色：除了底色之外全部收斂成主色的深淺。最安靜的處理。 | `<accent>` → `primary` |
| `warm` | 全部收斂到暖色：主色與第三色都改用 accent。整張圖只剩一個色相的深淺，最熱。 | `<primary>` → `accent` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：05、10、12、23。
