# 環境檔 — CoMotion

這台機器與這個專案對 agent 做的事。每一條都是「不寫下來就會被重新踩一次」的事實。
產品行為不寫在這裡（那是 ticket / ADR / 測試）；單次戰役的決定也不寫在這裡（那是 plan record 的 軍令）。

## 工具與指令

- **測試**：`npm test`（vitest，unit）；`npm run test:e2e`（`vitest run --config e2e/vitest.config.ts`，Playwright）。
  `npm run typecheck` 會跑 `tsc -b` 加 `tsc -p packages/web --noEmit`。
  觀察者：指揮官 2026-08-25，讀 `package.json`。
- **e2e 服務的是預先建好的 `packages/web/dist`**，`requireBuilt` 只檢查存在、不重建也不比對新舊。
  **改任何前端外觀後，跑 e2e 前必須先 `npm run build`**，否則會綠燈通過一個根本沒被測到的變更。
  觀察者：#48 戰役 wave 1 指揮官 2026-08-25（見 `.fleet/plans/plan-20260825-0003-82f26890.md` 02:27）。
- **全新 worktree 沒有 `node_modules`**。波指揮官要在派出執行者前，於該 worktree 先跑一次 `npm install`。
  觀察者：#48 戰役 wave 3／wave 5 2026-08-25。
- 截圖基準只活在 `e2e/__screenshots__/`，不進 `npm test`；視窗尺寸寫死，只在 Playwright 自帶的 Chromium 下成立。

## 陷阱

- **headless Chromium 的 `screen` 跟著 viewport 走**，兩者恆等。想讓「全螢幕前後尺寸不同」成立，
  靠的是 viewport **長寬比不是 16:9**（16:9 時播放態已滿版），不是「viewport 比螢幕小」。
  觀察者：#48 戰役 波4 實測 2026-08-25（`vp=900x600 → screen=[900,600]`）。
- **這個 host 的 `Agent` 工具沒有 `name` 參數**（schema 只有 description / prompt /
  subagent_type / model / isolation）。派工單裡寫「你的名字是 X」不會註冊那個名字，
  `SendMessage` 用該名字送會得到 `No agent named '...' is reachable`。
  **可用的地址是 `ListAgents` 列出的內部識別碼**，主要進度訊號是**分支 tip**。
  觀察者：指揮官 2026-08-25 實測（`SendMessage to: comotion-w1` 被拒，`ListAgents` 只列 id）。
  相關的舊事實：執行者本來就無法用 agent type 當地址回報（跨兩場戰役共 5 次重新發現）。
- `ListAgents` 不是每個 session 都註冊得到；「確認 agent 已離開清單」這一步常常根本做不到。
  可靠的訊號是**分支 tip 不再變動**。
- 專案根目錄的 shell hook 會把 `git` 改寫成 `rtk git`。輸出格式與原生 git 不同，判讀前先確認。
  觀察者：使用者全域 `RTK.md`。
- **`page.evaluate()` 裡真的寫一個 dynamic `import(...)`，Vitest 會把它改寫成
  `__vite_ssr_dynamic_import__`（Vitest 對整個測試檔案做的 SSR transform），但
  `page.evaluate` 是把 callback 的原始碼字串化後丟進 Chromium 執行，瀏覽器裡沒有這個
  符號 → `ReferenceError: __vite_ssr_dynamic_import__ is not defined`。
  **對策**：在 callback 裡用 `new Function("specifier", "return import(specifier)")`
  組出一個「動態 import 器」再呼叫它——因為 `import(...)` 只是字串內容，不是原始碼裡
  真正的 import 語法，Vitest 的 transform 掃不到它，瀏覽器端 `new Function` 產生的
  函式本身才會被瀏覽器的 module loader 解析成真正的 import。
  觀察者：#76 戰役 comotion-w1-textbox 2026-08-26（`e2e/text-wrap.test.ts` 第一次跑
  6/8 測試都是這個 ReferenceError，換成 `new Function` 寫法後全線變綠）。

- **`fleet-mutation-check.sh` 開的臨時 worktree 也沒有 `node_modules`**，於是 `npm test` 直接
  `sh: vitest: command not found`，腳本判為「單元本來就不綠」exit 2，**一個字都沒驗到**。
  **對策**：`--test` 字串前面自己補一次安裝，例如
  `--test 'npm install --no-audit --no-fund >/dev/null 2>&1; npm test -- <files>'`。
  不要改成 symlink 主 worktree 的 `node_modules`：npm workspaces 會把 `@comotion/*` 連回
  **那一份** worktree 的 `packages/`，於是變異檢查會去測沒被回退的程式碼，永遠是綠的。
  觀察者：波2 2026-08-26 10:15。

## 這台機器

- 專案根：`/Users/yi-changchen/Workspace/comotion`。worktree 一律放同層兄弟目錄
  `/Users/yi-changchen/Workspace/comotion__worktree__<unit>`，不得放在 repo 內。
- `.fleet/` 目前整個被 `.gitignore` 忽略；本檔要被版控需要一條例外規則（見本戰役 未結）。

## 已知壞掉的東西

- ~~**`subset-font` ... 沒有被裝出來**~~ → **更正：壞的是主 repo 的 `node_modules`，不是相依宣告。**
  `subset-font@^2.5.0` 自 `c1ae3b7`（#49）起就在**根 `package.json` 的 devDependencies** 與
  `package-lock.json` 裡，base commit `600167c` 也帶著它。
  **主 repo `/Users/yi-changchen/Workspace/comotion/node_modules` 是舊的**，裡面沒有 `subset-font`
  （`npm --prefix <主repo> ls subset-font` → `(empty)`；`ls node_modules/subset-font` → No such file）。
  但**任何新 worktree 跑完 `npm install` 就會裝出 `subset-font@2.5.0`**
  （實測 `/Users/yi-changchen/Workspace/comotion__worktree__70-b1-fonts` → `└── subset-font@2.5.0`）。
  後果一：`scripts/build-font-subset.mjs` 在**主 repo** 跑不起來，在 worktree 跑得起來；
  修法是在主 repo 跑一次 `npm install`，不是加相依。
  後果二：**「改用 `subset-font` 會加一個新依賴」這個前提不成立**——它已經是既有 devDependency。
  觀察者：波1 指揮官 2026-08-25 18:1x 自跑（`git show 600167c:package.json`、兩地 `npm ls` 對照）。

## Gate 工具的已知缺口

- **`--must-execute` 只保護「通過」，不保護「不通過」。**
  `fleet-codex-review.sh` 的 `finish()` 裡是一行字面守衛：
  `if (mustExecute && code !== 1) { ...; process.exit(6) }`。
  也就是說**當回合有 blocking finding（exit 1）時，must-execute 的檢查被明確跳過**。
  後果：一個**什麼都沒執行**、卻剛好挑到一條 blocking finding 的回合，會以正常的 exit 1
  走完流程，而它對執行期行為其實一個字都沒驗——外觀與一個真的跑過專案的回合無法區分。
  **對策**：帶 `--must-execute` 的單元，每一輪都要讀 `execution:` 那一行；
  若是 `NONE` 或 `NONE CLAIMED`，該輪就**不算執行輪**，執行期保證必須由波指揮官自己驗。
  觀察者：波1 2026-08-25 18:5x（`geometry-72` round 1：帶 `--must-execute`、sandbox
  `workspace-write`、exit 1、`execution: NONE CLAIMED`，payload 內 `npm test`／`vitest`／
  `node ` 皆 0 命中）；指揮官自跑複驗腳本第 383 行的 `code !== 1` 守衛屬實。

### 補充：`--must-execute` 兩個方向都會失真

環境檔上一節記的是**漏報「沒執行」**（exit 1 跳過檢查）。波 1 round 2 證實還有反向：
reviewer **確實跑了**（`font-metrics` 43/43、build、typecheck，並獨立重現了一個缺陷），
但證據寫在 `next_steps`／`summary`／finding body 裡，而 `execution:` 偵測器不讀那幾處，
於是仍判 `NONE CLAIMED`。
**結論不變、但理由更強**：`execution:` 這一行兩個方向都不可信，執行期保證一律由波指揮官自驗。
觀察者：波1 2026-08-25 22:xx（`fonts-71` round 2 兩次皆 exit 6）。

### 補充二：`--must-execute` **不會**自己打開 sandbox

腳本註解說 `--must-execute`「both switches the sandbox on and REFUSES to report a pass...」，
**在這個 build 上前半句不成立**。只帶 `--must-execute` 而沒有設環境變數時，reviewer 仍在
**read-only** sandbox 裡跑，什麼都執行不了，於是必定 exit 6，該回合白跑。
腳本自己的 log 會先警告：`--must-execute on a read-only reviewer: it cannot run anything,
so expect exit 6 / set CODEX_REVIEW_SANDBOX=workspace-write (needs --adversarial)`。
**對策**：凡帶 `--must-execute`，派令裡必須同時寫
`CODEX_REVIEW_SANDBOX=workspace-write /path/to/fleet-codex-review.sh --adversarial --must-execute ...`。
好消息：exit 6 的回合**不算消耗回合上限**，腳本明講「fix why it could not run and re-run the SAME round」。
觀察者：波1-fix 2026-08-25 22:5x（`geometry-fix` round 3 第一次嘗試，exit 6，payload 仍寫出但 execution 為 NONE）。

## 派工檔案送不到執行者手上

- **`.fleet/briefs/**` 永遠不會出現在執行者的 worktree**，`.fleet/environment.md` 也只在
  「該 worktree 的 base commit 之後才被 commit」時才在。根目錄 `.gitignore` 第 13–14 行是
  `.fleet/*` 加 `!.fleet/environment.md`：**briefs 整個被忽略**，所以它只活在主 checkout 的
  工作目錄裡，`git worktree add` 不會帶過去；而 `environment.md` 雖然是追蹤檔，卻是在
  `fef5ba7`（main）才進版控的，任何從 `fef5ba7` 之前的 commit 長出來的分支（本戰役的
  `fleet/70-*` 全系列都是）checkout 出來就是**沒有這個檔**。
  **後果**：派工單裡寫「先讀 `.fleet/briefs/<...>.w<N>.md` 和 `.fleet/environment.md`」的執行者，
  兩個都讀不到，於是它**完全沒學到本檔記的任何陷阱**，而且它「附加到環境檔」的內容會寫進
  worktree 裡一個新建的同名檔案，隨 worktree 一起消失——沒有人會再讀到。
  **對策**（波指揮官的責任，派出前做）：(a) 把 brief／rulings／owns 以**主 checkout 的絕對路徑**
  寫進派工單，或直接 `cp` 進該 worktree；(b) 派工單裡把環境陷阱**內嵌**，不要只給路徑；
  (c) 執行者交回後，把它回報的環境發現**由波指揮官自己**附加到主 checkout 的本檔。
  同理，`fleet-codex-review.sh --spec/--rulings` 一律給主 checkout 的絕對路徑。
  觀察者：波3 2026-08-26 13:3x（執行者 `70-b5w1-slide-ops` 的止步點第 4 條；
  `git check-ignore`、`git ls-tree ec42b01 -- .fleet` 與 worktree 內實測三者一致）。

## worktree 會在你還在用的時候被回收

- **磁碟一滿，worktree 就可能被人為刪掉**，而且是在波指揮官還在跑驗證、gate 還在讀工作樹的時候。
  2026-08-26 波3 實際發生：`comotion__worktree__70-b5w1-slide-ops` 在 gate round 1 進行中被刪除。
  **commit 沒事**——分支 ref 活在主 repo 的 `.git`，不在 worktree 裡；被刪的只是工作目錄。
  **復原步驟**：`git worktree prune`（git 多半已自動察覺）→ 確認 `git log -1 <branch>` 還在 →
  **`git worktree add <sibling-path> <existing-branch>`**（注意：**不能用 `fleet-worktree.sh`**，
  它對已存在的分支會 `refusing: branch already exists`，它只管開新分支）→ `npm install` →
  重跑一次驗證。
- **`fleet-codex-review.sh` 讀的是工作樹**，所以每一輪 gate（含補審）都需要該 worktree 存在。
  工作樹不見時該輪回 **exit 4（precondition failed，什麼都沒審）**，而 **exit 4 不消耗回合上限**，
  重跑同一輪即可——不要把它當成一輪用掉。
- 推論：長時間的波，把執行者的 commit **推上 remote** 就不再怕本地目錄被回收。
  觀察者：波3 2026-08-26 13:4x。

## 刪掉 worktree 會讓該單元的 gate 永久壞掉（broker 孤兒）

- `fleet-codex-review.sh` → `codex-companion.mjs` **不是每次都新開 codex**，而是重用一個
  **長駐的 `app-server-broker.mjs` daemon，以 worktree 路徑為鍵**
  （`ps aux | grep app-server-broker.mjs` 看得到一整排，每個帶 `--cwd <worktree>`）。
- **一旦該 worktree 被刪除再重建，那個 daemon 的 cwd 就吊在「已刪除的舊 inode」上**，
  之後每一輪 gate 都會以
  `failed to load configuration: No such file or directory (os error 2)` → **exit 4** 收場，
  payload 0 bytes、什麼都沒審。**這是決定性的，不是暫時性的**：重跑幾次都一樣壞。
  誤判成「暫時性、再試一次」會白白燒掉兩輪與大量時間（波3 就是這樣燒掉兩次）。
- **判定方法**（不要用路徑字串比對，重建後路徑字串一模一樣，要比 inode）：
  ```
  ps aux | grep app-server-broker.mjs | grep <unit>      # 取 pid
  lsof -a -p <pid> -d cwd -Fin                            # i<inode> 是 daemon 抓著的
  stat -f "inode=%i" <worktree>                           # 現在這個目錄的
  ```
  兩個 inode 不同 → 就是它。
- **修法**：`kill <broker-pid>`，確認 `ps aux | grep app-server-broker.mjs | grep <unit>` 沒有殘留，
  companion 下次就會用新目錄開一個新的。**exit 4 不消耗回合上限**，修好後重跑同一輪即可。
- **預防**：gate 還有回合要跑時不要刪該 worktree；真的刪了，**先殺 broker 再重跑**。
  觀察者：波3 2026-08-26 14:0x（round 2 連兩次 exit 4；以 PATH shim 逐一攔截 codex 呼叫排除
  `codex --version`／`app-server --help`／兩個 codex binary 皆正常後，才在 broker 上找到 inode 不符：
  daemon `168278364` vs 現地 `168554863`，pid 61779，殺掉後解決）。

## `fleet-wave-dispatch.sh` 產出的 brief 可能比派工單內嵌的正文短

- 2026-08-26 波4 實測：`.fleet/briefs/<plan>.w4.brief.md` 磁碟上只有 80 行、內容**停在 R3**，
  而同一份 brief 在 `.w4.dispatch.md` 的 §3 內嵌正文是完整的（R1–R8＋§2–§8 裁決，290 行）。
  派工單的 lint（exit 0、no unfilled slots）**不會抓到這件事**——它檢查的是 slot，不是兩份的一致性。
- **後果**：`--spec` 指向那份短檔就等於拿一份缺了一半、且不含任何裁決的 brief 去開輪，
  reviewer 會對著已經不適用的規則產出 finding，而它們讀起來像真的。
- **對策**（開輪前做）：`wc -l` 比對 brief 與派工單 §3 內嵌段落；不一致就以**派工單內嵌正文為準**重建 brief
  （`sed -n '<start>,<end>p' <dispatch> | sed 's/^###### /### /' … > <brief>`），舊檔留 `.bak`。
- **`--rulings` 的檔案格式是機器格式，不是散文**：
  `<id> <ISO-8601-UTC> amends=<ac-label|none> <一行文字>`。指揮官手寫的散文裁決檔會被
  `fleet-rulings.sh` 判 `malformed ruling line`。要自己轉寫，且 **id 必須在 brief 裡逐字出現**、
  **brief 的 mtime 必須比最新裁決新**（所以先重建 brief、再寫 rulings，順序反了就 check 失敗）。
  觀察者：波4 2026-08-26 14:31。
