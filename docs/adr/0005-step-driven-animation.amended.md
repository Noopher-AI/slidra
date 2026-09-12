# 動畫用 `data-slidra-*` 屬性搭自製 runtime，不用 SMIL 或 CSS

> **⚠️ 本 ADR 已被大幅修訂，剩下的核心只有一句。** 兩處條款失效：
> 「動態資訊以元素屬性表達」由 **ADR-0009** 取代（改為投影片 `<metadata>` 裡一份有序的效果清單）；
> 「runtime 不得依賴 server」由 **ADR-0007** 取代（播放與編輯是同一個 web app 的兩個模式）。
> 詳細說明見下文原處的兩則註記。
>
> **仍然成立的**：步驟驅動、不用 SMIL 與 CSS animation、不用 `<foreignObject>`、
> 影音以可見的佔位元素搭 `data-slidra-media` 表達。

簡報動畫是**步驟驅動**的：使用者按一下，下一個元素出現，中間停留多久由他決定。SMIL 與 CSS animation 都是時間軸驅動，要用它們表達「等待使用者按鍵」仍得寫 JS 去 pause/seek，等於在自製 runtime 之外多疊一層扭曲的中介。

因此動態資訊以自訂屬性表達，由 Slidra 的 runtime 驅動：

```xml
<g id="el-a3f2c1" data-slidra-name="標題" data-slidra-step="1" data-slidra-enter="fade">
```

> **屬性設計已由 ADR-0009 取代。** 動態現在寫成一份有序的效果清單，放在投影片 SVG 的 `<metadata>` 裡，每項指向一個元素；步驟由清單推導，不再是元素身上的一個數字。撤銷的只有「動態資訊以元素屬性表達」這一點——「步驟驅動、不用 SMIL 與 CSS animation」的判斷仍然成立，那才是本 ADR 的核心。元素識別碼、`data-slidra-name`、以及下一段影音的 `data-slidra-media` 都不受影響。

影音沿用同一套機制：poster 佔位 `<image>` 搭 `data-slidra-media="assets/intro.mp4"`，播放時由 runtime 替換。不用 `<foreignObject>`，因為多數 SVG 檢視器不支援它，靜態畫面會破洞，違反 ADR-0001。

## Consequences

- `data-*` 是合法 SVG 屬性，用其他工具開啟時靜態畫面正常，只是不會動。
- 代價是 `.slidra` 離開 Slidra 就不會動。換到的是完全貼合簡報心智模型的動畫模型，以及 agent 一眼看懂、改一個屬性就完成的操作方式。
- runtime 不得依賴 server：它只需要讀 SVG 與屬性、處理按鍵與影音。保持這份無知，未來 `slidra export --html` 幾乎免費，而真正上台簡報時不必在每台電腦安裝 Slidra。

> **上一條已由 ADR-0007 取代。** runtime 現在可以依賴 server：播放與編輯是同一個 web app 的兩個模式，播放 `.slidra` 需要安裝 Slidra，分享改走匯出。上面的理由留在原地，記錄當初的權衡。本 ADR 的其餘決定不受影響。

## 修訂（[E2.T7]：runtime 改用 Web Animations API 驅動）

「不用 SMIL 與 CSS animation」原本落地成純 CSS `transition`（`opacity`／`el.style` 的直接賦值）。[E2.T7] 把驅動方式換成 **Web Animations API**（`el.animate(keyframes, options)`），仍然完全落在「不用 SMIL、不用 CSS `@keyframes`／`animation`」這條決定的字面之內——WAAPI 是 runtime 自己呼叫、自己決定何時播放/取消的指令式 API，不是宣告式的時間軸描述，跟 SMIL／CSS animation 是兩種不同的東西。改用它的理由：

- 四個家族（進場／強調／退場，加上這輪新增的路徑）的動畫描述天生就是「一組 keyframes」，WAAPI 是瀏覽器對這個形狀原生、可控（`cancel()`、`.finished`）的支援；純 CSS `transition` 只能表達兩個端點的插值，撐不起強調效果的來回關鍵影格或路徑效果的多點取樣。
- 退回（`resetToStep`）藉由 `document.getAnimations().forEach(a => a.cancel())` 拿到「已知乾淨起點」，取代了先前手動清 `style.opacity`／`style.transition` 的做法——這與「退回是瞬間的」既有保證完全相容，只是實作機制換了。
- 路徑動畫（`family="path"`）沿一條 SVG path 取樣出一串 `transform: translate(dx,dy)` keyframes 交給 `el.animate`，刻意不用 `offset-path`／`motion-path` CSS：那組屬性在不同引擎的支援度不一致，會變成第二套動畫引擎，而不是這一套機制的延伸。
- 隱藏規則（`renderHideStyle`）改成每個 id 一條規則、由 runtime 在解除隱藏的同一個同步任務裡先移除規則再呼叫 `el.animate`，避免 `!important` 規則蓋過 WAAPI 的 opacity 關鍵影格（`!important` 的優先序高於任何動畫層級的樣式）。

「不用 `<foreignObject>`」「影音以可見佔位元素搭 `data-slidra-media` 表達」「步驟驅動」三條完全不受影響。
