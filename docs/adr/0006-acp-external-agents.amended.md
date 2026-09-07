# 以 ACP client 外接 agent，不自建 agent runtime 與授權

> **部分條款已修訂（NOOP-238，GitHub #235）。** 「對話開始時送出的編輯規約是一則普通的 user message，不用 skill 也不用 system prompt」改為：**編輯規約仍然是 user message**（跨 provider 行為一致這個理由不變）——但「不用 skill」不再成立。穩定不變的指引（長期慣例、完整命令參考）與 skill 現在改走另一條路徑：套件內建、`co-motion serve` 每次啟動都鋪到使用者機器固定位置的產品工作目錄（`<CO_MOTION_HOME>/agent`，NOOP-238），agent 用自己原生的檔案讀取能力去讀，不塞進每輪都重送的 user message 裡。
>
> **仍然成立的**：以 ACP client 外接、不自建 agent runtime 或 OAuth；`session/prompt` 的 content block 陣列是註記的原生擴充點；ADR-0004 的兩層防護仍是 ACP client 側的職責。

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
