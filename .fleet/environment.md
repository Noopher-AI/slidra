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

## 這台機器

- 專案根：`/Users/yi-changchen/Workspace/co-motion`。worktree 一律放同層兄弟目錄
  `/Users/yi-changchen/Workspace/co-motion__worktree__<unit>`，不得放在 repo 內。
- `.fleet/` 目前整個被 `.gitignore` 忽略；本檔要被版控需要一條例外規則（見本戰役 未結）。

## 已知壞掉的東西

- ~~**`subset-font` ... 沒有被裝出來**~~ → **更正：壞的是主 repo 的 `node_modules`，不是相依宣告。**
  `subset-font@^2.5.0` 自 `c1ae3b7`（#49）起就在**根 `package.json` 的 devDependencies** 與
  `package-lock.json` 裡，base commit `600167c` 也帶著它。
  **主 repo `/Users/yi-changchen/Workspace/co-motion/node_modules` 是舊的**，裡面沒有 `subset-font`
  （`npm --prefix <主repo> ls subset-font` → `(empty)`；`ls node_modules/subset-font` → No such file）。
  但**任何新 worktree 跑完 `npm install` 就會裝出 `subset-font@2.5.0`**
  （實測 `/Users/yi-changchen/Workspace/co-motion__worktree__70-b1-fonts` → `└── subset-font@2.5.0`）。
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
