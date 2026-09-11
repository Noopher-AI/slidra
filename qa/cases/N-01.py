"""N-01：拖曳搬移回歸（父票 NOOP-350 [E5.T5]，Execute 子票 NOOP-382）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語）：

    open_deck() / select(name_or_id) / selection() / drag(from_xy, to_xy) /
    slide_svg(n) / save_state() / console_errors()

原語由 `browser-use` 以 `exec(code, globals())` 注入為全域名稱（見
qa/cases/smoke.py），不是可 import 的模組，本檔直接呼叫它們並在呼叫處加
`# noqa: F821`。除了上面這份固定清單，本檔另外用了 browser-use 的兩個
「核心」原語 `cdp()` 與 `js()`（不是 agent_helpers.py 的新增，任何案例腳
本本來就能用）——理由見下面兩段，都不是可以繞過的。

## 根因（與票面原始假設不同，已當面向 Dev-Leader 回報）

票面描述懷疑根因在 `beginMoveGesture`（`selectionIds`/`originals` 的建構
邏輯）。實測不成立：`gesture-start`/`gesture-move`/`preview` 全部正常送
達，`beginMoveGesture` 從未提前 return。真正根因是投影片跑在一個獨立進
程（out-of-process）的 sandboxed iframe 裡——拖曳把游標帶出這個 iframe
的「實際渲染範圍」之後，一般的跨文件 hit-test 不會再把後續的
pointermove/pointerup 送進 iframe（`Element.setPointerCapture()` 在
iframe 內呼叫對 out-of-process sandboxed frame 沒有作用，這點已經實測驗
證、不是臆測），iframe 因此永遠等不到自己的 `gesture-end`：預覽卡住、不
送 `element move`、沒有 undo 步驟、主控台也不會有任何錯誤——正是 N-01 的
症狀。修復把「pointer 離開 iframe 之後」的 pointermove/pointerup 交給
host（`canvas.ts` 自己的 window 監聽）接手完成手勢。

## 為什麼不是字面上的「拖 200px」

票面驗收條件寫「drag 200px」。demo 第 1 頁在 1440x900 視窗、預設縮放下，
標題中心到 iframe 右緣還有約 416px 的餘裕——單純橫向拖 200px 根本不會跨
出 iframe 邊界，PR 分支與 base 會一起 PASS，量不到缺陷本身（`qa/README.md`
§3 明講這種「兩邊都 PASS」的腳本沒有意義）。這裡改成量測 iframe 目前的
實際邊界，把拖曳終點定在邊界外 20px——每次執行都重新量測，不寫死像素數
字，避免綁死在某個特定視窗尺寸假設上。已於 Execute 交付留言向 Dev-Leader
/Reviewer 說明這個字面數字上的偏離。

## 環境陷阱：同一個 QA session 內比較 PR 分支與 base 時的快取

`qa/README.md` §3 的既定流程是同一個 pod 裡先跑一次 PR 分支、`--qa-stop`
收掉、切 base、再 `--qa` 起一次。Chromium 的 `--user-data-dir` 是同一份
`profile/`，不會在兩次 `--qa` 之間清空；`index.html` 本身沒有防快取表
頭，只有資產檔名有 hash——因此第二次 `--qa` 啟動的分頁完全可能繼續沿用
上一個 commit 的 bundle，讓兩次跑的其實是同一份程式碼，PASS/FAIL 因此
失去意義（實測踩過：`document.scripts` 顯示的 `src` hash 跟伺服器當下
真正在服務的 hash 對不上）。`main()` 一開始的 `cdp("Network.setCacheDisabled")`
+ `cdp("Page.reload", ignoreCache=True)` 就是防這個——不是這支腳本專屬的
怪癖，是任何要在同一 QA session 內比較兩個 commit 的案例腳本都會踩到的
陷阱，已在交付留言另外提出。

## 輔助線斷言為什麼繞過 drag()

`agent_helpers.py` 的 `drag()` 是一次性、阻塞到底的原語（press -> N 個
move -> release 一次呼叫做完），沒有「拖曳中途暫停檢查 DOM」的原語，票
面卻要求「拖曳靠近另一元素邊線時輔助線 DOM 出現」這種只在手勢進行中才
觀察得到的狀態。這裡改用 `cdp()`/`js()` 自己手動送出低階 mouse 事件、
在每一步 move 之間輪詢 `.guide` 元素——步驟與 `drag()` 內部完全一致，只
是拆開讓中途可以檢查，不是換一套 harness、也沒有在 agent_helpers.py 裡
新增具名原語。
"""

import os
import re
import time
import urllib.request

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _title_transform(svg_text: str) -> str | None:
    m = re.search(r'<g\s+([^>]*\bid="el-title"[^>]*)>', svg_text)
    if not m:
        return None
    tm = re.search(r'transform="([^"]*)"', m.group(1))
    return tm.group(1) if tm else None


def _server_url() -> str:
    # qa/agent_helpers.py 的 `_server_url()` 是私有名稱，exec() 注入時被
    # 濾掉；`CO_MOTION_QA_URL` 是同一份資訊的公開來源（`quick_start.sh`
    # 寫進 qa.env），用它就不必自己重造一個同名原語。
    return os.environ.get("CO_MOTION_QA_URL", "http://127.0.0.1:5173").rstrip("/")


def main() -> int:
    # 見檔案開頭「環境陷阱」一節：避免量到上一個 commit 留下的快取 bundle。
    cdp("Network.setCacheDisabled", cacheDisabled=True)  # noqa: F821
    cdp("Page.reload", ignoreCache=True)  # noqa: F821
    time.sleep(1.5)

    deck = open_deck()  # noqa: F821
    if deck["slides"] < 1:
        print(f"FAIL open_deck()['slides'] expected>=1 actual={deck['slides']!r}")
        return 1

    before_svg = slide_svg(1)  # noqa: F821
    before_transform = _title_transform(before_svg)

    sel = select("標題")  # noqa: F821
    box = sel["box"]
    if box is None:
        print("FAIL select('標題')['box'] expected=not None actual=None")
        return 1

    # 見檔案開頭「為什麼不是字面上的『拖 200px』」：終點定在 iframe 實際
    # 邊界外 20px，而不是寫死一個位移量。
    iframe_rect = js(  # noqa: F821
        "(()=>{const f=document.querySelector('iframe.slide-frame');"
        "const r=f.getBoundingClientRect();"
        "return {x:r.x,y:r.y,width:r.width,height:r.height};})()"
    )
    from_x, from_y = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    to_x = iframe_rect["x"] + iframe_rect["width"] + 20
    to_y = from_y

    drag((from_x, from_y), (to_x, to_y))  # noqa: F821

    after_svg = slide_svg(1)  # noqa: F821
    after_transform = _title_transform(after_svg)
    check(
        "1 拖曳後 el-title 帶新的 transform（且與拖曳前不同）",
        after_transform is not None and after_transform != before_transform,
        after_transform,
    )

    after_sel = selection()  # noqa: F821
    check(
        "2 拖曳後選取狀態仍是「標題」（情境列/狀態列未因拖曳遺失選取）",
        after_sel["chip"] == "Selected: 標題",
        after_sel["chip"],
    )

    save = save_state()  # noqa: F821
    check("3 save_state() 顯示已寫檔（縮圖依 SSE 重載會同步跟進）", save.get("dirty") is True, save)

    # --- Undo 一次還原（同一支腳本，緊接著拖曳的結果驗證）---
    # agent_helpers.py 沒有 undo 或通用 POST 原語：直接打 /api/undo，跟
    # UI 的 Undo 按鈕、⌘Z 走的是同一個端點（packages/web/src/App.tsx 的
    # runUndoRedo），只用 Python 標準庫，不算新增原語。
    #
    # base 上第 1 項本來就會 FAIL（拖曳從未寫檔），這裡沒有任何歷史可
    # undo，`/api/undo` 因此回 400（實測），不是 200——這正是票面症狀
    # 「沒有可 Undo 的歷史步驟」的直接證據，用 try/except 接住讓腳本能
    # 繼續往下印出完整的 FAIL 清單，而不是在這裡整支腳本噴例外中斷。
    import urllib.error

    try:
        undo_req = urllib.request.Request(_server_url() + "/api/undo", method="POST")
        with urllib.request.urlopen(undo_req) as resp:
            undo_status = resp.status
    except urllib.error.HTTPError as exc:
        undo_status = exc.code
    check("4 POST /api/undo 回 200（回其他值代表沒有可 undo 的歷史步驟）", undo_status == 200, undo_status)

    after_undo_svg = slide_svg(1)  # noqa: F821
    after_undo_transform = _title_transform(after_undo_svg)
    check(
        "5 Undo 一次後 el-title 的 transform 還原成拖曳前的值",
        after_undo_transform == before_transform,
        after_undo_transform,
    )

    # --- 吸附輔助線：靠近另一元素邊線時 DOM 真的畫出來過 ---
    # 見檔案開頭「輔助線斷言為什麼繞過 drag()」。拖回「標題」再往下拖向
    # 「副標」：兩者都是置中文字，水平中心線本來就對齊，貼齊時應該畫出
    # 一條垂直輔助線（`.guide.guide-v`）。
    #
    # 吸附候選（例如「副標」）的邊界只在 selection-runtime.js 的
    # reportElementBounds() 送出「element-bounds」之後才進得了 host 的
    # elementBoundsById——每次 iframe 重建（這裡是上面 undo 觸發的 SSE
    # 重載）都要重報一次，`select()` 內部的 `_wait_frame_ready()` 只確認
    # iframe 自己的 DOM 就緒，不等這個額外的 postMessage 往返，字型
    # document.fonts.ready 也要重等一輪。這段時序在這個 sandbox pod 上
    # 波動很大：固定睡 2.5～5 秒都各自量到過一次假陰性（guide 沒出現，不
    # 是斷言寫錯，是「這一次還沒等到量測回報就開始拖」）。與其繼續加長
    # 一個猜的固定秒數，改成最多重試 3 次、每次重新 select 拿最新座標
    # 並遞增等待時間——量到一次真陽性就算 PASS，全部落空才是真的 FAIL。
    guide_seen = False
    for attempt, wait_s in enumerate((2.0, 4.0, 6.0), start=1):
        sel2 = select("標題")  # noqa: F821
        box2 = sel2["box"]
        fx2, fy2 = box2["x"] + box2["w"] / 2, box2["y"] + box2["h"] / 2
        tx2, ty2 = fx2, fy2 + 90
        time.sleep(wait_s)

        cdp(  # noqa: F821
            "Input.dispatchMouseEvent", type="mousePressed", x=fx2, y=fy2, button="left", buttons=1, clickCount=1
        )
        steps = 15
        for i in range(1, steps + 1):
            x = fx2 + (tx2 - fx2) * i / steps
            y = fy2 + (ty2 - fy2) * i / steps
            cdp("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y, button="left", buttons=1)  # noqa: F821
            time.sleep(0.03)
            if js("document.querySelectorAll('.guide').length") > 0:  # noqa: F821
                guide_seen = True
        cdp(  # noqa: F821
            "Input.dispatchMouseEvent", type="mouseReleased", x=tx2, y=ty2, button="left", buttons=0, clickCount=1
        )
        time.sleep(0.3)
        print(f"  (輔助線第 {attempt} 次嘗試，等待 {wait_s}s 後拖曳：{'量到' if guide_seen else '沒量到'})")
        if guide_seen:
            break
    check("6 拖曳靠近另一元素邊線時，輔助線 DOM（.guide）在過程中出現過", guide_seen, guide_seen)

    # console_errors() 放在所有手勢斷言之後才呼叫：它會對投影片 iframe 的
    # CDP target 額外 attach 一個 session 並 Runtime.enable（見
    # agent_helpers.py 的實作），實測這個 attach 會讓「之後」在同一個
    # iframe 世代上發生的量測/吸附時序變得不可靠（上面第 6 項若在
    # console_errors() 之後才做，guide 會測不到，換個順序就穩定重現）——
    # qa/README.md 已經記過它跟 wait_for_network_idle() 互斥，這裡是另一
    # 個一樣成因（都是 attach 一個額外 debugger session）但先前沒寫下來
    # 的交互作用，已在交付留言另外提出。
    errs = console_errors()  # noqa: F821
    check("7 全程無 console error", errs == [], errs)

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"（qa/README.md §2）。改為
# 無條件呼叫，離開碼交給呼叫端的行程退出碼決定。
raise SystemExit(main())
