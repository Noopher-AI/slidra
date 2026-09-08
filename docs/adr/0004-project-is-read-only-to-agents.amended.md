# 簡報內容對 agent 唯讀，透過虛擬檔案系統存取

> **⚠️ 部分條款已失效。** 三層防護的第二層（「權限鉤子只放行 `co-motion *`」）由 **ADR-0015** 開了一個明確的洞：
> 資產匯入命令吃絕對路徑與 URL，而它是 `co-motion` 命令，會被鉤子放行。該路徑上唯一的守衛是媒體格式驗證。
>
> **仍然成立的**：虛擬檔案結構、`fs/write_text_file` 一律拒絕、不洩漏真實路徑、
> 元素用不透明穩定識別碼定址、SVG 必須保持精簡（檔案大小＝每輪對話的 token 成本）。

> **NOOP-238（GitHub #235）在第三層開了另一個明確的洞：agent session 的 cwd 不再是每次連線都重新產生的空白暫存目錄，而是套件內建、`co-motion serve` 每次啟動都整個重鋪的產品工作目錄（`<CO_MOTION_HOME>/agent`——與簡報自己的真實工作目錄 `work/<id>` 是兩個不同的東西，後者仍然完全不可讀）。`fs/read_text_file` 的讀取範圍相應放寬為「簡報虛擬路徑（相對路徑第一段是 `project.json`、`slides`、`assets` 或 `fonts` 的其中之一）＋這個工作目錄本身的真實檔案（唯讀）」。
>
> 工作目錄的讀取重用 `readVirtualFile` 既有的結構性容納，**不做**這份 ADR 原本設想的「`realpath` 之後再檢查一次仍在目錄內」：`buildVirtualTree` 只收 `isDirectory()`/`isFile()` 的項目，一個指向目錄外的 symlink 從未被記進虛擬樹，因此結構上就查不到，不需要再疊一層 guard 式檢查。
>
> **仍然成立的**：`fs/write_text_file` 一律拒絕、不洩漏真實路徑、命令白名單不變、`work/<id>` 不可讀、元素用不透明穩定識別碼定址。

ADR-0002 要求所有修改都經由語意化命令。但只要 agent 看得到真實檔案路徑，它就會用 `cat`、`sed`、`grep`——讀寫是綁在一起的，紀律擋不住。

因此 CoMotion 不讓 agent 接觸真實檔案系統，改為透過 CLI 提供一個虛擬檔案結構：agent 看得到完整內容，但沒有任何寫入入口。

## 三層防護

1. **ACP 檔案方法**：`fs/read_text_file` 回傳虛擬路徑下的內容；`fs/write_text_file` 一律拒絕，錯誤訊息直接指引改用語意化命令。
2. **權限鉤子**：`session/request_permission` 只放行 `co-motion *`，其他 shell 命令全擋。這順帶讓使用者不會被權限對話框打斷。
3. **不洩漏真實路徑**：成功訊息不出現任何檔案系統路徑。錯誤訊息可以原樣回述呼叫者傳入的字串，但絕不解析成絕對路徑、不展開、不正規化。系統原生的檔案錯誤一律轉譯，不得直接冒出。工作目錄的真實位置永遠不出現在任何輸出。真實路徑一旦出現一次，agent 就會去試。

## Consequences

- 必須把被擋掉的讀取能力補回來：`ls`、`tree`、`cat`、`cat --lines`、`grep`。輸出格式刻意模仿對應的 Unix 工具，讓 agent 不需要學。`grep` 是必要的，否則 agent 只能逐頁 `cat`，token 成本無法接受。
- 擋的是 agent，不是人。`co-motion extract` 讓使用者隨時取回自己的檔案，`.comot` 是容器而非牢籠。
- 元素用不透明穩定識別碼定址，顯示名稱另存。因此 agent 動手前必須先讀 SVG 建立對照表——SVG 檔案大小直接等於每輪對話的 token 成本，所以產生的 SVG 必須保持精簡：不內嵌 base64、不產生冗長 path、重複樣式用 class 而非 inline style。
