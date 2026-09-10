# 沙箱 QA 層

給 Dev-Reviewer（以及其他在 sandbox pod 裡驗收 CoMotion 的 agent）用：一個指令起好
CoMotion，之後用 `browser-use` 加 CoMotion 專屬 helper 操作 app、讀回投影片檔與狀態，
跨多次 Bash 呼叫保持同一個瀏覽器 session。這是 #279 其餘每一張修復票的驗證工具。

## 1. 怎麼起環境

```bash
npm run verify:setup -- --qa --no-open
source .quickstart/qa/qa.env
browser-use < qa/cases/smoke.py
```

第一行跑完會印出 `browser-use --doctor` 的結果；離開碼 0 代表 daemon 已連上、目前的
active page 就是 CoMotion。第二行把 `BU_CDP_URL`、`BH_AGENT_WORKSPACE`、
`CO_MOTION_QA_URL`、`CO_MOTION_QA_PRESENTATION_ID`、`BH_RUNTIME_DIR`、`BH_TMP_DIR`
匯入目前 shell；之後每一次獨立的 `browser-use` 呼叫都會接上同一個瀏覽器 tab。

`BH_RUNTIME_DIR` 必須是短路徑（`--qa` 固定寫成 `/tmp/co-motion-qa-$(id -u)`），不是
`.quickstart/` 底下：daemon 的 IPC socket 走 `AF_UNIX`，這個 sandbox pod 的 repo 路徑
（含 workspace 前綴）加上 socket 檔名會超過 Linux 108 bytes 的 `sun_path` 上限，直接
`fatal: AF_UNIX path too long`，整個工具起不來。自己另外拼指令時千萬別把它改回
repo 內的路徑。

收尾：

```bash
./quick_start.sh --qa-stop
```

會把 `--qa` 留下的背景 `co-motion serve` 與 Chromium 一併收掉（兩者都是 `setsid` 起的
獨立行程群組，`kill` 對整個 PGID 送信號，不是只殺 wrapper）。重跑 Review 是常態，
`--qa` 偵測到既有的 QA 環境還活著時會自己先收再起，不必手動清。

## 2. 案例腳本固定結構

每個案例腳本（`qa/cases/<id>.py`）固定三段：

```python
def setup():
    ...  # open_deck() 等前置動作

def act():
    ...  # 操作序列

def assert_():
    ...  # 檢查，任一條不符就呼叫 sys.exit(1) 之前的 fail 函式

def main():
    setup(); act(); assert_()
    print("PASS: <id>")

main()  # 不要用 `if __name__ == "__main__":`——browser-use 用
        # exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
        # 是 "browser_harness.run"，永遠不是 "__main__"，這個 guard 永遠
        # 不會觸發（qa/cases/smoke.py 就是照這個結構寫的，可以直接抄）。
```

執行方式：

```bash
browser-use < qa/cases/<id>.py
```

非零離開碼即 FAIL。輸出第一行固定 `PASS: <id>` 或 `FAIL: <哪一條> expected=<…>
actual=<…>`，之後可以接量到的原始值——整段直接可以貼進 Review 留言，不必另外轉譯。

## 3. 判準：PR 分支 PASS、該 PR 的 base FAIL

驗證一張修復票時，同一支案例腳本要在兩個 commit 各跑一次，兩次的原始輸出都要貼進
留言，並標明對應的 commit：

```bash
git checkout <PR 分支>
npm run verify:setup -- --qa --no-open
source .quickstart/qa/qa.env
browser-use < qa/cases/<id>.py   # 預期 PASS
./quick_start.sh --qa-stop

git checkout <base>
npm run verify:setup -- --qa --no-open
source .quickstart/qa/qa.env
browser-use < qa/cases/<id>.py   # 預期 FAIL（缺陷仍在）
./quick_start.sh --qa-stop
```

只有 PR 分支 PASS 而 base FAIL，才算這張票真的修到了東西——PR 分支和 base 都 PASS，
代表案例腳本沒斷言到缺陷本身；兩邊都 FAIL，代表修復沒生效。

## 3.5 兩個會讓 PASS/FAIL 完全失去意義的陷阱

這兩個都不會讓任何一條斷言變紅——它們讓斷言去量錯的東西，然後回報一個看起來
很正常的結果。NOOP-349 的 F-15 兩者都踩過，代價是五輪 review。

**（一）輸入事件被靜默丟棄。** 投影片跑在一個 sandboxed srcdoc iframe 裡，每次換頁
都會整個重建。`selection-runtime.js` 是先掛好 selection host、解析完 markup，**之後**
才 `addEventListener`，最後才送出 `runtime-ready`。在這個空檔裡派送的 CDP 輸入事件
會落在一個沒有任何 pointer 監聽器的 document 上，被丟掉——沒有錯誤、沒有 console
訊息、沒有 gesture-start/move/end。手勢等於沒有發生，接著的斷言量到的是手勢前的
狀態。`agent_helpers.py` 現在由 `_dispatch_mouse()` 在每個 mousePressed 上強制擋住
（`_require_runtime_ready()`），新增原語不必自己記得等；但**自己另外拼 CDP 指令時
要記得這件事**。判斷 iframe 可以接受輸入的訊號是 `runtime-ready`，不是 DOM 裡有沒有
`<svg>`。

**（二）髒掉的簡報。** 只要有任何一個手勢真的搬動過元素，服務中的簡報就跟 `demo/`
不一樣了，而且**會一直不一樣**——`quick_start.sh` 不會自動重新打包，`open_deck()` 也
只比對網址、不會重載。之後每一支案例腳本都在對著一份位置錯掉的投影片下判斷：
F-15 的 B-2（「矩形涵蓋三行文字但不含標題」）在標題被搬進框選範圍之後，會非常
穩定地回報 4 個元素，看起來就像產品的命中判定壞了。

跑完會寫檔的案例之後，或任何時候懷疑結果不合理，先確認簡報是原始狀態：

```bash
co-motion cat "$CO_MOTION_QA_PRESENTATION_ID" slides/003.svg | diff - demo/slides/003.svg
```

不一致就重開一份再跑：

```bash
ID=$(co-motion open .quickstart/demo.comot | grep -o '"id"[^,}]*' | sed 's/.*"\([^"]*\)"$/\1/')
```

## 4. 偶發缺陷的豁免寫法

案例腳本只要求 **PR 分支 PASS**，base FAIL 不代表案例腳本要斷言「絕對不會發生」——
遇到已知會偶發的行為，把斷言改寫成防禦性描述，而不是刪掉這條案例。例如 N-03（雙擊
偶發刷藍）不斷言「輸入框一定出現」，而是斷言「雙擊後
`window.getSelection().toString()` 為空」：把「會不會發生」的不確定性，改成「發生了
也不該外溢成看得見的壞狀態」這種可以穩定驗證的說法。

## 5. 第三輪探索報告（沿用 `docs/visual-qa.md`）

第三輪的探索性報告（沒有對應案例腳本、單純看螢幕截圖找問題）沿用
[`docs/visual-qa.md`](../docs/visual-qa.md) 的判準與格式，不在這裡重新定義：

- **五類判準**：前景背景對比不足／狀態指示對比不足／操作完成後沒有視覺回饋／空間
  分配失衡／編輯狀態可辨識性不一致。講不出「使用者會因此遭遇什麼」就不算數。
- **報告格式**：Markdown 表格 `| 場景 id | 判準類別 | 使用者後果 | 截圖檔名 |`，
  **依場景 id 的 ASCII 字串順序遞增排序**（相同輸入跑兩次要能 diff 不出差異）。
- **不判讀的場景**：`new-slide-menu`、`shape-menu`、`insert-shape-menu`——這三個是
  中間狀態的過場畫面，判讀它們容易逼出假問題。

## 6. `browser-use` 版本與升版注意事項

本輪（含 helper 的實作與驗證）針對 **`browser-use 0.1.13`** 撰寫並實測。
`qa/agent_helpers.py` 只用 `browser_harness.helpers` 的公開名稱（`cdp`、
`current_tab`、`new_tab`、`wait_for_load`、`drain_events`、`http_get`、
`capture_screenshot`）；這些是相對穩定的核心原語，但升版後第一件事仍是
跑一次：

```bash
browser-use < qa/cases/smoke.py
```

PASS 就代表這些簽名沒有破壞性改動。

## 已知限制

- **`console_errors()` 只涵蓋「附著之後」發生的 iframe 錯誤。** daemon 只對目前附著
  的 page session 開 `Runtime` domain；投影片 iframe 的 console 需要 helper 另外附一
  個 session 才看得到，這個附著動作發生在第一次呼叫 `console_errors()` 時——在那之前
  （例如換頁重建 iframe 到下一次呼叫之間）發生的 iframe 錯誤會漏掉。父文件的錯誤不
  受此限，一直看得到。
- **`console_errors()` 與核心的 `wait_for_network_idle()` 互斥。** 兩者都靠
  `drain_events()`，而 `drain_events()` 會清空 daemon 的事件緩衝——在同一段流程裡交
  替使用，後呼叫的那個會看不到前一個已經清掉的事件。
- **`qa/cases/smoke.py` 只支援 demo 簡報**（`quick_start.sh --qa` 不帶 `--blank`）。
  空白簡報只有 1 頁、也沒有 `data-comot-name="標題"` 這個元素，`slide_count() == 4`
  這條斷言會先失敗，訊息會提示「請不要加 `--blank`」。
- **`qa/cases/*.py` 不進 CI、不當合併門檻**（#279 決定 5）——這些腳本設計給 Review
  階段的 agent 手動跑，不是自動化測試套件的一部分。
- **`--qa` 的 Chromium 啟動旗標含 `--disable-dev-shm-usage` 等容器旗標**（NOOP-349
  round 5）：容器內 `/dev/shm` 常只有 64MB，不加這個旗標會讓 renderer 在高頻互動下
  變慢甚至卡死，症狀是 CDP 呼叫逾時或點擊送出但畫面沒反應。唯讀 CDP／JS 呼叫另外可
  用 `CO_MOTION_QA_IPC_TIMEOUT`（秒，預設 20）調整逾時，非數字或非正數會直接報錯。
- `browser-use --doctor` 一定會印一行 `[FAIL] Browser Use cloud auth — optional`；
  這是正常的，`--doctor` 本身仍以離開碼 `0` 結束，不代表 QA 環境沒起來。
