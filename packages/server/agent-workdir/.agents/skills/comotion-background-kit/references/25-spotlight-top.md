# 25 · spotlight-top

**氣氛**：從頂端中央打下來的一束光，往下逐漸散開。舞台感，注意力自然往上。

**適合**：`anchor`（封面）、`breathing`。
**不適合**：`dense`。上亮下暗會讓後排的卡片看起來比較不重要。

**建議 opacity**：0.7

**做法**：一個上寬下窄的梯形 path 填線性漸層，由上往下淡出。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs>
<linearGradient id="sp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="<primary>" stop-opacity="0.4"/><stop offset="0.55" stop-color="<primary>" stop-opacity="0.1"/><stop offset="1" stop-color="<primary>" stop-opacity="0"/></linearGradient><radialGradient id="spg" cx="0.5" cy="0" r="0.8"><stop offset="0" stop-color="<accent>" stop-opacity="0.2"/><stop offset="1" stop-color="<accent>" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1280" height="720" fill="<background>"/>
<path d="M380 0H900L1180 720H100Z" fill="url(#sp)"/><rect width="1280" height="720" fill="url(#spg)"/>
</svg>
```

## 另外兩種色系

同一張圖換一組角色去填，就是另一個色系——顏色仍然全部來自這份簡報自己的配色，所以不會跟風格打架。寫入資產時把 `<role>` 換成**對應後**的角色色碼即可，SVG 本身完全不用改。

| 色系 | 效果 | 角色對應 |
|---|---|---|
| `base` | 原樣，下面 SVG 直接用 | — |
| `duotone` | 只留兩色：除了底色之外全部收斂成主色的深淺。最安靜的處理。 | `<accent>` → `primary` |
| `low-key` | 降一階：主色退成 muted，accent 升為主角。圖樣退到更後面，適合內容已經很滿的頁面。 | `<primary>` → `muted`、`<accent>` → `primary` |

一份簡報**最多用兩種色系**（通常是 `base` 給內容頁、另一種給定錨頁）；三種以上會讓整份看起來像拼貼。資產名字帶上色系，例如 `bg-<配方>-<配色代號>-accent-led.svg`。

**建議風格**：07、15、19、20。
