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

## agent adapter 要另外全域安裝

`claude-code-acp` / `codex-acp` 是 CoMotion 之外的東西，`npm install` 不會帶進來，
需要各自 `npm install -g` 安裝。偵測到兩個都裝了但沒指定 `--agent` 時，腳本只會
提醒、不會擋——真正需要指定的時機是聊天功能送出第一則訊息時，此時偵測到多個未
指定會直接報錯。

## `--fresh` 什麼時候非用不可

改了 `demo/` 之後。腳本不會自動重打包既有的示範簡報——重打包會換一組簡報識別碼，
把使用者手上的網址與終端機指令全部作廢（見 `quick_start.sh` 裡的對應註解）。
`--blank` 模式下的空白簡報同理，改了想重建也要加 `--fresh`。
