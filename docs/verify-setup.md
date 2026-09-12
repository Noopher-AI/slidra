# 驗證前置（`npm run verify:setup`）

這份文件只寫 `npm run verify:setup` 涵蓋不到、或執行時容易誤解的部分。步驟本身
（安裝、建置、前置檢查、準備簡報、啟動）不在這裡重述，跑 `npm run verify:setup --help`
看。

## 為什麼每次改前端都要重建

`slidra serve` 只吃 `apps/web/dist` 的靜態檔，沒有 dev server proxy
（ADR-0002）。改了 `apps/web` 的原始碼卻用 `--skip-build` 重跑，畫面上看到的
會是舊的建置產物。`--skip-build` 只在完全沒動前端原始碼時可用。

## PATH 的作用範圍到哪為止

`export PATH=".../node_modules/.bin:$PATH"` 只影響本腳本啟動的 `serve` 行程，以及
它 fork 出來的 agent 子行程——這條鏈只在「serve 由 `npm run verify:setup` 啟動」時
成立。**自己另外跑 `node_modules/.bin/slidra serve` 的話，agent 對話仍然會拿到
`command not found: slidra`**，因為那個行程沒有經過腳本的 PATH 修正。已知限制，
修法是一律用 `npm run verify:setup` 啟動，不要手動組指令。

## agent 不用另外安裝，但要選一個才能聊天

`claude-code-acp` / `codex-acp`（NOOP-230 起）是 `@slidra/server` 的一般 npm
相依，`npm install` 就裝好，不用再全域安裝。`--agent` 只覆蓋這一次 serve 用哪一
個；沒帶的話看使用者設定檔（`<SLIDRA_HOME>/settings.json`）之前選過的，兩者都
沒有時 serve 照常啟動，只是聊天會回報「尚未選擇 agent」，直到選定為止。

前置腳本每次會執行 `npm install` 同步 workspace 相依，避免切換分支後漏裝
adapter。Codex adapter 使用唯讀沙箱與逐次請求授權；編輯規約要求命令經過
Slidra 的 `allow_once` 白名單檢查後執行，才能寫入簡報與復原快照。
不需要把使用者的 Codex 全域設定改成完整存取。

## `--qa`：沙箱 QA 層

`--qa` 在既有流程（安裝／建置／前置檢查／簡報）之後，背景起一份 `slidra serve`
與一個 headless Chromium（帶 `--remote-debugging-port`），供 `browser-use` 操作，然後
腳本自己結束（不像不帶 `--qa` 時那樣 `exec` 進 `serve` 常駐）。它寫出
`.quickstart/qa/qa.env`（`BU_CDP_URL`、`BH_AGENT_WORKSPACE=qa/`、伺服器網址與簡報識別碼
等），`source` 之後 `browser-use` 就能透過 `qa/agent_helpers.py` 的原語操作這份 demo
簡報；細節與原語清單見 `qa/README.md`。跑完用 `./quick_start.sh --qa-stop` 收尾，會把
背景的 serve 與 Chromium 一併收掉。不帶 `--qa` 時的行為完全不受影響。

## `--fresh` 什麼時候非用不可

改了 `demo/` 之後。腳本不會自動重打包既有的示範簡報——重打包會換一組簡報識別碼，
把使用者手上的網址與終端機指令全部作廢（見 `quick_start.sh` 裡的對應註解）。
`--blank` 模式下的空白簡報同理，改了想重建也要加 `--fresh`。
