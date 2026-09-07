# 驗證前置（`npm run verify:setup`）

這份文件只寫 `npm run verify:setup` 涵蓋不到、或執行時容易誤解的部分。步驟本身
（安裝、建置、前置檢查、準備簡報、啟動）不在這裡重述，跑 `npm run verify:setup --help`
看。

## 為什麼每次改前端都要重建

`co-motion serve` 只吃 `packages/web/dist` 的靜態檔，沒有 dev server proxy
（ADR-0002）。改了 `packages/web` 的原始碼卻用 `--skip-build` 重跑，畫面上看到的
會是舊的建置產物。`--skip-build` 只在完全沒動前端原始碼時可用。

## PATH 的作用範圍到哪為止

`export PATH=".../node_modules/.bin:$PATH"` 只影響本腳本啟動的 `serve` 行程，以及
它 fork 出來的 agent 子行程——這條鏈只在「serve 由 `npm run verify:setup` 啟動」時
成立。**自己另外跑 `node_modules/.bin/co-motion serve` 的話，agent 對話仍然會拿到
`command not found: co-motion`**，因為那個行程沒有經過腳本的 PATH 修正。已知限制，
修法是一律用 `npm run verify:setup` 啟動，不要手動組指令。

## agent 不用另外安裝，但要選一個才能聊天

`claude-code-acp` / `codex-acp`（NOOP-230 起）是 `@co-motion/server` 的一般 npm
相依，`npm install` 就裝好，不用再全域安裝。`--agent` 只覆蓋這一次 serve 用哪一
個；沒帶的話看使用者設定檔（`<CO_MOTION_HOME>/settings.json`）之前選過的，兩者都
沒有時 serve 照常啟動，只是聊天會回報「尚未選擇 agent」，直到選定為止。

## `--fresh` 什麼時候非用不可

改了 `demo/` 之後。腳本不會自動重打包既有的示範簡報——重打包會換一組簡報識別碼，
把使用者手上的網址與終端機指令全部作廢（見 `quick_start.sh` 裡的對應註解）。
`--blank` 模式下的空白簡報同理，改了想重建也要加 `--fresh`。
