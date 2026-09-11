# 37 · video-grid

**解的關係**：`membership`
**單位數**：2–4
**一句話**：幾段短片並排，各配一行說明——用途相同、長度都短的片段一次看完。

**什麼時候用它**：多段同性質的短片（各家做法、幾個使用情境、幾次測試）。
**什麼時候不要用**：片段長度差很多——長的那段會沒時間播，變成擺設。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="80" y="200" width="540" height="300" fill="#D5D5D5" stroke="#BFBFBF"/><ellipse cx="350" cy="350" rx="36" ry="36" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><path d="M337 333l34 17l-34 17z" fill="#909090"/><text x="80" y="560" font-size="24" fill="#777777">說明1：這段在演什麼</text><rect x="660" y="200" width="540" height="300" fill="#D5D5D5" stroke="#BFBFBF"/><ellipse cx="930" cy="350" rx="36" ry="36" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><path d="M917 333l34 17l-34 17z" fill="#909090"/><text x="660" y="560" font-size="24" fill="#777777">說明2：這段在演什麼</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 影片 ×N | `node`（`video`） | 同尺寸 | — | — |
| 說明 ×N | `label` | 各自在下方 | 14 字 | 1 |

## 節奏

每段影片等大、16:9。**四段是上限**——再多就沒有人記得第一段演了什麼。

`blueprint.shape` 寫 `video-grid`。

## 變體

- **一大三小**：一段主片配三段短片，同 34 `image-mosaic` 的邏輯。
- **截圖代替**：不方便現場播時，改放三張截圖並在備忘稿寫下要口述的內容。
