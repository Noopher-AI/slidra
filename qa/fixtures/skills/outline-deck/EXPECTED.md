初始頁數：2（`slides/001.svg`／`002.svg` 是兩張沒有設計過的範本頁，直接 `ls` 這份未執行過的 fixture 會看到 2 頁，這是預期的初始狀態）。

流程分兩段：先 `/slidra-plan 【從大綱規劃】目前有 2 頁，新頁接在最後。` 加上 `INPUT.md` 的內容，agent 寫好 `plan/` 後停下；作者在確認視窗（或終端機）拍板後送 `/slidra-build 【計畫確認】…`，agent 才建置。

## 計畫階段必須符合

- `cat <presentation-id> plan/outline.md` 讀得到：`status` 是 `draft`，`pages` 只涵蓋新頁且 `n` 從 3 起算，每頁都有 `relationship` 與 `rhythm`，沒有 `type`、沒有 `blueprint`。
- 4 個小節各一頁再加封面（與結語，若 agent 認為大綱有結論），關係至少涵蓋兩種——「核心功能」三條並列是 `membership`，「定價方案」的免費／付費是 `contrast`。
- `questions` 第一題問敘事模式、最後兩題是 `animation` 與 `background`；每題都有 `recommended`。
- `cat <presentation-id> plan/design-spec.md` 讀得到七個配色角色、`type_scale`、`typography`、`shape_language`。
- 沒有任何 `slide`、`textbox`、`element` 命令被執行：`ls <presentation-id> slides` 仍是 2 頁。

## 建置階段必須符合

- `validate <presentation-id>` 結束碼 0、`errors` 為空。
- 每一頁 `<slidra:notes>` 非空，內容是口語句子，不是頁面文字的重抄。
- 頁面上的字是計畫裡的關鍵詞，不是 `INPUT.md` 逐字照抄；也不得含 `INPUT.md` 沒有的數字、公司名、日期、價格、承諾。
- `plan/outline.md` 每一頁都補上了 `blueprint`，相鄰兩頁 `shape` 不同。
- `template list <presentation-id>` 至少列得出「封面」。
- `comment list <presentation-id>` 仍是「共 0 則留言」——build 自己修，不留言。

## 對話裡必須出現

- 計畫階段：一張 `頁碼｜關係｜節奏｜主張` 的表，以及「計畫已寫進 plan/」那一句。
- 建置階段：逐頁的回報（`第 N 頁（slides/00N.svg）：<shape>／<關係>：<標題>——新增，<node 數> 個單位、<步數> 步`），以及至少一則給作者的問題——這份 `INPUT.md` 每個小節只有兩三條短要點，屬於「局部偏薄」，agent 應提出「哪幾頁建議補什麼內容」或「哪幾頁建議配圖」。

## 不算通過的樣子

- plan 階段就動了投影片，或計畫沒確認 build 就開工。
- 計畫寫了 `type` 或 `blueprint`（那是 build 的事）。
- `validate` 有錯誤卻回報完成。
- 擴寫時編出 `INPUT.md` 沒有的數據、名稱或承諾。
- 每頁都用同一種 `shape`。
- 全程沒有對作者提出任何問題。
