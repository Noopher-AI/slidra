# 07 · numbered-run

**解的關係**：`order`
**單位數**：3–4
**一句話**：很大的編號領頭，說明橫排在旁邊——最輕的順序表達，沒有線也沒有節點。

**什麼時候用它**：步驟少、每步一句話，而且不需要強調「之間的連接」。
**什麼時候不要用**：步驟之間有分支或回饋——那需要 `flow` 或 `chain` 的連接線。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<text x="100" y="400" font-size="140" fill="#E0E0E0" font-weight="700">01</text><text x="100" y="470" font-size="28" fill="#2E2E2E" font-weight="700">第一步</text><text x="100" y="514" font-size="24" fill="#777777">一句補充說明</text><text x="480" y="400" font-size="140" fill="#E0E0E0" font-weight="700">02</text><text x="480" y="470" font-size="28" fill="#2E2E2E" font-weight="700">第二步</text><text x="480" y="514" font-size="24" fill="#777777">一句補充說明</text><text x="860" y="400" font-size="140" fill="#E0E0E0" font-weight="700">03</text><text x="860" y="470" font-size="28" fill="#2E2E2E" font-weight="700">第三步</text><text x="860" y="514" font-size="24" fill="#777777">一句補充說明</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 編號 ×N | `label`（`number` 字級的淡色大字） | `01`… | 2 字 | 1 |
| 步驟名 | `label` | | 12 字 | 1 |
| 補充 | `label` | 可省 | 18 字 | 1 |

## 節奏

編號用 `number` 字級但顏色壓到 `muted`——它是節奏標記，不是重點。步驟名才是重點。等距橫排，三步最好看，四步就要縮小編號。

`blueprint.shape` 寫 `numbered-run`。

## 變體

- **直排**：編號在左、說明在右，由上而下——步驟較多或說明較長時用。
- **編號當背景**：編號放大到 200 級、透明度 0.08，說明壓在上面。
