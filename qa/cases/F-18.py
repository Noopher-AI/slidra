"""F-18：匯出錯誤訊息被推到畫面外，順帶驗證一次成功的匯出（父票 NOOP-355
#287，本票 NOOP-396）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
`open_deck()`，`browser_harness.helpers` 提供 `js(expression,
target_id=None)`）；CLI 呼叫直接 subprocess 到 `slidra`（`--json` 取
結構化結果，格式見 docs/spec/cli.md「CommandResult」一節：
`{"ok":bool,"data":...,"message":str,"failureKind"？:str}`）。

判準（父票驗收條件原文）：製造一次匯出失敗，`.export-status-error` 的
`getBoundingClientRect().left ≥ 0` 且第一行文字可見；再做一次成功的匯
出，檔案存在。

**如何製造夠長的失敗訊息**：demo 沒有現成的「後端會吐長訊息」的 fixture
（改共用 fixture 會動到別的既有測試），改用 CLI 在 demo 第 1 頁插入一個
`--media` 值刻意加長、副檔名 `.xyz`（不受支援）的媒體佔位符元素，再對它
加一個 `family=media effect=play` 的效果——`player-plan.ts` 的
`mediaKindFor()` 在匯出時解析到不支援的副檔名會丟出
`元素「<id>」的 data-slidra-media「<原樣的長字串>」副檔名「.xyz」不是支援
的媒體格式...`，長度遠超過 `.export-status` 原本 `nowrap` 版面的可視寬
度，足以重現 F-18（`docs/spec/cli.md` 已確認 `--media` 對任何 kind 皆可
使用、值不驗證；`effect add --family media --effect play` 同樣有效）。

**還原**（qa/README.md §3.5「髒掉的簡報」）：量完之後用 `effect remove`
+ `element delete` 拆掉這兩筆改動，再做成功匯出的量測——不然這份簡報會一
直帶著這個壞掉的效果，後續任何案例腳本都會對著錯的內容下判斷。**不要求
位元組完全一致**：`effect remove` 刪光一份效果清單的最後一項後，容器本身
`<metadata><slidra:effects .../></metadata>` 會留下（手動核對過，這是
`effect remove`／`effect add` 現有行為，不是這支腳本的殘留——`effect
list` 對著它一樣正常回報 `effects: []`，不是錯誤，其他案例腳本也不讀
`slides/001.svg` 的效果清單），這個空殼不影響任何行為，只斷言「插入的
rect 元素 id 與 `slidra:effect ` 這個真實效果項目都不在了」，而不是逐位元
組比對。
"""

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def slidra(*args: str) -> dict:
    result = subprocess.run(
        ["slidra", *args, "--json"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0 and not result.stdout.strip():
        raise RuntimeError(f"slidra {' '.join(args)} 失敗：exit={result.returncode} stderr={result.stderr!r}")
    return json.loads(result.stdout)


def main() -> int:  # noqa: PLR0915 - 單一線性流程，拆函式反而更難對照「造→量→還原→再量」四步
    presentation_id = __import__("os").environ["SLIDRA_QA_PRESENTATION_ID"]
    slide_path = "slides/001.svg"

    original = subprocess.run(
        ["slidra", "cat", presentation_id, slide_path],
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout

    if "slidra:effect " in original:
        print(
            "FAIL slides/001.svg 開跑前就帶著既有的 slidra:effect——這支腳本假設乾淨的"
            "demo 起點（cleanup 時假設新加的效果是 index 1）。先確認 QA 環境是不是"
            "帶著上一次失敗留下的殘留，或改跑一份乾淨的 demo。"
        )
        return 1

    open_deck()  # noqa: F821

    long_media = "placeholder-" + ("長訊息驗證用填充字元" * 20) + ".xyz"
    inserted = slidra(
        "element", "insert", "rect", presentation_id, slide_path,
        "--x", "0", "--y", "0", "--width", "10", "--height", "10",
        "--media", long_media,
    )
    if not inserted.get("ok"):
        print(f"FAIL element insert 失敗：{inserted}")
        return 1
    element_id = inserted["data"]["elementId"]

    effect_added = slidra(
        "effect", "add", presentation_id, slide_path, element_id,
        "--family", "media", "--effect", "play",
    )
    if not effect_added.get("ok"):
        print(f"FAIL effect add 失敗：{effect_added}")
        # 插入的元素已經寫進檔案，即使後面這步失敗也要清乾淨再離開。
        slidra("element", "delete", presentation_id, slide_path, element_id)
        return 1

    try:
        js(  # noqa: F821
            "document.querySelector('.titlebar-button.export-toggle-button').click()"
        )
        deadline = time.time() + 5.0
        menu_ready = False
        while time.time() < deadline:
            if js("!!document.querySelector('[role=\"menu\"]')"):  # noqa: F821
                menu_ready = True
                break
            time.sleep(0.2)
        if not menu_ready:
            print("FAIL 5 秒內沒有看到 Export 選單")
            return 1

        js(  # noqa: F821
            "Array.from(document.querySelectorAll('.export-menu-item'))"
            ".find(b=>b.textContent.includes('One page per slide')).click()"
        )

        deadline = time.time() + 30.0
        error_seen = False
        while time.time() < deadline:
            if js("!!document.querySelector('.export-status-error')"):  # noqa: F821
                error_seen = True
                break
            time.sleep(0.3)
        if not error_seen:
            print("FAIL 30 秒內沒有出現 .export-status-error（預期的匯出失敗沒有發生）")
            return 1

        error_text = js("document.querySelector('.export-status-error').textContent")  # noqa: F821
        check("錯誤訊息包含合成的長 data-slidra-media 值", long_media in (error_text or ""), (error_text or "")[:120])

        geometry = js(  # noqa: F821
            "(()=>{const el=document.querySelector('.export-status-error');"
            "const r=el.getBoundingClientRect();return {left:r.left,top:r.top};})()"
        )
        check("錯誤區塊 left ≥ 0（沒有被推出畫面外）", geometry["left"] >= 0, geometry)
        check("錯誤區塊 top ≥ 0（第一行落在畫面內）", geometry["top"] >= 0, geometry)
    finally:
        # 還原：不論上面量到什麼，先把插入的效果／元素拆掉，簡報不能帶著
        # 這個合成的壞資料留給下一支案例腳本。
        slidra("effect", "remove", presentation_id, slide_path, "1")
        slidra("element", "delete", presentation_id, slide_path, element_id)

    restored = subprocess.run(
        ["slidra", "cat", presentation_id, slide_path],
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout
    # 不比對位元組：`effect remove` 刪掉最後一項後會留下空的
    # `<slidra:effects>` 容器（見檔頭docstring），這是既有行為，不是這支
    # 腳本的殘留。只確認插入的元素與這個合成效果都真的不在了。
    check("還原後找不到插入的元素 id", element_id not in restored, element_id in restored)
    check("還原後找不到 slidra:effect 項目（空容器可以留著）", "slidra:effect " not in restored, "slidra:effect " in restored)

    # 關掉還沒關的錯誤面板／選單殘留狀態，確保下面的成功匯出走乾淨的起手式。
    js(  # noqa: F821
        "(()=>{const d=document.querySelector('.export-status-dismiss');if(d)d.click();})()"
    )

    js("document.querySelector('.titlebar-button.export-toggle-button').click()")  # noqa: F821
    deadline = time.time() + 5.0
    menu_ready = False
    while time.time() < deadline:
        if js("!!document.querySelector('[role=\"menu\"]')"):  # noqa: F821
            menu_ready = True
            break
        time.sleep(0.2)
    if not menu_ready:
        print("FAIL 5 秒內沒有看到 Export 選單（成功匯出路徑）")
        return 1
    js(  # noqa: F821
        "Array.from(document.querySelectorAll('.export-menu-item'))"
        ".find(b=>b.textContent.includes('One page per slide')).click()"
    )

    deadline = time.time() + 30.0
    done_seen = False
    while time.time() < deadline:
        if js("!!document.querySelector('.export-status-done a')"):  # noqa: F821
            done_seen = True
            break
        time.sleep(0.3)
    if not done_seen:
        print("FAIL 30 秒內沒有出現 .export-status-done（還原後的成功匯出沒有發生）")
        return 1

    href = js("document.querySelector('.export-status-done a').getAttribute('href')")  # noqa: F821
    base_url = __import__("os").environ["SLIDRA_QA_URL"].rstrip("/")
    download_url = href if href.startswith("http") else f"{base_url}{href if href.startswith('/') else '/' + href}"
    with urllib.request.urlopen(download_url, timeout=30) as response:  # noqa: S310 - 固定指向本機 QA server
        payload = response.read()
    check("下載的匯出檔以 %PDF 開頭", payload[:4] == b"%PDF", payload[:20])
    check("下載的匯出檔大小 > 1000 bytes", len(payload) > 1000, len(payload))

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


raise SystemExit(main())
