# 動畫用 `data-comot-*` 屬性搭自製 runtime，不用 SMIL 或 CSS

> **⚠️ 本 ADR 已被大幅修訂，剩下的核心只有一句。** 兩處條款失效：
> 「動態資訊以元素屬性表達」由 **ADR-0009** 取代（改為投影片 `<metadata>` 裡一份有序的效果清單）；
> 「runtime 不得依賴 server」由 **ADR-0007** 取代（播放與編輯是同一個 web app 的兩個模式）。
> 詳細說明見下文原處的兩則註記。
>
> **仍然成立的**：步驟驅動、不用 SMIL 與 CSS animation、不用 `<foreignObject>`、
> 影音以可見的佔位元素搭 `data-comot-media` 表達。

簡報動畫是**步驟驅動**的：使用者按一下，下一個元素出現，中間停留多久由他決定。SMIL 與 CSS animation 都是時間軸驅動，要用它們表達「等待使用者按鍵」仍得寫 JS 去 pause/seek，等於在自製 runtime 之外多疊一層扭曲的中介。

因此動態資訊以自訂屬性表達，由 CoMotion 的 runtime 驅動：

```xml
<g id="el-a3f2c1" data-comot-name="標題" data-comot-step="1" data-comot-enter="fade">
```

> **屬性設計已由 ADR-0009 取代。** 動態現在寫成一份有序的效果清單，放在投影片 SVG 的 `<metadata>` 裡，每項指向一個元素；步驟由清單推導，不再是元素身上的一個數字。撤銷的只有「動態資訊以元素屬性表達」這一點——「步驟驅動、不用 SMIL 與 CSS animation」的判斷仍然成立，那才是本 ADR 的核心。元素識別碼、`data-comot-name`、以及下一段影音的 `data-comot-media` 都不受影響。

影音沿用同一套機制：poster 佔位 `<image>` 搭 `data-comot-media="assets/intro.mp4"`，播放時由 runtime 替換。不用 `<foreignObject>`，因為多數 SVG 檢視器不支援它，靜態畫面會破洞，違反 ADR-0001。

## Consequences

- `data-*` 是合法 SVG 屬性，用其他工具開啟時靜態畫面正常，只是不會動。
- 代價是 `.comot` 離開 CoMotion 就不會動。換到的是完全貼合簡報心智模型的動畫模型，以及 agent 一眼看懂、改一個屬性就完成的操作方式。
- runtime 不得依賴 server：它只需要讀 SVG 與屬性、處理按鍵與影音。保持這份無知，未來 `co-motion export --html` 幾乎免費，而真正上台簡報時不必在每台電腦安裝 CoMotion。

> **上一條已由 ADR-0007 取代。** runtime 現在可以依賴 server：播放與編輯是同一個 web app 的兩個模式，播放 `.comot` 需要安裝 CoMotion，分享改走匯出。上面的理由留在原地，記錄當初的權衡。本 ADR 的其餘決定不受影響。
