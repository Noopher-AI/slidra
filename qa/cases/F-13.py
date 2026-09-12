"""F-13：左欄縮圖顯示 ✦ n 標示該頁動畫數（父票 NOOP-356 / GitHub #288）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語）——這支腳本只用這個清單操作瀏覽器，不新增瀏覽器互動原語：

    open_deck() / shot()

外加 `browser_harness.helpers` 本身注入的公開核心原語 `js()`（不是
`agent_helpers.py` 加的——見該檔檔頭註解「every top-level name not
starting with "_" becomes a global... the same way core helpers like
js()/cdp() are」）：`agent_helpers.py` 沒有讀縮圖徽章 textContent 的原語，
這裡直接用 `js()` 讀 DOM，不新增 `agent_helpers.py` 原語。

以及一個外部前置動作：直接呼叫 `node_modules/.bin/slidra effect add`
在第 1 頁標題（`el-title`）加一個效果——這是驗收條件本身要求的「操作」，
不是瀏覽器手勢。CLI 寫檔後，server 的 `fs.watch(workDir)`（packages/
server/src/watch.ts）會廣播 `presentation-changed`，跟一般使用者從 GUI
操作落地的路徑相同（`slidra cat "$SLIDRA_QA_PRESENTATION_ID"
slides/001.svg` 走的是同一個 work dir，qa/README.md §1 已驗證過這條路
徑）。

判準：demo/slides/003.svg 的 metadata 裡帶三個 `<slidra:effect>`（步驟一二
三各一個 enter 效果），demo/slides/001.svg 沒有任何效果清單——第 3 頁縮
圖應顯示「✦ 3」、第 1 頁應無標記。對第 1 頁標題加一個效果後，第 1 頁縮圖
應改顯示「✦ 1」。三個徽章讀值都用短輪詢（而非固定 sleep 或立即讀一次）：
`loadEffectCount()`（overview.ts）是非同步 fetch，`open_deck()` 只保證
`.overview-item` 已經存在，不保證徽章的 fetch 已經落地；effect add 之後
還疊了 server 端 100ms 的 debounce（watch.ts 的 DEBOUNCE_MS）。

若第一條斷言（第 1 頁「無標記」）意外失敗，先比對本機簡報是否仍是原始
狀態（qa/README.md §3.5「髒掉的簡報」）——這代表上一次執行中途失敗，
`slides/001.svg` 已經帶著效果，需要重開一份乾淨的簡報再跑。
"""

import os
import subprocess
import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def badge_text(slide_number: int) -> object:
    """`.overview-item`（1-based `slide_number`）裡 `.overview-effect-badge`
    的 textContent；徽章元素不存在時回傳 `None`。"""
    return js(  # noqa: F821 - browser_harness.helpers 的公開核心原語
        "(() => {"
        f"const li = document.querySelectorAll('.overview-item')[{int(slide_number) - 1}];"
        "const badge = li && li.querySelector('.overview-effect-badge');"
        "return badge ? badge.textContent : null;"
        "})()"
    )


def wait_for_badge(slide_number: int, expected: str, timeout: float = 5.0) -> object:
    """輪詢 `badge_text(slide_number)` 直到等於 `expected` 或逾時，回傳最後
    一次讀到的值（逾時時就是那個不符期望的值，直接餵給 check() 印出來）。"""
    deadline = time.monotonic() + timeout
    actual = badge_text(slide_number)
    while actual != expected and time.monotonic() < deadline:
        time.sleep(0.1)
        actual = badge_text(slide_number)
    return actual


def main() -> int:
    open_deck()  # noqa: F821

    before_1 = wait_for_badge(1, "")
    check("第 1 頁縮圖無 ✦ 標記（base 上沒有效果）", before_1 == "", before_1)
    before_3 = wait_for_badge(3, "✦ 3")
    check("第 3 頁縮圖顯示 ✦ 3（demo/slides/003.svg 帶三個 <slidra:effect>）", before_3 == "✦ 3", before_3)
    shot("F-13-before")  # noqa: F821

    presentation_id = os.environ["SLIDRA_QA_PRESENTATION_ID"]
    result = subprocess.run(
        [
            "node_modules/.bin/slidra",
            "effect",
            "add",
            presentation_id,
            "slides/001.svg",
            "el-title",
            "--family",
            "enter",
            "--effect",
            "fade",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"FAIL 前置：`slidra effect add` 失敗 stdout={result.stdout!r} stderr={result.stderr!r}")
        return 1

    after_1 = wait_for_badge(1, "✦ 1")
    check("在第 1 頁標題加一個效果後，第 1 頁縮圖顯示 ✦ 1", after_1 == "✦ 1", after_1)
    shot("F-13-after")  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
