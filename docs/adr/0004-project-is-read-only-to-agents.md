# 簡報內容對 agent 唯讀，透過虛擬檔案系統存取

ADR-0002 要求所有修改都經由語意化命令。但只要 agent 看得到真實檔案路徑，它就會用 `cat`、`sed`、`grep`——讀寫是綁在一起的，紀律擋不住。

因此 CoMotion 不讓 agent 接觸真實檔案系統，改為透過 CLI 提供一個虛擬檔案結構：agent 看得到完整內容，但沒有任何寫入入口。

## 三層防護

1. **ACP 檔案方法**：`fs/read_text_file` 回傳虛擬路徑下的內容；`fs/write_text_file` 一律拒絕，錯誤訊息直接指引改用語意化命令。
2. **權限鉤子**：`session/request_permission` 只放行 `co-motion *`，其他 shell 命令全擋。這順帶讓使用者不會被權限對話框打斷。
3. **不洩漏真實路徑**：CLI 的所有輸出——包含錯誤訊息與 log——只出現虛擬路徑。真實路徑一旦出現一次，agent 就會去試。

## Consequences

- 必須把被擋掉的讀取能力補回來：`ls`、`tree`、`cat`、`cat --lines`、`grep`。輸出格式刻意模仿對應的 Unix 工具，讓 agent 不需要學。`grep` 是必要的，否則 agent 只能逐頁 `cat`，token 成本無法接受。
- 擋的是 agent，不是人。`co-motion extract` 讓使用者隨時取回自己的檔案，`.comot` 是容器而非牢籠。
- 元素用不透明穩定識別碼定址，顯示名稱另存。因此 agent 動手前必須先讀 SVG 建立對照表——SVG 檔案大小直接等於每輪對話的 token 成本，所以產生的 SVG 必須保持精簡：不內嵌 base64、不產生冗長 path、重複樣式用 class 而非 inline style。
