# 47 · pastel-fields

**氣氛**：幾塊帶斜切邊的淡色域在右側相鄰，像疊起來的色紙。

**明亮風格**：這是為淺底配色畫的。深色配色（01、04、07、10、13、15、18、20）用它會太弱，要把透明度整組拉高一倍以上，或直接換一個深色系的配方。

**適合**：`anchor`、`breathing`，以及 `contrast` 關係的頁面（切邊本身就是分界）。
**不適合**：`dense`。色塊有邊界，會跟卡片的邊界互相干擾。

**建議 opacity**：0.75

**做法**：色域一定要有**邊界**。第一版畫成互相疊糊的雲，在淺底上全部混成一塊灰褐色；改成帶斜切邊的多邊形之後才站得住。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="pfa" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="<accent>" stop-opacity="0.34"/><stop offset="1" stop-color="<accent>" stop-opacity="0.1"/></linearGradient><linearGradient id="pfb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.22"/><stop offset="1" stop-color="<primary>" stop-opacity="0.05"/></linearGradient><linearGradient id="pfc" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<secondary_bg>" stop-opacity="1"/><stop offset="1" stop-color="<secondary_bg>" stop-opacity="0.3"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M760 0H1280V720H980Z" fill="url(#pfc)"/><path d="M900 0H1280V430L1010 720H700Z" fill="url(#pfa)"/><path d="M1120 0H1280V280Z" fill="url(#pfb)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `accent-led` | 主客對調：原本用主色的地方改用 accent。同一張圖會從沉穩變成明亮，適合需要熱度的頁面。 | `<primary>` → `accent` |
| `tinted` | 底色上場：大面積改用 `secondary_bg` 這個中性色，只留最前面的一層有彩度。 | `<primary>` → `secondary_bg` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：02、05、08、11、16、22。
