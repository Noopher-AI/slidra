# 41 · audio-waveform

**解的關係**：`none`
**單位數**：1
**一句話**：一條橫跨版面的波形帶，上方一句要聽什麼、下方是逐字重點——聲音沒有畫面，所以版面要替它補上。

**什麼時候用它**：訪談片段、客服錄音、現場實錄、podcast 節錄。
**什麼時候不要用**：聲音只是背景音樂。背景音樂不需要一頁。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="230" width="1120" height="120" fill="#F2F2F2" stroke="#CCCCCC"/>
<g stroke="#999999" stroke-width="3">
<line x1="130" y1="270" x2="130" y2="310"/><line x1="160" y1="250" x2="160" y2="330"/>
<line x1="190" y1="278" x2="190" y2="302"/><line x1="220" y1="240" x2="220" y2="340"/>
<line x1="250" y1="262" x2="250" y2="318"/><line x1="280" y1="282" x2="280" y2="298"/>
<line x1="310" y1="246" x2="310" y2="334"/><line x1="340" y1="270" x2="340" y2="310"/>
</g>
<ellipse cx="1130" cy="290" rx="28" ry="28" fill="#FFFFFF" stroke="#666666" stroke-width="3"/>
<path d="M1121 276l18 14l-18 14z" fill="#666666"/>
<text x="80" y="200" font-size="18" fill="#444444">要聽的是什麼（label）</text>
<text x="80" y="420" font-size="18" fill="#666666">逐字重點一</text>
<text x="80" y="470" font-size="18" fill="#666666">逐字重點二</text>
<text x="80" y="600" font-size="14" fill="#999999">受訪者・長度</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 引導句 | `label` | 要聽的是什麼 | 20 字 | 1 |
| 波形帶 | `node`（`audio`） | 橫跨安全區 | — | — |
| 逐字重點 ×N | `label` | **播放時對照用**，不是全文逐字稿 | 每條 22 字 | 1 |
| 出處 | `label`（`caption`） | 受訪者與長度 | 20 字 | 1 |

## 節奏

波形帶高度 100～140，橫跨整個安全區。**逐字重點最多三條**——聲音在播的時候，聽眾只能分心讀很少的字。全文逐字稿放備忘稿。

`blueprint.shape` 寫 `audio-waveform`。

## 怎麼放進去

```
co-motion asset import <id> <音檔路徑>
co-motion element insert audio <id> slides/00N.svg --x 80 --y 230 --width 1120 --height 120 --media assets/<檔名>
```

## 變體

- **多段**：兩三條較短的波形帶垂直排列，各自一個引導句。
- **配頭像**：左側一個圓形頭像，右側波形——受訪者是誰很重要時。
