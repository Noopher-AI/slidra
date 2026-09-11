# 14 · scale-drop

**解的關係**：`parent`
**單位數**：3–4
**一句話**：尺寸逐層變小的方塊，從大到小排列——層級用大小表達，不用縮排也不用線。

**什麼時候用它**：層級同時帶有「範圍大小」的意思（市場→區隔→客群、願景→目標→任務）。
**什麼時候不要用**：層級只是歸屬而沒有大小之分。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="100" y="200" width="480" height="416" fill="#DCDCDC" stroke="#909090"/><text x="136" y="264" font-size="40" fill="#2E2E2E" font-weight="700">第一層</text><text x="136" y="320" font-size="22" fill="#777777">範圍最大</text><rect x="620" y="260" width="340" height="296" fill="#EDEDED" stroke="#BFBFBF"/><text x="652" y="316" font-size="28" fill="#555555" font-weight="700">第二層</text><rect x="1000" y="320" width="200" height="176" fill="#F4F4F4" stroke="#BFBFBF"/><text x="1024" y="372" font-size="22" fill="#777777">第三層</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 層 ×N | `node`（`field`） | 面積逐層縮小 | — | — |
| 層名 | `label` | 字級跟著縮小 | 10 字 | 1 |
| 層說明 | `label` | 可省 | 20 字 | 2 |

## 節奏

**面積比要明顯**（下一層約為上一層的 0.6）。字級也跟著降一級——尺寸與字級要同向，否則層級會打架。垂直置中對齊。

`blueprint.shape` 寫 `scale-drop`。

## 變體

- **同心版**：三個方塊改成同心排列，最外圈最大——更強調「包含」而不是「排列」。
- **由小到大**：反過來講「從一個小點長成一個大局」。
