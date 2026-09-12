# Slidra — New v3 Handoff

AI-agent-first slide editor. 這個包是 **設計交付**：可互動原型、設計語言、介面意義、假想後端介面、BDD 交互規格與討論紀錄。

## 目錄
| 路徑 | 內容 |
|---|---|
| `prototype/` | 可執行原型（`Slidra (New v3).dc.html` + `slidra-logic-v3.js` + `support.js` + 字型）。`reference/` 內為舊版重建與 v1 對照 |
| `docs/01-DESIGN_TOKENS.md` | 色彩、字體、間距、圓角、陰影、玻璃材質、動效 token |
| `docs/02-DESIGN_DOC.md` | 設計原則、版面結構、狀態機、資料模型、視覺系統 |
| `docs/03-UI_RATIONALE.md` | 每個區塊／每個介面元件背後的意義與決策 |
| `docs/04-BACKEND_INTERFACE.md` | 假想後端：TypeScript 型別、REST／WebSocket 介面、agent 協定 |
| `docs/05-INTERACTIONS.feature` | 前端交互模式（Gherkin／BDD） |
| `docs/06-KEYBOARD_AND_GESTURES.md` | 快捷鍵、滑鼠／手勢對照 |
| `docs/07-DISCUSSION_LOG.md` | 討論串紀錄（決策與否決的方案） |
| `docs/08-KNOWN_GAPS_AND_ROADMAP.md` | 原型未實作的部分、建議下一步 |

## 執行原型
原型以 ES module 動態載入 `slidra-logic-v3.js`，需透過 HTTP 伺服器開啟（不能直接 file://）：

```bash
cd prototype
python3 -m http.server 8080
# 開 http://localhost:8080/Slidra%20(New%20v3).dc.html
```

## 原型結構
- `Slidra (New v3).dc.html`：宣告式模板（所有樣式 inline），`<x-dc>` 內為 UI；底部 `<script data-dc-script>` 為極薄的殼，動態載入邏輯。
- `slidra-logic-v3.js`：`INITIAL_STATE` + `Logic` class（狀態、歷史、元素、表格、圖表 SVG、動畫、群組、畫布縮放、插入面板、AI 留言）。`renderVals()` 把狀態攤平成模板可讀的值。
- `support.js`：模板執行時期（第三方提供，不需修改）。
