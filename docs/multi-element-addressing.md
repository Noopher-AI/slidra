## 多元素定址（`element` 命令族群）

`element insert / delete / move / scale / rotate / style set / order`（#104）是唯一需要同時處理「一個或多個目標元素」的命令族群。這份文件記錄該怎麼在 CLI 上表示多個目標、以及每條命令對多目標的語意，讓 agent 只需要學一次規則。

### 逗號分隔語法

結構化輸入（`CommandHandler` 的 `input`、未來的 `co-motion serve`）一律是一個真陣列：

```ts
elementIds: string[] // 長度 ≥ 1，不可有重複 id
```

CLI 的 argv 層把「元素識別碼」這個位置參數改成**逗號分隔、不含空白**的清單：

```bash
co-motion element move <id> <slide-path> el-abc,el-def --dx 10 --dy -5
co-motion element style set <id> <slide-path> el-abc fill "#c43e1c"
co-motion element delete <id> <slide-path> el-abc,el-def,el-ghi
co-motion element scale <id> <slide-path> el-abc --factor 2
co-motion element rotate <id> <slide-path> el-abc,el-def --degrees 45
co-motion element order <id> <slide-path> el-abc,el-def front
```

單一元素就是長度 1 的清單，語法完全不變（`el-abc` 跟 `el-abc,el-def` 只差有沒有逗號）——這是刻意的：agent 不需要為「一個目標」和「多個目標」記兩套語法。

**為什麼是逗號分隔，不是重複 `--target` flag：** 這支 CLI 的既有 argv 慣例是「位置參數 + flag 給選項值」（見 `argv.ts` 的 `requirePositional`），元素 id 清單概念上仍然是「一個位置參數的值」，不是一個選項；逗號分隔完整保留現有的位置參數個數與順序，不用改動 `requirePositional` 的介面去支援「可重複的位置參數」。

找不到任一個 id 就是整條命令失敗（`element delete` 是「全部刪或都不刪」；其餘命令是「找到第一個不存在的 id 就整條失敗，之前已寫入的目標維持已寫入的狀態，因為每條命令對同一份 svgContent 只呼叫一次 `writePresentationFile`——見下方「一次操作＝一格復原」」）。

### 逐條命令的多目標語意

| 命令 | 多目標語意 |
|---|---|
| `element insert` | 沒有多目標，本來就是建立單一新元素，回傳它的新 id。 |
| `element delete` | 清單裡每個 id 各自被刪除；若某 id 是群組，整個子樹一併刪除。清單中的 id 若剛好是另一個清單成員的子孫，視為已被涵蓋，不重複處理、不報錯。 |
| `element move` | 同一組 `(dx, dy)` 套用到每個目標各自的容器 `transform`（各自的 `translateX`/`translateY` 各自加上這組值），不計算整體邊界框位移。 |
| `element scale` | 同一個 `factor` 套用到每個目標，各自獨立以自己容器的 local origin（`translate` 落點）為錨點縮放；群組遞迴套用到子孫。見下方「決定：相對變化量，各自獨立套用」。 |
| `element resize`（NOOP-90/T2，新命令）| 同一組 `(width, height, anchor)` 套用到每個目標，**各自獨立**依自己當下的邊界框算出自己的 `(sx, sy)`（不是共用同一組縮放比例）：每個目標各自被縮放到同樣的 `width × height`，錨點角落（`nw`/`ne`/`sw`/`se`）各自在自己的父座標系內固定不動。群組遞迴套用（子孫容器的 `translateX`/`translateY` 各自乘上該目標自己的 `(sx, sy)`）。含 `<text>`、`<circle>`、`<path>` 圖元的目標只接受 `sx === sy`（等比），非等比一律報錯並提示改用 `element scale`。 |
| `element rotate` | 同一個 `degrees` 差量套用到每個目標的 `rotation`，其餘 transform 分量不變，各自獨立。 |
| `element style set` | 同一個屬性名/屬性值套用到清單裡每一個元素。 |
| `element order` | `front`/`back`：清單裡的目標各自在自己的父容器裡被移到最上/最下，多個目標之間保留清單給定的順序（`front` 時，清單最後一個 id 疊在最上面；`back` 時，清單最後一個 id 疊在最下面）。`up`/`down`：依清單順序逐一處理，每處理完一個就重新查詢一次兄弟關係再處理下一個（不是一次性算好位移量）。跨父容器的目標各自在自己的父容器內移動，互不影響。 |

**一次操作＝一格復原：** 這是 `writePresentationFile`/`history.ts` 既有的結構保證（一次 dispatch 呼叫一次 `writePresentationFile`），不需要新邏輯——`element-edit.ts` 對同一份 `svgContent` 依序套用所有目標的變更，最後一次回傳完整結果；`workspace.ts` 的七個包裝函式只呼叫一次 `writePresentationFile`。不會對清單裡每個 id 各呼叫一次，那會把一條多目標命令拆成 N 格復原。

### 決定：相對變化量，各自獨立套用（不做「整組當一個框」）

`element move` / `element scale` / `element rotate` 的多目標語意，一律是「同一個相對變化量，各自獨立套用在自己的容器 transform（或遞迴子孫）上」，不計算多目標的聯集邊界框（不做「整組當一個框」）。

理由三點，缺一不可：

1. `geometry/bbox.ts#primitiveBounds` 今天對 `<text>` 直接拋錯（字型度量已就緒但沒接回去）。要做「整組當一個框」必須先把這個洞補起來，那是比 #104 大的獨立工程，不屬於編輯命令層。
2. 「相對變化量各自套用」讓 move/scale/rotate 三條命令共用同一個心智模型（見上方表格），agent 只要學一次規則。
3. 混合選取（例如一個大背景矩形 + 一個小文字標籤）用共享外框縮放，視覺上標籤會被甩到不成比例的位置；各自獨立縮放不會有這個驚訝行為。

**代價已知並接受：** 「選取一群元素、當一個框一起縮放」（PowerPoint/Figma 那種多選縮放直覺）在這一輪做不到，agent 若真的要「這幾個元素當一組等比縮放」，得先用未來的群組命令把它們群組起來，再對群組下 `element scale`——`element scale` 對單一群組目標已經是「整組當一個框」的效果（遞迴縮放），這條路徑本來就通。

`element scale` 對群組的遞迴規則：群組自己的容器 `transform` 不變（它是縮放錨點所在，維持原地不動）；每個直接子節點的 `translateX`/`translateY`（透過 `decomposeMatrix` 取出）乘上 `factor`、`rotation` 不變，重新 `formatTransform`；子節點若自己也是群組就繼續遞迴用同一個 `factor`（不會隨深度累乘）；子節點若是葉節點就對它的原生屬性套用各 kind 的縮放規則。

### 懸空效果項清理（ADR-0009，`element delete` 專用的最小 schema）

`element delete` 刪除元素後，會清除任何指向被刪 id（含群組子孫 id）的效果項。目前沒有任何既有命令會寫入效果清單——這是一份本票（#104）自訂、僅為了讓「刪除時清除懸空效果項」這條驗收標準有東西可測的最小 placeholder schema：

```xml
<metadata>
  <comot:effects xmlns:comot="https://schemas.comotion.app/effects">
    <comot:effect target="el-abc" .../>
  </comot:effects>
</metadata>
```

`element delete` 移除任何 `target` 命中被刪 id 的 `<comot:effect>` 節點。若未來有票要落地「新增效果」命令，選用不同 schema，以那張票的決定為準；這個 schema 不是強約束，只是一個佔位的最小可行實作。
