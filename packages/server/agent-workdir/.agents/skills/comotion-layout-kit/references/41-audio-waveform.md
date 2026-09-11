# 41 · audio-waveform

**解的關係**：`none`
**單位數**：1
**一句話**：一條橫跨版面的波形帶，上方一句要聽什麼、下方是逐字重點——聲音沒有畫面，所以版面要替它補上。

**什麼時候用它**：訪談片段、客服錄音、現場實錄、podcast 節錄。
**什麼時候不要用**：聲音只是背景音樂。背景音樂不需要一頁。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<text x="80" y="180" font-size="28" fill="#2E2E2E" font-weight="700">要聽的是什麼（引導句）</text><rect x="80" y="230" width="1120" height="140" fill="#EDEDED" stroke="#BFBFBF"/><line x1="150" y1="254" x2="150" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="184" y1="282" x2="184" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="218" y1="282" x2="218" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="252" y1="254" x2="252" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="286" y1="282" x2="286" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="320" y1="282" x2="320" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="354" y1="254" x2="354" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="388" y1="282" x2="388" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="422" y1="282" x2="422" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="456" y1="254" x2="456" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="490" y1="282" x2="490" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="524" y1="282" x2="524" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="558" y1="254" x2="558" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="592" y1="282" x2="592" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="626" y1="282" x2="626" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="660" y1="254" x2="660" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="694" y1="282" x2="694" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="728" y1="282" x2="728" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="762" y1="254" x2="762" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="796" y1="282" x2="796" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="830" y1="282" x2="830" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="864" y1="254" x2="864" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="898" y1="282" x2="898" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="932" y1="282" x2="932" y2="318" stroke="#8A8A8A" stroke-width="5"/><line x1="966" y1="254" x2="966" y2="346" stroke="#8A8A8A" stroke-width="5"/><line x1="1000" y1="282" x2="1000" y2="318" stroke="#8A8A8A" stroke-width="5"/><ellipse cx="1120" cy="300" rx="34" ry="34" fill="#FFFFFF" stroke="#909090" stroke-width="3"/><path d="M1107 283l34 17l-34 17z" fill="#909090"/><text x="80" y="450" font-size="24" fill="#777777">・逐字重點一</text><text x="80" y="510" font-size="24" fill="#777777">・逐字重點二</text><text x="80" y="570" font-size="24" fill="#777777">・逐字重點三</text><text x="80" y="624" font-size="18" fill="#A0A0A0">受訪者・長度</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
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
