# 以 ACP client 外接 agent，不自建 agent runtime 與授權

> **本 ADR 由 NOOP-230 修訂了「使用者已經安裝並登入」這個前提。** 下方原文假設兩件事都已經是使用者自己處理好的既成事實：adapter 已經裝在機器上、CLI 已經登入。NOOP-230 起兩者都不再是假設——**兩個 adapter（`claude-code-acp`／`codex-acp`）現在是 `@co-motion/server` 自己的 npm 相依，隨 CoMotion 一起打包安裝**，不用使用者另外 `npm install -g`；**登入狀態則是 serve 主動探測**（`claude auth status --json` / `codex login status`），不是單純假設已登入就直接送出對話。連帶地，「沒有可用的 agent」不再是 serve 啟動失敗的理由：**serve 一律啟動**，尚未選擇或尚未登入只擋住聊天本身（`POST /api/chat` 回 409），其餘功能不受影響——這在舊版原本被明確排除的一條路（見 `select.ts` 舊版文件：「沒有『pick one anyway』或『chat disabled but serve runs』這條路」）在 NOOP-230 之後正是新的預設行為。「Codex 自己處理授權與計費」「CoMotion 不自己實作 agent」這兩條本 ADR 的核心立場不受影響——探測登入狀態是讀一個現成指令的結果，不是 CoMotion 自己代管 OAuth。

CoMotion 內建聊天，但不自己實作 agent。使用者已經安裝並登入 Codex 或 Claude Code，那些工具自己處理授權與計費，CoMotion 不該重做一次 OAuth、provider 抽象與 tool-calling 迴圈——沒有人會因為這些而選擇 CoMotion。

CoMotion 實作成 **Agent Client Protocol（ACP）client**（JSON-RPC 2.0 over stdio），透過現成 adapter 接上任何 agent。

## Considered Options

- **直接驅動各家 CLI 的 stream-json**：每一家都要寫一套解析器，而且格式是各廠商私有的，隨時可能改變。維護 N 份脆弱的解析器不是 CoMotion 的價值所在。
- **自建 agent runtime**：需要自己做 OAuth、token refresh、provider catalog。與產品價值零關係，且是典型會失控的工程。

## Consequences

- Claude Code、Codex、Gemini CLI 等 registry 中的 agent 全部可用，不需為任何一家寫整合程式碼。
- `session/prompt` 的 prompt 是 content block 陣列，所以「送出訊息時夾帶待處理的註記」是協定的原生擴充點，不是變通做法：使用者打的字是一個 text block，註記接在後面作為 resource block。
- 對話開始時送出的**編輯規約**是一則普通的 user message，不用 skill 也不用 system prompt。理由是 user message 在各家 agent 上行為完全一致，換 provider 不必改動。
- ADR-0004 的兩層防護（檔案方法、權限鉤子）都是 ACP client 側的職責，因此本決定是 0004 得以成立的前提。
- 風險：ACP 規格仍在演進。但相對於自行解析多家私有格式，公開規格的變動有討論與遷移路徑，風險反而較低。
