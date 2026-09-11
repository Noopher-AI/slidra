# 25 · quote-block

**解的關係**：`none`
**單位數**：1
**一句話**：一段引用佔據版面，出處在下方——把別人的話當成這一頁的全部。

**什麼時候用它**：客戶的原話、使用者回饋、權威的判斷。**引用必須是真實的**。
**什麼時候不要用**：自己的主張。把自己的話排成引用會顯得矯情。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="140" y="280" font-size="96" fill="#DDDDDD" font-weight="700">“</text><text x="210" y="330" font-size="40" fill="#2E2E2E">被引用的那一句話，</text><text x="210" y="400" font-size="40" fill="#2E2E2E">可以到第二行。</text><rect x="210" y="450" width="80" height="4" fill="#909090"/><text x="210" y="510" font-size="24" fill="#555555">受訪者・身分</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 引號 | `garnish` | 裸 `<text>` 的大引號 | — | — |
| 引文 | `label`（`claim` 或 `title` 字級） | ≤ 3 行 | 每行 20 字 | 1–3 |
| 分隔短線 | `garnish` | | — | — |
| 出處 | `label`（`caption`） | 姓名與身分 | 20 字 | 1 |

## 節奏

引文縮排（左緣比標題更靠右），出處對齊引文左緣。**引號是裝飾**，不是文字框。

`blueprint.shape` 寫 `quote-block`。

## 變體

- **置中版**：引文水平置中，更正式。
- **配頭像**：左側一個圓形頭像，右側引文。
