"""F-01：投影片被瀏覽器捲軸壓住（父票 NOOP-355 #287，本票 NOOP-396）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語，`browser_harness.helpers` 提供 `cdp()`/`js()`）——這支腳本
只用這個清單，不新增原語、不改寫成別的 harness（同 qa/cases/F-15.py 的
約定）：

    open_deck() / cdp(method, **params) / js(expression, target_id=None)

判準：`div.stage` 與播放容器（同一個 `.stage`，play.css 只改色不改版面）
的 `scrollHeight`/`scrollWidth` 不得超過各自的 `clientHeight`/`clientWidth`；
srcdoc 內 `<html>` 的同一組量測也一樣不得溢出。編輯模式量一次，播放模式
再量一次——F-01 的修法（`.slide-frame{display:block}` + srcdoc 內
`svg{display:block}`）兩層都要成立，缺一層都會在其中一次量測露餡。
"""

import sys

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _stage_iframe_target_id(attempts: int = 20, interval: float = 0.25) -> str:
    """The main stage's `iframe.slide-frame` CDP target id.

    Matched via DOM.describeNode's frameId (verified to equal the OOPIF's
    Target.getTargets() targetId), not iframe_target("srcdoc") — that core
    primitive matches every srcdoc iframe in the browser, including the
    overview thumbnails (each one is its own srcdoc document,
    packages/web/src/overview.ts), which would make target selection
    ambiguous. `iframe.slide-frame` is a class unique to the main stage
    (thumbnails use `.overview-frame` — packages/web/src/overview.ts:197).
    """
    import time

    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            doc = cdp("DOM.getDocument", depth=0)  # noqa: F821
            root_id = doc["root"]["nodeId"]
            found = cdp("DOM.querySelector", nodeId=root_id, selector="iframe.slide-frame")  # noqa: F821
            node_id = found.get("nodeId")
            if not node_id:
                time.sleep(interval)
                continue
            described = cdp("DOM.describeNode", nodeId=node_id, depth=0)  # noqa: F821
            frame_id = described.get("node", {}).get("frameId")
            if not frame_id:
                time.sleep(interval)
                continue
            targets = cdp("Target.getTargets")["targetInfos"]  # noqa: F821
            for t in targets:
                if t.get("type") == "iframe" and t.get("targetId") == frame_id:
                    return frame_id
            time.sleep(interval)
        except Exception as exc:  # noqa: BLE001 - retry on transient CDP errors (DOM rebuilding)
            last_exc = exc
            time.sleep(interval)
    raise RuntimeError(f"找不到 iframe.slide-frame 的 CDP target（{attempts} 次重試後放棄）") from last_exc


def _measure_scroll(expr_target: str) -> dict:
    return js(  # noqa: F821
        f"(()=>{{const el={expr_target};"
        "return {scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight,"
        "clientWidth:el.clientWidth,clientHeight:el.clientHeight};})()"
    )


def _measure_srcdoc() -> dict:
    frame_id = _stage_iframe_target_id()
    return js(  # noqa: F821
        "(()=>{const el=document.documentElement;"
        "return {scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight,"
        "clientWidth:el.clientWidth,clientHeight:el.clientHeight};})()",
        target_id=frame_id,
    )


def _no_overflow(label: str, m: dict) -> None:
    check(f"{label}：scrollWidth ≤ clientWidth", m["scrollWidth"] <= m["clientWidth"], m)
    check(f"{label}：scrollHeight ≤ clientHeight", m["scrollHeight"] <= m["clientHeight"], m)


def main() -> int:
    open_deck()  # noqa: F821

    edit_stage = _measure_scroll("document.querySelector('.stage')")
    _no_overflow("編輯模式 .stage", edit_stage)
    edit_srcdoc = _measure_srcdoc()
    _no_overflow("編輯模式 srcdoc documentElement", edit_srcdoc)

    # 已驗證可用的選擇器（NOOP-395 Plan §6）：TitleBar.tsx:177 的播放鍵。
    js("document.querySelector('.play-button').click()")  # noqa: F821
    import time

    # 等播放模式真的換了頁：`.titlebar` 離開 DOM（App.tsx 的 shellVisible
    # 閘）、播放 iframe（整份重建的新文件）解析出新的 CDP target 且內容已
    # 經 load 完成。**不**等 `.play-bar[data-player-focus="true"]`——那個旗
    # 標追蹤的是鍵盤焦點在不在播放器身上，跟這支腳本要驗的版面尺寸無關；
    # 手動探測過在這個 sandbox pod 的 browser-use Chromium 底下，
    # `frame.contentWindow?.focus()`／`window.focus()` 這條 cross-document
    # focus 路徑經常收不到（headless CDP 附加的分頁沒有真正的視窗焦點），
    # 即使投影片本身已經完整渲染且量測穩定——用它當作「播放模式就緒」的
    # 訊號在這個 harness 下會誤判成逾時。
    deadline = time.time() + 15.0
    ready = False
    while time.time() < deadline:
        try:
            if js("document.querySelectorAll('.titlebar').length") != 0:  # noqa: F821
                time.sleep(0.2)
                continue
            frame_id = _stage_iframe_target_id(attempts=1)
            state = js("document.readyState", target_id=frame_id)  # noqa: F821
            has_svg = js("!!document.querySelector('svg')", target_id=frame_id)  # noqa: F821
            if state == "complete" and has_svg:
                ready = True
                break
        except Exception:  # noqa: BLE001 - iframe 可能還在重建中，繼續輪詢
            pass
        time.sleep(0.2)
    if not ready:
        print("FAIL 進入播放模式逾時：15 秒內播放 iframe 沒有渲染完成")
        return 1

    play_stage = _measure_scroll("document.querySelector('.stage')")
    _no_overflow("播放模式 .stage", play_stage)
    play_srcdoc = _measure_srcdoc()
    _no_overflow("播放模式 srcdoc documentElement", play_srcdoc)

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


raise SystemExit(main())
