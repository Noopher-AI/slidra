# 54 · washi

**氣氛**：大塊極淡的色斑加上均勻的纖維點，像手抄和紙。

**明亮風格**：這是為淺底配色畫的。深色配色（01、04、07、10、13、15、18、20）用它會太弱，要把透明度整組拉高一倍以上，或直接換一個深色系的配方。

**適合**：任何節奏。
**不適合**：—

**建議 opacity**：0.55

**做法**：色斑 0.10、纖維點 0.28——兩層都比深色版濃一級。色斑只落在右側三分之二，左邊留給標題。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<pattern id="wf" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="0.9" fill="<primary>" opacity="0.28"/></pattern>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<ellipse cx="1119" cy="371" rx="218" ry="160" fill="<accent>" opacity="0.10"/><ellipse cx="1121" cy="61" rx="243" ry="177" fill="<primary>" opacity="0.10"/><ellipse cx="973" cy="147" rx="271" ry="221" fill="<primary>" opacity="0.10"/><ellipse cx="561" cy="656" rx="139" ry="100" fill="<accent>" opacity="0.10"/><ellipse cx="381" cy="163" rx="239" ry="187" fill="<primary>" opacity="0.10"/><ellipse cx="751" cy="199" rx="223" ry="151" fill="<primary>" opacity="0.10"/><ellipse cx="661" cy="307" rx="209" ry="135" fill="<accent>" opacity="0.10"/><ellipse cx="415" cy="363" rx="178" ry="146" fill="<primary>" opacity="0.10"/><ellipse cx="1198" cy="524" rx="186" ry="129" fill="<primary>" opacity="0.10"/><rect width="1280" height="720" fill="url(#wf)"/>
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

**建議風格**：02、05、09、14、16、24。
