# 每個元素包在一層 `<g transform>` 裡

> **⚠️ 已被 E2.T12（圖表，#204）amend：圖表容器不是「一個或多個圖元」，而是「一個資料元素
> `<comot:chart>` 加一個渲染結果 `<svg>`」，是這份 ADR 第一次出現的例外形狀。**
>
> ```xml
> <g id="el-chart" data-comot-type="chart" transform="translate(691.2 115.2)">
>   <comot:chart xmlns:comot="https://co-motion.dev/ns"
>                type="bar" stacked="false" axes="single" palette="brand"
>                legend="bottom" grid="true" labels="true"
>                x-title="Week" y-title="ms" width="486.4" height="475.2">
>     <comot:series name="TTFB (ms)" values="840,760,610,520,430,380" axis="left"/>
>     <comot:categories values="W1,W2,W3,W4,W5,W6"/>
>   </comot:chart>
>   <svg xmlns="http://www.w3.org/2000/svg" width="486.4" height="475.2" viewBox="0 0 486.4 475.2">…</svg>
> </g>
> ```
>
> - `data-comot-type="chart"`（`CONTAINER_ATTRIBUTES` 尾端新增）標記這個容器走這個例外形狀；
>   `packages/core/src/slide/format.ts` 的 `checkSlideCompliance` 在看到它時，把 ADR-0012 原本的
>   「容器只能全是 `<g>` 或全是合法圖元」partition 換成「必須恰好一個 `<comot:chart>` 加一個
>   `<svg>`」，其餘位置的裸 `<svg>` 仍是 `unknown-tag`，不受影響。
> - `<comot:chart>` 是資料，`<svg>` 是渲染結果——兩者的關係跟 ADR-0009 的 `<comot:effects>`
>   （資料）與播放時的視覺效果（衍生）一樣：**渲染結果只由 `packages/core/src/chart/render.ts`
>   的 `renderChartSvg` 產生，每次 `chart` 命令重畫一次，GUI 或任何其他命令都不直接改它**——這
>   正是本 ADR「位置只寫在一個地方」（見下方 Consequences）這條不變式延伸出的新結構守衛：
>   `element style set`／`element scale`／`element resize` 對圖表容器一律明確報錯，理由同下方
>   「`transform`/`x`/`y`/`width`/`height` 不得經由樣式命令寫入」——寫入 `<comot:chart>` 或內嵌
>   `<svg>` 的正確路徑只有 `chart` 命令族，繞過它會讓兩者不同步。
> - `<comot:chart>` 不貢獻 `getBBox()`／`primitiveBounds`；只有內嵌 `<svg>`（視為與 `rect`/`image`
>   同式：`x`/`y` 預設 0，`width`/`height` 必填）貢獻邊界框——圖表因此像其他元素一樣可以搬移、
>   群組、被效果清單指向，但本版不支援縮放／改尺寸（尺寸只在 `chart create` 或 `chart data set`
>   等命令重畫時由 core 決定）。
> - 內嵌 `<svg>` 與「單獨開啟的圖表 SVG」是同一串位元組：帶 `xmlns`/`width`/`height`/`viewBox`，
>   不帶 `x`/`y`（位置只寫在容器 `transform`，與本 ADR 的既有規則完全一致，只是多了「圖元」換成
>   「一整份自己也是合法 SVG 文件的渲染結果」這一種新形狀）。
>
> **沒有改變的部分**：容器仍然只有一層、位置與旋轉仍然只寫在容器的 `transform` 上、「投影片格式
> 因此變嚴格，不合規的 SVG 不能被編輯命令操作」這條原則不變——只是圖表容器合規的判準是「兩個
> 特定子元素」而不是「一個或多個圖元」。

編輯功能要求四件事：搬移、縮放、旋轉、群組。現有的投影片 SVG 是裸圖元——`<text x y font-size>`、`<rect x y width height>`——每種圖形用自己的方式講位置，而且**沒有任何地方可以寫「我轉了幾度」**，因為在此之前沒有人需要。

因此元素的正規形式改為：一層 `<g>` 容器包住一個或多個圖元，**位置與旋轉一律寫在容器的 `transform` 上**，尺寸仍走各圖元的原生屬性。

```xml
<g id="el-title" data-comot-name="標題" transform="translate(640 330) rotate(-15)">
  <text text-anchor="middle" font-size="86">驗收用簡報</text>
</g>
```

決定性的理由是**只有這一個機制同時解決四件事，而且完全是原生 SVG**。搬移是改 `translate` 的兩個數字，旋轉是 `rotate` 的一個角度，群組是 `<g>` 包 `<g>`——搬動一個十二元素的群組只改最外層容器，底下一個位元組都不必動。而 `<g>` 與 `transform` 自 SVG 1.1 起就是核心語法，任何瀏覽器、向量工具或看圖程式打開都畫得出正確的樣子，**包含旋轉**。ADR-0001 的靜態相容性不但不受損，還是選它的主因。

## Considered Options

- **顯式邊界框**（每個元素帶 `data-comot-box="x y w h"` 與旋轉角，圖元照著框畫）：縮放與對齊最好算，心智模型貼近 PowerPoint。但同一件事存兩份——框一份、圖元的原生屬性一份——兩份必須永遠一致，而不一致時畫面不會報錯，只會慢慢歪掉。更致命的是旋轉會變成自訂屬性，別的軟體讀到直接忽略，於是在 CoMotion 裡轉了 15 度的標題，用預覽程式打開是正的。這正面違反 ADR-0001。
- **不包容器，命令直接改原生屬性**：SVG 最乾淨、token 成本最低、現有 demo 不用轉檔。但旋轉無處可放，群組搬移要重寫底下每一個子元素的座標，且每種圖形都要一套搬移邏輯。它「原樣打開正確」是靠放棄功能換來的。

## Consequences

- **每個元素多一層標籤**。ADR-0004 明講「SVG 檔案大小直接等於每輪對話的 token 成本」，所以這是真實成本，不是潔癖。換到的是四個功能與一套統一的操作語彙。
- **絕對座標要算**。容器可以巢狀，「這個元素實際在畫面哪裡」是一路乘上來的。對齊命令因此必須先求每個元素的邊界框，這份數學住在 `@co-motion/core`，供 CLI 與前端共用——兩邊算出來的必須一模一樣，否則放開滑鼠的瞬間東西會跳。
- **`transform`、`x`、`y`、`width`、`height` 不得經由樣式命令寫入**（見 ADR-0014）。位置只寫在一個地方，這條不變式需要結構守衛，不是紀律。
- **投影片格式因此變嚴格**：不合規的 SVG 不能被編輯命令操作，命令拋錯並指出哪裡不對。另有一條使用者主動執行的轉換命令把 SVG 正規化成合規投影片。不自動修——那是靜默改寫使用者的檔案。
- **任意 `path` 可以被收進來**，且幾乎免費：它的搬移、縮放、旋轉全都是容器給的，唯一做不到的是編輯節點。人不編輯貝茲曲線，要改造型就叫 agent 重畫一個。
- 現有的 `demo/` 與任何手寫投影片都要經由轉換命令跑一次。
