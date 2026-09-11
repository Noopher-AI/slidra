# 03 · spine-path

**解的關係**：`order`（順序、步驟、流程、時間、排名）
**單位數**：3–5
**一句話**：一條主軸（`spine`）串起等距的節點，方向與端點都看得出來——這是「有先後」最直接的講法。

**什麼時候用它**：步驟、時間軸、流程、演進。
**什麼時候不要用**：並列的內容（那是 `card-wall`）。**把有順序的內容排成卡片牆是最常見的錯誤**——讀者會以為那幾件事可以互換。

**方向從哪裡看出來**：三件事，至少要有兩件。(1) `spine` 本身的走向（水平由左至右、或垂直由上而下）；(2) 節點的編號或日期；(3) 端點的差異——起點與終點的處理不能一樣（例如終點的節點填實、其餘空心）。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<line x1="160" y1="360" x2="1120" y2="360" stroke="#8A8A8A" stroke-width="5"/><ellipse cx="220" cy="360" rx="40" ry="40" fill="#FFFFFF" stroke="#909090" stroke-width="4"/><text x="220" y="371" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">01</text><text x="220" y="452" font-size="24" fill="#777777" text-anchor="middle">第一步</text><text x="220" y="492" font-size="18" fill="#A0A0A0" text-anchor="middle">一句說明</text><ellipse cx="640" cy="360" rx="40" ry="40" fill="#FFFFFF" stroke="#909090" stroke-width="4"/><text x="640" y="371" font-size="24" fill="#555555" font-weight="700" text-anchor="middle">02</text><text x="640" y="452" font-size="24" fill="#777777" text-anchor="middle">第二步</text><text x="640" y="492" font-size="18" fill="#A0A0A0" text-anchor="middle">一句說明</text><ellipse cx="1060" cy="360" rx="40" ry="40" fill="#8A8A8A" stroke="#909090" stroke-width="4"/><text x="1060" y="371" font-size="24" fill="#FFFFFF" font-weight="700" text-anchor="middle">03</text><text x="1060" y="452" font-size="24" fill="#777777" text-anchor="middle">最後一步</text><text x="1060" y="492" font-size="18" fill="#A0A0A0" text-anchor="middle">一句說明</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | 這一頁的主張 | 15 字（上限 24） | 1 |
| 主軸 | `spine` | 一條線，**一頁只有一條** | — | — |
| 節點 ×N | `node` | 每站一個；終點與其餘不同（填實或加粗） | — | — |
| 節點編號 | `label` | `01`／年份／步驟名 | 4 字 | 1 |
| 節點說明 | `label` | 這一站發生什麼 | 12 字（上限 24） | 1–2 |
| 頁尾三件 | — | | — | — |

## 節奏

節點等距排在主軸上。**節點數多時改成垂直主軸**（左緣一條線、節點由上而下），水平方向塞超過 5 個會讓說明文字互相擠壓。說明文字一律在節點的同一側，不要左右交錯——交錯會讓閱讀順序變得不確定。

`blueprint.shape` 寫 `spine-path`。**沒有對應的 `type`**，所以計畫的 `type` 留空。

**動畫**：1＋N 步——標題一步（主軸 `with-previous` 跟著出來），之後每個節點一步。節點與它的編號、說明先 `element group`。效果用 `fly-left`（水平主軸）或 `fly-up`（垂直主軸）**強化方向**，不要用 `fade`。

## 變體

- **階梯**（`stepped`）：拿掉線，改用逐階升高或降低的色塊——適合「逐步增長」或「逐步收斂」。
- **大號數字領頭**（`numbered-run`）：拿掉線與節點，只留很大的編號與說明橫排——最輕的順序表達，適合步驟少且文字短的時候。
- **轉折**：主軸不必是直線。流程有分支或回饋時，用帶轉角的 path，並在轉角處放節點。
