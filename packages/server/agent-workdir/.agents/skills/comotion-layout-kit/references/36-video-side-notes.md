# 36 · video-side-notes

**解的關係**：`none`
**單位數**：1 + 2–4
**一句話**：左側影片、右側觀看重點——邊播邊講，觀眾知道該注意什麼。

**什麼時候用它**：影片較長（超過一分鐘），需要事先說明要看哪幾件事。
**什麼時候不要用**：影片只有幾秒——那用 31 `media-stage`，把版面讓給影片。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="200" width="640" height="360" fill="#D5D5D5" stroke="#BFBFBF"/><ellipse cx="400" cy="380" rx="40" ry="40" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><path d="M387 363l34 17l-34 17z" fill="#909090"/><text x="780" y="262" font-size="24" fill="#777777">・觀看重點一</text><text x="780" y="342" font-size="24" fill="#777777">・觀看重點二</text><text x="780" y="422" font-size="24" fill="#777777">・觀看重點三</text><text x="780" y="570" font-size="18" fill="#A0A0A0">長度・出處</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
