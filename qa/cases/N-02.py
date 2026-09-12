"""N-02：縮圖右鍵「Save as template」入口（父票 NOOP-357／GitHub #289）。

`qa/cases/F-15.py` 用的固定原語（open_deck()/goto_slide()/select()/
selection()/drag()/slide_svg()/status_bar()/console_errors()/shot()）是
`qa/agent_helpers.py` 針對「投影片畫布手勢」提供的介面。這張票要操作的
三個 UI（縮圖右鍵選單、Save as template 對話框、New 面板的 Layouts 清
單）全部落在畫布 iframe 之外的一般 parent-document DOM——`agent_helpers.py`
沒有對應原語（它的 select()/drag() 只查詢 iframe 內、帶 data-slidra-name
的畫布元素）。`browser-use` 的核心層 `browser_harness.helpers`
（`click_at_xy`/`js`/`fill_input`/`wait_for_element`/`http_get`）用同一
套 `exec(code, globals())` 機制成為全域名稱（`browser_harness/run.py`：
`from .helpers import *`），跟 `agent_helpers.py` 的原語是同一層注入的
另一半、不是另開一套 harness；本檔對 parent-document 的操作改用它們，
呼叫處同樣加 `# noqa: F821`。

判準：base（main）縮圖右鍵選單沒有「Save as template」項目——
`_menuitem_rect` 找不到就直接視為 FAIL 並中止（不會誤判成別的原因）；
PR 分支新增這一項後，存檔、Templates 清單即時出現、New › Layouts 套用
後新頁內容與來源頁一致，應全數 PASS。
"""

import json
import os

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _server_url() -> str:
    return os.environ.get("SLIDRA_QA_URL", "http://127.0.0.1:5173").rstrip("/")


def _read_project() -> dict:
    return json.loads(http_get(f"{_server_url()}/api/raw/project.json"))  # noqa: F821


def _center(selector: str) -> dict:
    r = js(  # noqa: F821
        f"(()=>{{const e=document.querySelector({json.dumps(selector)});"
        "if(!e)return null;const r=e.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    if r is None:
        raise RuntimeError(f"找不到元素：{selector}")
    return r


def _wait_gone(selector: str, timeout: float = 5.0) -> bool:
    """輪詢直到 `selector` 從 DOM 消失（或逾時），回傳是否真的消失了。`wait_for_element` 只等「出現」，方向相反，不能拿來等「關閉」。"""
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not js(f"!!document.querySelector({json.dumps(selector)})"):  # noqa: F821
            return True
        time.sleep(0.1)
    return not js(f"!!document.querySelector({json.dumps(selector)})")  # noqa: F821


def _menuitem_rect(text: str):
    """`[role=menuitem]` 裡文字以 `text` 開頭的第一個項目的中心座標，找不到回傳 None（呼叫端自行決定是 FAIL 還是中止）。"""
    return js(  # noqa: F821
        "(()=>{const items=[...document.querySelectorAll('[role=\"menuitem\"]')];"
        f"const el=items.find(e=>e.textContent.trim().startsWith({json.dumps(text)}));"
        "if(!el)return null;const r=el.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )


def main() -> int:
    open_deck()  # noqa: F821
    template_name = "N-02 範本"
    before = _read_project()
    source_path = before["slides"][1]  # 第 2 頁（0-based index 1）

    # 右鍵開啟第 2 頁縮圖的 context menu。
    thumb = _center('.overview-item[data-index="1"]')
    click_at_xy(thumb["x"], thumb["y"], button="right")  # noqa: F821
    ok = wait_for_element('[data-testid="thumb-context-menu"]', timeout=5, visible=True)  # noqa: F821
    check("A-1 縮圖右鍵選單開啟", ok, ok)
    if not ok:
        print("總結：1 項失敗（無法繼續）")
        return 1

    save_item = _menuitem_rect("Save as template")
    check("A-2 選單有「Save as template」項目（base 應該沒有）", save_item is not None, save_item)
    if save_item is None:
        print(f"總結：{len(FAILURES)} 項失敗（base 上的已知缺口，無法繼續）")
        return 1

    click_at_xy(save_item["x"], save_item["y"])  # noqa: F821

    # 對話框：輸入名稱、送出。
    ok = wait_for_element('[aria-label="Save as template"]', timeout=5, visible=True)  # noqa: F821
    check("B-1 Save as template 對話框開啟", ok, ok)
    fill_input(".save-template-modal-input", template_name)  # noqa: F821
    save_button = _center(".save-template-modal-submit")
    click_at_xy(save_button["x"], save_button["y"])  # noqa: F821
    modal_closed = _wait_gone('[aria-label="Save as template"]', timeout=5)
    check("B-2 存檔後對話框關閉", modal_closed, modal_closed)

    # Templates 清單即時出現新範本（不需重新整理頁面）。
    templates_button = js(  # noqa: F821
        "(()=>{const b=[...document.querySelectorAll('.rail-action-button')]"
        ".find(e=>e.textContent.trim().startsWith('Templates'));"
        "if(!b)return null;const r=b.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    click_at_xy(templates_button["x"], templates_button["y"])  # noqa: F821
    ok = wait_for_element('[role="menu"][data-menu="templates"]', timeout=5, visible=True)  # noqa: F821
    check("C-1 Templates 選單開啟", ok, ok)
    in_templates_menu = _menuitem_rect(template_name)
    check("C-2 Templates 清單即時出現新範本（未重新整理頁面）", in_templates_menu is not None, in_templates_menu)
    press_key("Escape")  # noqa: F821

    # New › Layouts 用新範本新增一頁。
    new_button = js(  # noqa: F821
        "(()=>{const b=[...document.querySelectorAll('.rail-action-button')]"
        ".find(e=>e.textContent.trim().startsWith('New'));"
        "if(!b)return null;const r=b.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    click_at_xy(new_button["x"], new_button["y"])  # noqa: F821
    ok = wait_for_element('[role="menu"][data-menu="new"]', timeout=5, visible=True)  # noqa: F821
    check("D-1 New 選單開啟", ok, ok)
    in_new_menu = _menuitem_rect(template_name)
    check("D-2 New › Layouts 清單即時出現新範本", in_new_menu is not None, in_new_menu)
    if in_new_menu is None:
        print(f"總結：{len(FAILURES)} 項失敗（無法繼續套用範本）")
        return 1
    click_at_xy(in_new_menu["x"], in_new_menu["y"])  # noqa: F821

    after = None
    import time

    deadline = time.time() + 10
    while time.time() < deadline:
        after = _read_project()
        if len(after["slides"]) == len(before["slides"]) + 1:
            break
        time.sleep(0.2)
    check(
        "E-1 slide_count() +1",
        after is not None and len(after["slides"]) == len(before["slides"]) + 1,
        None if after is None else len(after["slides"]),
    )

    new_slide_path = None
    if after is not None:
        candidates = [p for p in after["slides"] if p not in before["slides"]]
        new_slide_path = candidates[0] if candidates else None
    check("E-2 找得到新插入的投影片路徑", new_slide_path is not None, new_slide_path)

    if new_slide_path is not None:
        source_content = http_get(f"{_server_url()}/api/raw/{source_path}")  # noqa: F821
        new_content = http_get(f"{_server_url()}/api/raw/{new_slide_path}")  # noqa: F821
        import re

        def normalize_ids(svg: str) -> str:
            seen: dict[str, str] = {}
            counter = 0

            def repl(m: "re.Match[str]") -> str:
                nonlocal counter
                token = m.group(0)
                if token not in seen:
                    seen[token] = f"el-NORMALIZED-{counter}"
                    counter += 1
                return seen[token]

            return re.sub(r"el-[A-Za-z0-9_-]+", repl, svg)

        check(
            "E-3 新頁內容與第 2 頁一致（忽略重新產生的 element id）",
            normalize_ids(new_content) == normalize_ids(source_content),
            {"new_len": len(new_content), "source_len": len(source_content)},
        )

    check("F-1 無 console error", console_errors() == [], console_errors())  # noqa: F821
    shot("N-02")  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


raise SystemExit(main())
