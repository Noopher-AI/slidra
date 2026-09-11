# 42 · audio-quote

**解的關係**：`none`
**單位數**：1
**一句話**：一段引用佔版面中央，下方一條窄波形可以播出原音——文字先讀，聲音再驗證。

**什麼時候用它**：一句有力的原話，而且有錄音可以佐證。
**什麼時候不要用**：沒有錄音。只有文字的引用用 25 `quote-block`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="140" y="330" font-size="96" fill="#DDDDDD" font-weight="700">“</text><text x="220" y="372" font-size="44" fill="#2E2E2E">被引用的那一句話，</text><text x="220" y="444" font-size="44" fill="#2E2E2E">可以到第二行。</text><text x="220" y="500" font-size="24" fill="#555555">受訪者・身分</text><rect x="220" y="500" width="620" height="60" fill="#EDEDED" stroke="#BFBFBF"/><line x1="260" y1="500" x2="260" y2="560" stroke="#9A9A9A" stroke-width="5"/><line x1="290" y1="516" x2="290" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="320" y1="516" x2="320" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="350" y1="500" x2="350" y2="560" stroke="#9A9A9A" stroke-width="5"/><line x1="380" y1="516" x2="380" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="410" y1="516" x2="410" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="440" y1="500" x2="440" y2="560" stroke="#9A9A9A" stroke-width="5"/><line x1="470" y1="516" x2="470" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="500" y1="516" x2="500" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="530" y1="500" x2="530" y2="560" stroke="#9A9A9A" stroke-width="5"/><line x1="560" y1="516" x2="560" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="590" y1="516" x2="590" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="620" y1="500" x2="620" y2="560" stroke="#9A9A9A" stroke-width="5"/><line x1="650" y1="516" x2="650" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="680" y1="516" x2="680" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="710" y1="500" x2="710" y2="560" stroke="#9A9A9A" stroke-width="5"/><line x1="740" y1="516" x2="740" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="770" y1="516" x2="770" y2="544" stroke="#9A9A9A" stroke-width="5"/><line x1="800" y1="500" x2="800" y2="560" stroke="#9A9A9A" stroke-width="5"/><line x1="830" y1="516" x2="830" y2="544" stroke="#9A9A9A" stroke-width="5"/><ellipse cx="900" cy="530" rx="24" ry="24" fill="#FFFFFF" stroke="#909090" stroke-width="3"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 引號 | `garnish` | 裸 `<text>` | — | — |
| 引文 | `label`（`title`～`claim`） | **必須與錄音一字不差** | 每行 18 字，≤ 2 行 | 1–2 |
| 出處 | `label`（`caption`） | | 18 字 | 1 |
| 波形條 | `node`（`audio`） | 窄，放在引文下方 | — | — |

## 節奏

波形條的寬度比引文窄——它是佐證，不是主角。**引文必須逐字等於錄音內容**，修飾過的引用配上原音會當場穿幫。

`blueprint.shape` 寫 `audio-quote`。

## 變體

- **多段引用**：兩段引用上下排，各配一條窄波形。
- **無波形**：只在角落放一個小的播放圖示，更安靜。
