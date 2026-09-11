# 36 · video-side-notes

**解的關係**：`none`
**單位數**：1 + 2–4
**一句話**：左側影片、右側觀看重點——邊播邊講，觀眾知道該注意什麼。

**什麼時候用它**：影片較長（超過一分鐘），需要事先說明要看哪幾件事。
**什麼時候不要用**：影片只有幾秒——那用 31 `media-stage`，把版面讓給影片。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="200" width="640" height="360" fill="#E0E0E0" stroke="#888888"/>
<ellipse cx="400" cy="380" rx="36" ry="36" fill="#FFFFFF" stroke="#666666" stroke-width="3"/>
<path d="M389 362l26 18l-26 18z" fill="#666666"/>
<text x="770" y="240" font-size="18" fill="#444444">觀看重點一</text>
<text x="770" y="320" font-size="18" fill="#444444">觀看重點二</text>
<text x="770" y="400" font-size="18" fill="#444444">觀看重點三</text>
<text x="770" y="560" font-size="14" fill="#999999">長度・出處</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 影片 | `node`（`video`） | 16:9，左側 | — | — |
| 重點 ×N | `label` | **看之前先講** | 每條 16 字 | 1 |
| 長度出處 | `label`（`caption`） | | 18 字 | 1 |

## 節奏

影片維持 16:9（640×360）。重點與影片**頂端對齊**，垂直等距。重點的字級不要大過標題。

`blueprint.shape` 寫 `video-side-notes`。

## 怎麼放進去

```
co-motion asset import <id> <影片路徑>
co-motion element insert video <id> slides/00N.svg --x 80 --y 200 --width 640 --height 360 --media assets/<檔名>
```

## 變體

- **重點在左**：影片放右側，適合先講再看。
- **重點加時間碼**：每個重點前面標「0:35」，讓聽眾知道何時出現。
