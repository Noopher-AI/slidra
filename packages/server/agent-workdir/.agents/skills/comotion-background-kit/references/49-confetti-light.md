# 49 · confetti-light

**氣氛**：一叢小色片落在右上角，明亮、輕快、有動勢。

**明亮風格**：這是為淺底配色畫的。深色配色（01、04、07、10、13、15、18、20）用它會太弱，要把透明度整組拉高一倍以上，或直接換一個深色系的配方。

**適合**：`anchor`（封面、結語）、`breathing`。
**不適合**：`dense`。色片夠亮，會跟內容搶。

**建議 opacity**：1.0

**做法**：**集中成一叢**，不要滿版撒。第一版撒滿整頁，在淺底上看起來像灰塵而不是裝飾。位置用高斯分布往右上角收，透明度 0.45–0.9。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<rect x="1178" y="158" width="46" height="10" rx="5" fill="<primary>" opacity="0.7" transform="rotate(86 1178 158)"/><rect x="1021" y="268" width="34" height="17" rx="8" fill="<accent>" opacity="0.88" transform="rotate(5 1021 268)"/><rect x="1142" y="263" width="46" height="11" rx="5" fill="<accent>" opacity="0.49" transform="rotate(58 1142 263)"/><rect x="1081" y="34" width="23" height="10" rx="5" fill="<primary>" opacity="0.7" transform="rotate(36 1081 34)"/><rect x="1246" y="92" width="46" height="18" rx="9" fill="<accent>" opacity="0.78" transform="rotate(133 1246 92)"/><rect x="1004" y="150" width="19" height="16" rx="8" fill="<accent>" opacity="0.5" transform="rotate(97 1004 150)"/><rect x="1216" y="300" width="20" height="17" rx="9" fill="<primary>" opacity="0.83" transform="rotate(10 1216 300)"/><rect x="1275" y="580" width="35" height="11" rx="5" fill="<accent>" opacity="0.78" transform="rotate(85 1275 580)"/><rect x="736" y="387" width="17" height="13" rx="7" fill="<accent>" opacity="0.61" transform="rotate(7 736 387)"/><rect x="635" y="472" width="49" height="15" rx="8" fill="<primary>" opacity="0.66" transform="rotate(10 635 472)"/><rect x="1071" y="114" width="19" height="17" rx="8" fill="<accent>" opacity="0.87" transform="rotate(165 1071 114)"/><rect x="1184" y="39" width="33" height="16" rx="8" fill="<accent>" opacity="0.46" transform="rotate(136 1184 39)"/><rect x="700" y="287" width="20" height="13" rx="6" fill="<primary>" opacity="0.85" transform="rotate(86 700 287)"/><rect x="1243" y="412" width="19" height="10" rx="5" fill="<accent>" opacity="0.88" transform="rotate(5 1243 412)"/><rect x="987" y="2" width="51" height="15" rx="8" fill="<accent>" opacity="0.67" transform="rotate(108 987 2)"/><rect x="1206" y="95" width="38" height="12" rx="6" fill="<primary>" opacity="0.65" transform="rotate(50 1206 95)"/><rect x="1184" y="50" width="17" height="10" rx="5" fill="<accent>" opacity="0.85" transform="rotate(16 1184 50)"/><rect x="1054" y="376" width="22" height="18" rx="9" fill="<accent>" opacity="0.66" transform="rotate(69 1054 376)"/><rect x="1107" y="386" width="23" height="16" rx="8" fill="<primary>" opacity="0.56" transform="rotate(77 1107 386)"/><rect x="869" y="342" width="28" height="17" rx="9" fill="<accent>" opacity="0.89" transform="rotate(140 869 342)"/><rect x="938" y="0" width="43" height="16" rx="8" fill="<accent>" opacity="0.68" transform="rotate(94 938 0)"/><rect x="1082" y="172" width="43" height="14" rx="7" fill="<primary>" opacity="0.59" transform="rotate(127 1082 172)"/><rect x="1204" y="120" width="29" height="16" rx="8" fill="<accent>" opacity="0.86" transform="rotate(9 1204 120)"/><rect x="862" y="135" width="18" height="9" rx="5" fill="<accent>" opacity="0.71" transform="rotate(130 862 135)"/><rect x="1174" y="171" width="22" height="18" rx="9" fill="<primary>" opacity="0.68" transform="rotate(11 1174 171)"/><rect x="1157" y="28" width="41" height="10" rx="5" fill="<accent>" opacity="0.73" transform="rotate(82 1157 28)"/><rect x="803" y="116" width="21" height="13" rx="6" fill="<accent>" opacity="0.83" transform="rotate(177 803 116)"/><rect x="1204" y="2" width="44" height="9" rx="5" fill="<primary>" opacity="0.81" transform="rotate(141 1204 2)"/><rect x="888" y="132" width="46" height="14" rx="7" fill="<accent>" opacity="0.48" transform="rotate(120 888 132)"/><rect x="983" y="14" width="42" height="11" rx="5" fill="<accent>" opacity="0.69" transform="rotate(87 983 14)"/><rect x="1132" y="242" width="23" height="14" rx="7" fill="<primary>" opacity="0.62" transform="rotate(169 1132 242)"/><rect x="1094" y="55" width="41" height="11" rx="5" fill="<accent>" opacity="0.9" transform="rotate(110 1094 55)"/><rect x="1146" y="191" width="39" height="11" rx="5" fill="<accent>" opacity="0.8" transform="rotate(90 1146 191)"/><rect x="1149" y="136" width="22" height="15" rx="8" fill="<primary>" opacity="0.69" transform="rotate(150 1149 136)"/><rect x="1208" y="168" width="50" height="13" rx="7" fill="<accent>" opacity="0.58" transform="rotate(123 1208 168)"/><rect x="1029" y="12" width="31" height="14" rx="7" fill="<accent>" opacity="0.76" transform="rotate(111 1029 12)"/><rect x="1133" y="346" width="45" height="14" rx="7" fill="<primary>" opacity="0.86" transform="rotate(85 1133 346)"/><rect x="825" y="317" width="31" height="16" rx="8" fill="<accent>" opacity="0.72" transform="rotate(4 825 317)"/><rect x="718" y="183" width="41" height="9" rx="5" fill="<accent>" opacity="0.6" transform="rotate(14 718 183)"/><rect x="1057" y="270" width="47" height="12" rx="6" fill="<primary>" opacity="0.65" transform="rotate(26 1057 270)"/><rect x="1103" y="241" width="27" height="12" rx="6" fill="<accent>" opacity="0.86" transform="rotate(17 1103 241)"/><rect x="1235" y="143" width="31" height="9" rx="5" fill="<accent>" opacity="0.68" transform="rotate(106 1235 143)"/><rect x="1149" y="326" width="17" height="17" rx="9" fill="<primary>" opacity="0.72" transform="rotate(87 1149 326)"/><rect x="1207" y="8" width="42" height="13" rx="7" fill="<accent>" opacity="0.69" transform="rotate(50 1207 8)"/>
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

**建議風格**：08、11、19、22、23、25。
