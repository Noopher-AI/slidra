# 25 · quote-block

**解的關係**：`none`
**單位數**：1
**一句話**：一段引用佔據版面，出處在下方——把別人的話當成這一頁的全部。

**什麼時候用它**：客戶的原話、使用者回饋、權威的判斷。**引用必須是真實的**。
**什麼時候不要用**：自己的主張。把自己的話排成引用會顯得矯情。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<text x="140" y="240" font-size="72" fill="#DDDDDD">&#8220;</text>
<text x="200" y="340" font-size="36" fill="#333333">被引用的那句話，</text>
<text x="200" y="400" font-size="36" fill="#333333">可以到第二行。</text>
<line x1="200" y1="460" x2="280" y2="460" stroke="#999999" stroke-width="3"/>
<text x="200" y="510" font-size="18" fill="#777777">出處・身分（label）</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
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
