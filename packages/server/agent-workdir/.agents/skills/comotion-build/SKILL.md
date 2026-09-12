---
name: comotion-build
description: 依作者確認過的 plan/ 計畫與設計規格逐頁建置投影片：一頁寫一份 SVG、群組、套動畫、登記範本，第一頁閘門，最後 comotion validate 修到 0 錯誤才回報。作者的訊息以 /comotion-build 開頭時用（確認視窗送出的【計畫確認】、終端機直接叫建置、或「重做第 N 頁」）
---

# 依計畫建置投影片

你是**執行者**。計畫（`plan/outline.md`）與設計規格（`plan/design-spec.md`）已經由 `comotion-plan` 寫好、作者在確認視窗拍板；你的工作是把每一頁**一頁寫成一份 SVG**、群組、套動畫，做到 `comotion validate` 回 0 個錯誤。**計畫沒確認就不動手。**

## 輸入

確認視窗送出的訊息長這樣：

```
/comotion-build 【計畫確認】
<題目 id>=<選項 value>
<題目 id>.note=<作者自由填寫的文字>
補充：<整體意見>
```

- 只有 `/comotion-build`：作者在終端機直接叫你建置，計畫必須已經是 `confirmed`。
- 後面接頁碼或頁碼範圍：只重做那幾頁（整頁 `slide set --svg` 覆寫），計畫同樣必須是 `confirmed`。

## 步驟

1. **讀計畫**：`comotion cat <presentation-id> plan/outline.md`。沒有這個檔 → 停下來說「還沒有計畫，請先 /comotion-plan」。
2. **處理確認**：
   - 訊息帶【計畫確認】：把每題答案套進計畫的 JSON 段（`mode`／`animation`／`background` 題改對應欄位；`page-N` 題改該頁；`palette` 題改 `design-spec.md` 的 `palette`；`.note` 與「補充」的內容改進該頁正文的關鍵詞或備忘稿），`questions` 清空，`status` 改成 `confirmed`，`comotion plan set <presentation-id> outline '<全文>'` 寫回（配色有改就也 `plan set design-spec`）。
   - 沒有【計畫確認】且 `status` 不是 `confirmed`：停下來回「計畫還沒確認，請先在確認視窗拍板」。
   - 帶【計畫確認】、但計畫已經是 `confirmed` 而且 `comotion ls <presentation-id> slides` 已有投影片：同一次確認被送了兩次。回「這份計畫已經建置過了（目前 N 頁）。要重做請說「重做第 X 頁」或「全部重做」」，然後停下——硬要重建會覆蓋作者手上的頁面。
3. **讀規格與現況**：`comotion cat <presentation-id> plan/design-spec.md`（配色、密度、字級表、`layout`、`shape_language`）、`comotion cat <presentation-id> project.json`（畫布，`k = width ÷ 1280`）、`comotion template list <presentation-id>`、`comotion ls <presentation-id> slides`。讀 `reference/slide-design.md` 第 0～5 節，與 `.agents/skills/comotion-style-kit/shapes/<shape_language>.md` 的「怎麼做到」——整份每一頁都照那一種形狀語言。
   計畫 `background` 是 `on` 時**先把背景資產建好**：配方是計畫背景題 `note` 裡那一個（`comotion-background-kit` 的目錄），照它的步驟 `asset import --svg`，一種配方只建一次，記下 `data.path`。
4. **一頁怎麼做**（六個階段，照順序；前一階段沒做完不跳下一階段）
   1. **構圖**：計畫給了這一頁的 `relationship`，版面是你的決定。先讀第 6.1 節該關係「幾何要承載的東西」；再 `cat plan/outline.md` 看第 N−1 頁的 `blueprint.shape`——**關係相同時這一頁必須換一個 shape**；然後照 `comotion-layout-kit` 的索引在該關係那一組挑一個，只讀中選的那一個參考檔。決定語意單位數（`nodes`）與講述步驟數（`steps`）；想不出「這一頁分幾段講」就代表內容還沒理清楚，回去看計畫。把結論寫回 `plan/outline.md` 這一頁的物件（`status` 維持 `confirmed`）：

      ```json
      { "n": 3, "relationship": "order", "rhythm": "dense", "title": "…",
        "blueprint": { "shape": "spine-path", "nodes": 4, "steps": 4 } }
      ```

      挑到的 shape 剛好是第 6.3 節某個已知解時才順手寫 `"type"`；自己組的構圖不寫 `type`。**每一頁的 `blueprint` 都是必填**（`blueprint.required`）。
   2. **背景**：`background` 是 `on` 時用步驟 3 建好的資產；`off` 就跳過。
   3. **前景**：照版面參考檔的槽位表排——座標與比例由這一頁的內容與 `design-spec.layout` 推導，線框裡的數字是示意；字級與顏色取自字級表與配色；間距取自 `layout.gutter` 與 `layout.spacing`。每個元素標 `data-comot-role`（第 3b 節），所有文字用文字框宣告（第 0 節），`<role>` 換成色碼，範例文字換成計畫裡的關鍵詞（標題＝主張）。`background` 是 `on` 時把 scrim rect 一起寫進去（第 4b 節）。第一頁 `comotion slide add <presentation-id> --svg '<SVG>'`；接在既有頁面之後時加 `--at <n-1>`；重做某頁 `comotion slide set <presentation-id> slides/00N.svg --svg '<SVG>'`。接著：
      - `comotion slide style set <presentation-id> slides/00N.svg --background <角色色碼>`：多數頁面用 `background`；結語頁用 `primary`。同一份簡報裡底色的變化本身就是一種訊號，只在刻意時才換。
      - `background` 是 `on`：`comotion slide background set <presentation-id> slides/00N.svg --asset <data.path> --opacity <配方建議值>`；重做某頁而它已有背景、計畫卻是 `off` 時，`--none` 拿掉。
   4. **群組**：把同一段裡的元素（通常是一個 `node` 連同它的 `field`、`label`、`garnish`）`comotion element group <presentation-id> slides/00N.svg <元素 id,逗號分隔>`，記下回傳的 `data.elementId`。標題自成一段時不必開群組；背景圖與頁尾三件不進任何群組。
   5. **動畫**：依第 5 節對群組 id 下 `comotion effect add`——一段一個 `on-click`，一頁不超過 5 個；`animation` 是 `none` 就整段跳過。
   6. **檢視**：`comotion validate <presentation-id> slides/00N.svg` 要 0 錯誤。`blueprint.nodes`／`blueprint.steps` 對不上時改頁面（補或拿掉 node、補或拿掉 `on-click`）——頁面一旦畫出來，那一頁的 `blueprint` 就是唯讀的，`plan set` 會擋；構圖當初真的想錯了（例如整頁換了版面）才加 `--force` 改，並在最後的回報裡告訴作者你改了什麼、為什麼。然後收尾：
      - `comotion slide notes set <presentation-id> slides/00N.svg '<計畫裡的備忘稿，2～5 句口語>'`。
      - 該頁型（有 `type` 的頁）第一次出現：`comotion template add <presentation-id> --from slides/00N.svg --name <範本名稱>`（名稱見第 6.3 節）。之後同頁型仍然照六階段重寫整頁；範本是給作者在 New 面板用的。

   **中途發現內容需要別的版面時**（臨時多了影片、圖、一組數據，或內容其實是循環、漏斗、金字塔）：回版面庫依「依素材找版面」重挑，並同步改 `blueprint.shape`、`nodes`、`steps`（已畫出來的頁要 `--force`，回報裡說明）。素材還不存在時先用不需要素材的版面，素材到了再 `slide set --svg` 換掉。

5. **第一頁閘門**：先做封面與第一張內容頁，各 `validate`。有錯誤就先改做法（關鍵詞太長就改短、字級或顏色改回表上的值、少了動畫就補），確認兩頁都 0 錯誤，才做第 3 頁起。
6. **逐頁建置**：依 `pages` 的順序，一頁做完再做下一頁。頁面只放計畫裡的「頁面關鍵詞」，完整的句子進備忘稿；第 7 節的上限是底線不是目標。大數字頁的數字、任何名稱與日期只能來自計畫。
7. **整份轉場**：`animation` 不是 `none` 時，第 1 頁一做完就先下一次 `comotion slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3 --all`（不然第一頁閘門一定報 `motion.transition`），全部頁面做完再下一次，讓後加的頁也有轉場。
8. **全份驗證，修到 0 錯誤**：`comotion validate <presentation-id>`，每一筆錯誤照第 9 節那張表的「怎麼修」處理。`text.*` 的條數超過要拆頁時，用 `plan set outline` 補一頁進計畫——接在最後面加頁不受限，插在中間會讓後面每一頁往後移，要加 `--force`。改完再跑一次，直到 `errors` 為空。**有錯誤不得回報完成。**
9. **回報**：照下面的格式。

## 計畫的保護欄位

計畫確認之後，`mode`／`animation`／`background`、既有頁的 `relationship`／`rhythm`／`title`、以及刪頁，`plan set` 一律擋下——這些是作者在閘門上答過的題目，要改就回頭問作者。你自己能改的只有：第一次寫某頁的 `blueprint`、還沒畫的頁、`type`、在最後面加頁。

## 回報格式

先一行：「依計畫建置完成，validate 0 錯誤，動畫 <full／minimal／none>，背景圖 <on／off>」（或做到第幾頁停下的原因）。逐頁一行：`第 N 頁（slides/00N.svg）：<shape>／<關係>：<標題>——新增 / 覆寫，<node 數> 個單位、<on-click 步驟數> 步`。最後列出給作者的問題，一則一行：哪幾頁建議配圖、哪幾頁內容偏薄、哪幾頁你用 `--force` 改了什麼。驗證失敗是自己修，不留言。
