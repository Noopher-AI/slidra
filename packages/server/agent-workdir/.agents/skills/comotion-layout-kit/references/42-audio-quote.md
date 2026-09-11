# 42 · audio-quote

**解的關係**：`none`
**單位數**：1
**一句話**：一段引用佔版面中央，下方一條窄波形可以播出原音——文字先讀，聲音再驗證。

**什麼時候用它**：一句有力的原話，而且有錄音可以佐證。
**什麼時候不要用**：沒有錄音。只有文字的引用用 25 `quote-block`。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<text x="140" y="240" font-size="64" fill="#DDDDDD">&#8220;</text>
<text x="200" y="330" font-size="34" fill="#333333">被引用的那一句話，</text>
<text x="200" y="385" font-size="34" fill="#333333">可以到第二行。</text>
<text x="200" y="450" font-size="17" fill="#777777">受訪者・身分</text>
<rect x="200" y="500" width="700" height="56" fill="#F2F2F2" stroke="#CCCCCC"/>
<g stroke="#999999" stroke-width="2">
<line x1="230" y1="518" x2="230" y2="538"/><line x1="250" y1="510" x2="250" y2="546"/>
<line x1="270" y1="522" x2="270" y2="534"/><line x1="290" y1="506" x2="290" y2="550"/>
</g>
<ellipse cx="860" cy="528" rx="18" ry="18" fill="#FFFFFF" stroke="#666666" stroke-width="2"/>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
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
