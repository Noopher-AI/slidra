# 每個元素包在一層 `<g transform>` 裡

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
- `data-comot-cols`／`data-comot-rows` 是核心算出寫回的欄寬／列高，不接受使用者直接指定列高（欄寬可經 `table col width` 設定）。
- 表格的邊界框是 `(0,0)` 到 `(Σcols, Σrows)` 經容器 `transform` 變換，不是子圖元的聯集（`geometry/bbox.ts` 的表格分支）——因為儲存格沒有 `id`，不是可獨立測量的「元素」。
- `element scale`／`element resize`／`element group`／`element ungroup` 對錶格容器一律拋錯：縮放與群組化都會破壞「儲存格靠位址定址」這個不變式。改變表格大小的唯一途徑是 `table col width`／`table row insert`／`table row delete`。
- 資料綁定的展開（CSV → 具體儲存格）只發生在 `table bind`／`table refresh` 這兩條命令，不在顯示時做——與圖表「GUI 永遠不直接改渲染結果」的姿態一致，這裡是「顯示永遠不改動檔案內容」。
