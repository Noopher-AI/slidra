---
name: comotion-build
description: 依作者確認過的 plan/ 計畫與設計規格逐頁建置投影片：一頁寫一份 SVG、依頁型套動畫、第一頁閘門、登記範本，最後 co-motion validate 修到 0 錯誤才回報
---

# 依計畫建置投影片

你是執行者。計畫（`plan/outline.md`）與設計規格（`plan/design-spec.md`）已經由 `comotion-plan` 寫好、作者在確認視窗拍板；你的工作是把每一頁照 `reference/slide-design.md` 的頁型範例**一頁寫成一份 SVG**、套上動畫，做到 `co-motion validate` 回 0 個錯誤。**計畫沒確認就不動手。**

## 觸發語

作者的訊息以 `/comotion-build` 開頭。確認視窗送出的訊息長這樣：

```
/comotion-build 【計畫確認】
mode=pyramid
page-5=number
animation=full
background=on
page-5.note=數字改成 11.8 分鐘
補充：第 3 頁想再短一點
```

## 輸入格式

- 「【計畫確認】」後面每行一題：`<題目 id>=<選項 value>`；作者有自由填寫時多一行 `<題目 id>.note=<文字>`；最後可能有一行 `補充：<整體意見>`。
- 沒有【計畫確認】、只有 `/comotion-build`：代表作者在終端機直接叫你建置，計畫必須已經是 `confirmed`。
- 後面接頁碼（例如 `/comotion-build 3-4`）：只重做那幾頁（整頁 `slide set --svg` 覆寫），計畫同樣必須是 `confirmed`。

## 步驟

1. **讀計畫**：`co-motion cat <presentation-id> plan/outline.md`。沒有這個檔 → 停下來說「還沒有計畫，請先 /comotion-plan」。
2. **處理確認**：
   - 訊息帶【計畫確認】：把每題答案套進計畫的 JSON 段（`mode` 題改 `mode`；`animation` 題改 `animation`；`background` 題改 `background`；`page-N` 題改該頁的 `type`，並依 `slide-design.md` 對應調整 `rhythm`；`palette` 題改 `design-spec.md` 的 `palette`；`.note` 與「補充」的內容改進該頁正文的關鍵詞或備忘稿），`questions` 清空，`status` 改成 `confirmed`，用 `co-motion plan set <presentation-id> outline '<全文>'` 寫回（配色有改就也 `plan set design-spec`）。
   - 沒有【計畫確認】且 `status` 不是 `confirmed`：**停下來**回「計畫還沒確認，請先在確認視窗拍板」，不碰任何投影片。
   - **帶【計畫確認】、但計畫已經是 `confirmed` 而且 `co-motion ls <presentation-id> slides` 已有投影片**：這是同一次確認被送了兩次（視窗與聊天框各一次，實際發生過）。**不要重建**——回一句「這份計畫已經建置過了（目前 N 頁）。要重做請說「重做第 X 頁」或「全部重做」」，然後停下。硬要重建會把作者手上的頁面覆蓋掉，而且兩次確認的答案可能不一樣。
3. **讀規格與現況**：`co-motion cat <presentation-id> plan/design-spec.md`（配色、密度、字級表、`visual`；計畫的 `background` 決定要不要背景圖）、`co-motion cat <presentation-id> project.json`（畫布；`k = width ÷ 1280`，指南的所有座標、半徑、字級乘以 k，`viewBox` 寫成畫布尺寸）、`co-motion template list <presentation-id>`、`co-motion ls <presentation-id> slides`。讀工作目錄的 `reference/slide-design.md`（第 0、1、4、4b、5 節是你的工作範圍）。
   - **背景圖資產先建好**（計畫 `background` 是 `on` 時）：依第 4b 節的「哪些頁型放」決定這份簡報要用到哪幾種配方（通常封面／結語一種、內容頁一種），每種 `co-motion asset import <presentation-id> --svg '<配方 SVG，<role> 換成色碼>' --name bg-<配方>-<配色>.svg`，**一種配方只建一次**，記下回傳的 `data.path`，之後每頁重用。
4. **一頁怎麼做**（六個階段，照順序；前一階段沒做完不要跳下一階段）

   1. **構圖思考**：計畫已經定好這一頁的 `relationship`（內容之間是什麼關係）。你要決定的是**用哪一種幾何承載它**（指南第 6.2 節的解法表，或自己組一個）、有幾個語意單位、以及**講述步驟的切法**。先看第 6.1 節那一列「幾何要承載的東西」——`order` 要看得出方向、`contrast` 要有共用基準線、`membership` 不該有方向。想不出「這一頁分幾段講」就代表內容還沒理清楚，先回去看計畫，不要開始畫。想完**把結論寫下來**，不要只放在心裡——在 `plan/outline.md` 這一頁的物件加上 `blueprint`，用 `co-motion plan set <presentation-id> outline '<全文>'` 寫回（`status` 維持 `confirmed`）：

      ```json
      { "n": 2, "relationship": "membership", "rhythm": "dense", "title": "…",
        "blueprint": { "shape": "shared-field", "nodes": 3, "steps": 4 } }
      ```

      - `shape`：你選的構圖叫什麼（第 6.2 節的名字，例如 `card-wall`／`shared-field`／`spine-path`；自己組的就給一個描述性的名字）。**相鄰兩頁不要用同一個 shape 解同一種關係**，`validate` 的 `rhythm.repeated-shape` 會抓。
      - `nodes`：這一頁有幾個語意單位（之後要標成 `data-comot-role="node"` 的那些）。
      - `steps`：這一頁分幾次點擊講完，也就是 `on-click` 的數量。
      - **不要只因為節點數就採用等分格線或鏡射對稱**：三個並列的想法才用三欄，三段有先後的想法要看得出方向。
   2. **背景製作**：計畫 `background` 是 `on` 時，確認步驟 3 已經建好這個頁型要用的配方資產（一種配方只建一次，之後每頁重用）；`off` 就跳過。背景只負責氣氛，**不承載意義**。
   3. **前景製作**：用了第 6.3 節的已知解就取第 4 節該頁型的 SVG 範例當**起點**；自己組的構圖就用第 3b 節的角色把幾何拼出來（`field` 圈出關係發生的區域、`node` 是每個語意單位、`spine` 是閱讀主軸、`edge` 是必要的連接、`label` 掛在 owner 上），`<role>` 換成 design-spec 的色碼、範例文字換成計畫裡的關鍵詞（標題＝主張），卡片或條目依計畫的條數增減（座標公式在範例下方）。**範例是起點不是規格**：欄寬比例、卡片高度、要不要合併成一塊面板、標題擺哪裡，都可以為了這一頁的內容調整——只要（一）不越過 `design-spec.layout` 的安全區，（二）字級與顏色仍取自字級表與配色，（三）間距取自 `layout.gutter` 與 `layout.spacing` 的級距。**不要為了貼合範例而犧牲內容**，也不要無緣無故偏離它。`background` 是 `on` 時把第 4b 節該頁型的 scrim rect 一起寫進去（放在被它墊著的文字之前）。**背景類型的裝飾（大圓、光暈、色團、光束、對角線、格線、光點）不進頁面 SVG**——那些都在背景圖資產裡；也不要自己加範例以外的裝飾幾何。**依指南第 3b 節替元素標上角色**（`data-comot-role`：`field`／`node`／`spine`／`edge`／`label`／`garnish`）——這是之後 group 與動畫的依據，也是 `validate` 檢查結構的依據：卡片底是 `field`、整張卡片是 `node`、卡片裡的字是 `label`、底線與小方塊是 `garnish`。**所有文字都用文字框宣告**（`<text data-comot-text-width=…>`，內容直接換行分段），不要自己放 `<tspan>`；每個元素保留範例的 `id` 與 `data-comot-name`。整段 SVG 用單引號包住、裡面只用雙引號、不能有半形單引號、`&` 寫 `&amp;`：第一頁 `co-motion slide add <presentation-id> --svg '<SVG>'`；接在既有頁面之後時加 `--at <n-1>`；重做某頁用 `co-motion slide set <presentation-id> slides/00N.svg --svg '<SVG>'`。接著把頁面底色與背景圖補上：
      - `co-motion slide style set <presentation-id> slides/00N.svg --background <該頁型指定的角色色碼>`（封面／要點／對照／大數字用 background，章節頁 secondary_bg，結語頁 primary）。章節頁另下 `element style set el-watermark opacity 0.18`。
      - `background` 是 `on`：`co-motion slide background set <presentation-id> slides/00N.svg --asset <該頁型配方的 data.path> --opacity <第 4b 節的建議值>`；是 `off` 就不下（重做某頁而它已有背景、計畫卻是 `off` 時，`--none` 拿掉）。
   4. **group（把一段話變成一個東西）**：依步驟 1 切好的講述步驟與步驟 3 標好的角色，把**同一段裡的元素**（通常就是一個 `node` 連同它的 `field`、`label` 與 `garnish`）組成一個群組：`co-motion element group <presentation-id> slides/00N.svg <元素 id,逗號分隔>`，記下回傳的 `data.elementId`（群組自己的 id）。典型的分法——要點頁每張卡片一組（卡片底＋編號＋要點字）、對照頁左欄一組右欄一組（面板＋頂線＋欄標＋內文）、封面標題與副標一組、大數字頁數字與說明一組。標題自成一段時不必特地開群組。
      - 群組是**邏輯單位**：作者在編輯器裡拖一下就整段一起動，動畫也只要下一次。
      - `element group` 會清掉成員身上既有的效果（回傳的 `removedEffects` 會告訴你幾個），所以**一定要先 group 再套動畫**。
      - 背景圖、頁尾線、頁尾文字、頁碼不進任何群組。
   5. **動畫套用**：依指南第 5 節該頁型的講述步驟，**對群組 id（沒有群組的就對元素 id）**下 `co-motion effect add`——一段一個 `on-click`，一頁不超過 5 個；`animation` 是 `none` 就整段跳過。群組化之後多數頁面只需要 1～4 次 `effect add`，不再需要一長串 `with-previous`。
   6. **檢視頁面**：`co-motion validate <presentation-id> slides/00N.svg` 要 0 錯誤。`validate` 會拿步驟 1 的 `blueprint` 跟實際頁面對帳——`blueprint.nodes` 是畫出來的 node 數不符、`blueprint.steps` 是點擊步數不符。**兩邊不一致時先問哪一邊對**：頁面畫錯就改頁面，構圖當初想錯就改 `blueprint`（用 `plan set outline` 寫回），不要留著不管，也不要為了讓數字好看而亂改構圖。然後補這一頁的收尾：
      - `co-motion slide notes set <presentation-id> slides/00N.svg '<計畫裡的備忘稿，2～5 句口語>'`。
      - 該頁型第一次出現：`co-motion template add <presentation-id> --from slides/00N.svg --name <頁型名>`（cover→`封面`、section→`章節頁`、bullets→`要點頁`、compare→`對照頁`、number→`大數字頁`、closing→`結語頁`）。之後同頁型仍然照這六步重寫整頁（不用範本複製再改字，改字容易漏掉條數與動畫），範本是給作者在 New 面板用的。

5. **第一頁閘門**：先做封面與第一張內容頁，各 `co-motion validate <presentation-id> slides/00N.svg`。有錯誤就**先改做法**（關鍵詞太長就改短、字級或顏色寫錯就改回表上的值、少了動畫就補），確認兩頁都 0 錯誤，才做第 3 頁起。
6. **逐頁建置**：依 `pages` 的順序，一頁做完再做下一頁。頁面只放計畫裡的「頁面關鍵詞」，完整的句子、論證、數據解釋全部進備忘稿。**字數門檻（presentation：標題 ≤ 24 字、每條 ≤ 32 字且 ≤ 2 行、2～7 條、全頁 ≤ 1000 字；其他密度 `validate` 會告訴你）是「明顯誇張」的底線，不是目標**——好的頁面通常遠比它短，但沒有超過就不要為了更短而犧牲把話講清楚。大數字頁的數字、任何名稱與日期只能來自計畫。
7. **整份轉場**：`animation` 不是 `none` 時，第 1 頁一做完就先下一次 `co-motion slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3 --all`（不然第一頁閘門的 `validate` 一定報 `motion.transition`），全部頁面做完再下一次，讓後加的頁也有轉場。
8. **全份驗證，修到 0 錯誤**：`co-motion validate <presentation-id>`。讀 `data.errors[]`，每一筆有 `slide`、`element`、`rule`、`actual`、`limit`、`message`：
   - `text.*`：改短關鍵詞或把句子搬進備忘稿；條數超過就拆頁（同時用 `plan set outline` 補一頁進計畫，`status` 維持 `confirmed`）。單一文字框的字可以用 `text set` 改，改動多就整頁 `slide set --svg` 重寫。
   - `geometry.*`：縮短文字或減少條數，不縮字級、不挪座標。
   - `style.*`：把字級或顏色改回 type_scale／palette 的值（`element style set`）。
   - `structure.*`：補背景、補備忘稿、補登記範本；`structure.scrim` 是某個文字框沒有墊 scrim——把第 4b 節對應的 scrim rect 加進該頁 SVG（放在那個文字框之前）後 `slide set --svg` 整頁重寫，再重新下背景圖與動畫。
   - `roster.*`：頁數或頁型跟計畫對不上，以計畫為準修頁面；計畫本身錯了才改計畫。
   - `motion.*`：補該頁的進場效果或整份轉場。
   - `rhythm.breathing-cards`、`taboo.*`：刪掉多餘的面板、謝謝頁、rect 的框線。
   改完再跑一次 `validate`，直到 `errors` 為空。**有錯誤不得回報完成。**
9. **回報**：照下面的格式。

## 使用的命令

`cat`、`ls`、`plan set`（寫回 blueprint）、`template list`、`template add`、`asset import`、`slide add`、`slide set`、`slide style set`、`slide background set`、`element style set`、`element group`、`effect add`、`slide transition set`、`text set`、`slide notes set`、`validate`。

## 回報格式

先一行：「依計畫建置完成，validate 0 錯誤，動畫 <full／minimal／none>，背景圖 <on／off>」（或做到第幾頁停下的原因）。逐頁一行：`第 N 頁（slides/00N.svg）：<頁型>／<關係>：<標題>——新增 / 覆寫，<node 數> 個單位、<on-click 步驟數> 步`。**`on-click` 步驟數要跟指南第 5 節該頁型的講述步驟對得上**（封面／章節／大數字／結語各 1 步，要點頁 1＋卡片數，對照頁 3 步），對不上就是動畫加錯了，回報前先修好。最後列出給作者的問題，一則一行：哪幾頁建議配圖、哪幾頁內容偏薄、哪幾頁的關係不在頁型表上而退回了要點頁。

## 不可做的事

- **計畫未確認不動手**：`status` 不是 `confirmed` 且訊息沒帶【計畫確認】時，只回一句話。
- **不改計畫的內容判斷**：頁的主張、順序、模式以確認過的計畫為準；只有 `validate` 逼你拆頁時才改 `pages`，而且要寫回檔案。
- **不把整段講稿放上頁面**：一條要點佔到三行、或長得像完整論證，就改短並把句子搬進備忘稿。（門檻見步驟 6：那是底線不是目標。）
- **不自己發明錨點**：配色、字級、安全區、欄間距與間距級距一律取自 `design-spec`——**這幾樣全份一致，不可以逐頁調整**。座標與版面本身不在此列（見步驟 4.3）。背景圖只用第 4b 節的四種配方，不畫插圖、不放圖示、不讓背景承載意義；不自己放 `<tspan>`、不用 `<script>`、不加 rect 框線與陰影。
- **不逐元素拼頁**：`textbox add`／`element insert` 只用來微調一個元素；整頁一律用 `--svg` 寫。
- **不虛構事實**：計畫裡沒有的數據、名稱、日期一個都不准補。
- **不留言**：不對 `comment add` 下手；驗證失敗是自己修，不是留言。
- SVG 或文字含半形單引號時告訴作者這段打不進命令列，請他換寫法。
