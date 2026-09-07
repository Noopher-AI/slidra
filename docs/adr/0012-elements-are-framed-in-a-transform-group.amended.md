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
>   `element style set` 對圖表容器一律明確報錯，理由同下方「`transform`/`x`/`y`/`width`/`height`
>   不得經由樣式命令寫入」——寫入 `<comot:chart>` 或內嵌 `<svg>` 的正確路徑只有 `chart` 命令族，
>   繞過它會讓兩者不同步。`element scale`／`element resize` 則是這條路徑的一個例外入口：它們不碰
>   容器 transform 的縮放，而是把 `<comot:chart>` 的 `width`/`height` 乘上倍率後**重畫**一次
>   （`chart/edit.ts` 的 `scaleChartElement`），所以資料元素與渲染結果仍然同步，且文字不會被拉變形。
> - `<comot:chart>` 不貢獻 `getBBox()`／`primitiveBounds`；只有內嵌 `<svg>`（視為與 `rect`/`image`
>   同式：`x`/`y` 預設 0，`width`/`height` 必填）貢獻邊界框——圖表因此像其他元素一樣可以搬移、
>   群組、被效果清單指向、縮放／改尺寸（等比或非等比皆可，見上一點：一律以新尺寸重畫）。
> - 內嵌 `<svg>` 與「單獨開啟的圖表 SVG」是同一串位元組：帶 `xmlns`/`width`/`height`/`viewBox`，
>   不帶 `x`/`y`（位置只寫在容器 `transform`，與本 ADR 的既有規則完全一致，只是多了「圖元」換成
>   「一整份自己也是合法 SVG 文件的渲染結果」這一種新形狀）。
>
> **沒有改變的部分**：容器仍然只有一層、位置與旋轉仍然只寫在容器的 `transform` 上、「投影片格式
> 因此變嚴格，不合規的 SVG 不能被編輯命令操作」這條原則不變——只是圖表容器合規的判準是「兩個
> 特定子元素」而不是「一個或多個圖元」。
>
> **本 ADR 由 E2.T14（表格，#203）追加一個容器變體。** 下方原有內容全部不變——這裡只新增
> `data-comot-type="table"` 這一種容器形狀，見文末「表格容器（E2.T14）」一節。

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

## 表格容器（E2.T14, #203）

表格是這份 ADR「一個容器包一或多個圖元」規則的第二個例外（第一個是圖表，E2.T12，若已合併見同檔案該節）：一個 `data-comot-type="table"` 容器包一個可選的 `<comot:source>`（資料綁定宣告）加上多個 `<g data-comot-cell="r,c">`：

```xml
<g id="el-tbl1" data-comot-type="table"
   data-comot-cols="200 300 240" data-comot-rows="44 40 40"
   data-comot-header="1" data-comot-theme="dark"
   transform="translate(120 160)">
  <comot:source xmlns:comot="https://co-motion.dev/ns" src="assets/data/sales.csv"/>
  <g data-comot-cell="0,0" transform="translate(0 0)">
    <rect x="0" y="0" width="200" height="44" fill="#ffffff" fill-opacity="0.06"/>
    <text x="12" y="30" font-size="16" font-weight="700" fill="#a9b0b8" xml:space="preserve">
      <tspan x="12" y="30">指標</tspan>
    </text>
  </g>
  …
</g>
```

固定規則：

- **儲存格容器不帶 `id`**——定址一律靠 `data-comot-cell="r,c"`（0-based，列,欄）；因此表格的儲存格不是獨立可選取的元素，`element move`／`element style set` 等一律作用在整個表格容器上，從不下探到某一格。
- 儲存格的位置寫在自己的 `transform="translate(x y)"`；圖元（`<rect>`/`<text>`）上永遠沒有 `transform`——與這份 ADR 的核心規則一致。
- `data-comot-cols`／`data-comot-rows` 是核心算出寫回的欄寬／列高，不接受使用者直接指定列高（欄寬可經 `table col width` 設定；加 `--keep-total` 時右鄰欄吸收差值、表格總寬不變——GUI 拖欄界線走的就是這條）。
- 表格的邊界框是 `(0,0)` 到 `(Σcols, Σrows)` 經容器 `transform` 變換，不是子圖元的聯集（`geometry/bbox.ts` 的表格分支）——因為儲存格沒有 `id`，不是可獨立測量的「元素」。
- 表格可以像任何元素一樣**加入群組**（儲存格定址是相對表格容器 id 的，容器放在哪一層都不受影響）；`element ungroup` 對錶格容器本身一律拋錯，因為表格不是群組、儲存格不是可獨立選取的成員。
- `element scale`／`element resize` 對錶格**只改容器 `transform` 的 `scale()`**，欄寬／列高與儲存格內容一個位元組都不動——表格像一張圖一樣整體縮放（含文字，同 PowerPoint），之後的任何 `table` 命令都原樣保留這個 scale。因為文字跟著容器縮放，只接受等比：`element resize` 收到 sx ≠ sy 時拋錯（同文字框的規則），GUI 對錶格一律走等比路徑。這是本 ADR 「尺寸走圖元原生屬性」的一個明確例外，理由是表格的尺寸本來就不在圖元上而在 `data-comot-cols`／`data-comot-rows`，而那兩個值是核心從內容算出來的，不能被一個倍率覆寫。
- 資料綁定沒指定 `--template-row` 時，預設模板列是**第一個含 `{{ 欄名 }}` 的非表頭列**；沒有任何列帶佔位符時才退回最後一列。
- 資料綁定的展開（CSV → 具體儲存格）只發生在 `table bind`／`table refresh` 這兩條命令，不在顯示時做——與圖表「GUI 永遠不直接改渲染結果」的姿態一致，這裡是「顯示永遠不改動檔案內容」。
