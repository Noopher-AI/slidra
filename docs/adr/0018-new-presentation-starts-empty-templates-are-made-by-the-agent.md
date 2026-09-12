# 新簡報零頁；計畫落地成簡報裡的檔案，三個角色經一道擋住式閘門交接，驗證是一條 CLI 命令

`slidra new` 過去會附一張未經設計的佔位頁（白底、48px 置中的簡報名稱），而 `slidra-outline` skill 把大綱直接長成投影片：字級、配色、座標全部要求「照抄第一步讀到的範本頁」，新簡報裡卻沒有任何值得抄的東西。#303 的症狀就是這樣來的：從大綱長出來的投影片看不出設計過，第一次改良後又變成每頁都是完整句子的講稿——因為沒有任何一步逼 agent 在動手前決定「每頁講什麼、放多少、長什麼樣」，也沒有任何一步能客觀地說「這樣不行」。

對照 ppt-master（本專案參考的簡報生成 skill），它的品質來自三層：**規則**（字級比例、色彩角色、密度、節奏）、**流程閘門**（大綱 → 作者確認 → 設計規格鎖定 → 第一頁閘門 → 逐頁產出 → 驗到 0 錯誤才交付）、**角色與中間文件**（strategist／executor／reviewer 各讀各的規範，靠 `outline.md`、`design_spec.md` 交接）。這份 ADR 把三層都搬進 Slidra，但用 Slidra 自己的材料：中間文件住在簡報裡，閘門是編輯器的一個視窗，驗證是一條命令。

決定五件事：

1. **新簡報不附任何投影片。** `slidra new` 只寫 `project.json`（`slides: []`）、內嵌字型與授權文字。零頁簡報在編輯器裡不畫白底投影片，只在舞台中央顯示一行白字「No slides now」，`serve` 不再拒絕零頁；第一頁由作者或 agent 產生。
2. **計畫落地成 `.slidra` 裡的 `plan/` 目錄，固定兩份檔案。** `plan/outline.md`（狀態、敘事模式、逐頁的頁型／節奏／主張、要問作者的題目）與 `plan/design-spec.md`（密度、六角色配色、字級表）。每份檔案開頭一個 JSON 圍欄區塊是機器可讀段，其後是給人與 agent 看的 markdown。只能經 `plan set|list|delete` 寫，經 `cat` 讀；`plan set` 寫入前驗欄位，錯就拒絕。計畫不進 undo 歷史。
3. **三個角色，三個 skill，各自獨立。** `slidra-plan`（讀大綱、挑模式、逐頁計畫、出題、選配色與字級，寫兩份計畫檔後停下）、`slidra-build`（只在計畫為 `confirmed` 時動手：第一頁閘門、逐頁做、每種頁型第一次出現就登記成範本、`validate` 修到 0 錯誤）、`slidra-validate`（只驗只留言）。沒有入口 skill 串它們；`From outline…` 直接送 `/slidra-plan`。`slidra-outline` 刪除。
4. **閘門是編輯器的擋住式視窗。** 計畫檔為 `draft` 且帶題目時，編輯器彈出視窗擋住一切操作：唯讀的逐頁計畫表、每題以 agent 的建議為預設值、可切換的選項與自由填寫。三個出口：「確認並建置」把答案組成一則 `/slidra-build 【計畫確認】` 訊息送回 agent；「重新規劃」必填一段話送 `/slidra-plan 【重做】`；「放棄」不經 agent、直接 `plan delete`。
5. **驗證是 Rust 的 `slidra validate <id> [slide-path]`。** 規則與三組密度門檻寫死在 Rust；配色、字級表、密度、逐頁頁型從計畫檔的 JSON 段讀；沒有計畫檔只驗幾何與骨架。輸出逐條 `{ slide, element, rule, actual, limit, message }`，有錯 exit 1。skill 只負責解讀與修正，不再自己算字數與座標。

6. **一頁一份 SVG。** `slide add --svg`／`slide set --svg` 接受整頁 SVG，寫入時跑正規化與合規檢查（拒絕 `<script>`／`<foreignObject>`，允許 `<defs>`、漸層、濾鏡、path），並把帶 `data-slidra-text-width` 的裸 `<text>` 宣告轉成真正的文字框（換行、清單、可就地編輯，`validate` 看得到）。build 的主要動作是「照 SVG 作者指南寫一頁、寫入、驗證」，逐元素命令退為微調工具。這正是 ppt-master 的 executor 模型，也是「炫砲」得以發生的前提：命令集能拼出的版面有限，SVG 能寫出的沒有。
7. **一種視覺語言＋動畫預設開。** `reference/slide-design.md` 改寫成「編輯／科技」語言的 SVG 作者指南：固定舞台（出血的大圓、頁尾與動態頁碼）、六種頁型各一份完整 SVG、每種頁型的進場腳本；build 依計畫的 `animation`（full／minimal／none，計畫視窗多一題）套 `effect add` 與整份 fade 轉場。動畫是 Slidra 相對於匯出型工具的差異化能力，所以預設開。

8. **背景圖是資產＋鎖定的滿版圖片元素。** `asset import --svg` 讓 agent 從命令列內容建立 SVG 資產（它不能寫檔），`slide background set --asset` 把它以鎖定、`data-slidra-role="background"` 的滿版 `<image>` 放在該頁最底層。走既有的資產、圖片、鎖定、排序機制，編輯器裡是一個物件，同一張圖可被多頁共用。指南提供四種背景配方，`validate` 以 `structure.scrim` 保證有背景圖的頁面上文字仍坐在半透明面板上。否決：頁面屬性 `--background-image`（三條渲染路徑要各自處理）、把背景畫成整頁 SVG 最底層的幾十個原件（誤選、不能共用、不能一鍵換掉）。
9. **同一份簡報的命令由 CLI 互斥。** agent 會平行送出多條命令；兩個行程同時讀改寫同一個 SVG 會寫壞 `<slidra:effects>`。每個 `slidra` 命令在解析出簡報後取得該簡報的檔案鎖，直到行程結束；平行呼叫因此安全但改為排隊。

## 為什麼範本要現做而不是出貨一套

出貨一套範本的問題是它在知道作者需求之前就畫好了：主題、語氣、配色全部固定，agent 拿到後最多換色改字級。範本由 build 依計畫現做、再用 `template add` 登記，樣式跟著作者的大綱與作者在閘門的選擇走，而且用的全是既有命令，不動容器格式。登記成範本保留了 ADR-0013 的產品概念：人在 New 面板的 Layouts 裡看得到、`slidra-new-slide` 之後也拿同一套。「`new` 內建一套中性範本」延後到 #304，作為不經 agent 時的起手式。

## 為什麼閘門是視窗而不是對話慣例

對話裡貼一張表請作者回「OK」，作者直接叫 `/slidra-build` 時沒有任何東西擋，閘門形同不存在；讓 build 自己再問一次則要按兩次。視窗把「這一步需要作者裁決」做成產品行為：agent 的建議是預設值，作者看完按一個鍵，答案以固定格式回到對話，build 據此把計畫改成 `confirmed`。擋住式是刻意的：計畫沒定案前改投影片沒有意義；「放棄」是唯一不經 agent 的出口，保證作者永遠離得開。

## 為什麼驗證是命令而不是 skill 裡的表

ppt-master 的檢查器是 script，不是靠模型憑印象；我們第一版 `slidra-validate` 讓 agent 自己數字數、算 `y + 行數 × 1.45 × 字級`，正是它避開的做法。門檻寫進 Rust 之後，agent 拿到的是「第 2 頁第 3 條 23 字，上限 18 字」這種可執行的錯誤，而不是一份要它自己對的表。

## Considered Options

- **`new` 內建一套中性範本**：不經 agent 的人也有得選，最穩定可測；但風格寫死、與作者需求無關。延後到 #304，不取代現做。
- **工作目錄放一個「多風格 × 多頁型」SVG 圖庫，由 skill 用 `element paste --svg-file` 貼進去**：理論上最靈活，但貼的是元素不是整頁，人在編輯器裡看不到這個圖庫，等於繞過「範本」概念。
- **保留佔位頁，由 skill 判斷「還沒動過」就覆寫成封面**：判斷條件脆弱，作者改過一個字就失效；零頁簡報前端與 CLI 本來就撐得住。
- **只做規則層，不做閘門與角色**：這次失敗的根源（動手前沒有計畫、做完沒有客觀驗證）不會解決。
- **計畫只存在對話裡**：換 agent、換機器、隔天再開就沒了；validate 也拿不到「這份簡報的規則」。
- **計畫存在 `project.json` 欄位**：長 markdown 塞進 JSON 難讀，`cat project.json` 會把畫布設定與整份計畫混在一起。
- **一個入口 skill 串 plan → build**：ppt-master 的 routing 做法；但閘門已由視窗承擔，串接反而讓「重做某幾頁」「單獨驗證」這些單獨呼叫變彆扭。
- **視窗可關閉、狀態列徽章重開**：較柔和，但作者會在計畫未定時改投影片，閘門失去意義。
- **frontmatter 用 YAML**：最像 ppt-master，但 crate 沒有 YAML 相依，且 YAML 的單引號習慣跟命令列的單引號限制互相絆。
- **`validate` 規則全寫死、不讀計畫檔**：作者自訂的配色會被判錯，計畫檔對驗證沒有作用。
- **讓 agent 直接寫檔**：一頁一份 SVG 最直接的做法，但推翻 ADR-0004；`--svg` 旗標保住「所有修改走命令」，寫入前還能正規化與拒絕。
- **裸 `<text>` 由 agent 自己排每一行**：Rust 改動最小，但文字不會換行、沒有清單、編輯器裡不是文字框、`validate` 看不到字數。

## Consequences

- 每一個「`new` 之後直接動 `slides/001.svg`」的測試與腳本都要先 `slide add`；`docs/spec/cli.md` 的 `new` 一節寫明零頁。
- 命令數從 81 變 85（`plan set|list|delete`、`validate`）；`docs/spec/slidra-format.md` 加 `plan/` 一節；`reference/commands.md` 同步。
- `reference/slide-design.md` 與 `reference/modes.md` 是設計能力的規格：新增頁型、配色、模式＝在表上加一列，並同步 `validate` 的規則與 `slidra-plan` 的挑法。
- `From outline…` 之後的體驗是：貼大綱 → agent 寫計畫 → 視窗 → 按確認 → agent 建置到 0 錯誤。品質仍取決於 agent 是否照計畫做，但每一步都有東西可查：計畫檔、視窗的答案、`validate` 的錯誤清單。
- 前端多了一個會擋住整個編輯器的狀態；任何與 `plan/` 有關的變更事件都要讓視窗正確開關。
- 命令數再加一（`slide set`）；`slide add` 多 `--svg`。文字框宣告是**輸入形式**，不是儲存形式——存進 `.slidra` 的永遠是 `textbox add` 那種結構。
- 視覺語言目前只有一種（`design-spec.visual: editorial-tech`），第二種語言＝再寫一份指南並讓 plan 出題選擇。
