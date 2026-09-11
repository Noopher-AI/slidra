"""F-16：動畫編號徽章擋住縮放把手（父票 NOOP-352／GitHub #284，[E5.T7]）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語）——這支腳本只用這個清單，不新增原語、不改寫成別的 harness：

    open_deck() / goto_slide(n) / select(name_or_id) / drag(from_xy, to_xy) /
    slide_svg(n) / console_errors()

**Plan 開工對帳（Dev-Planner，NOOP-384）**：F-16 已由 [E5.T3]（`e9da8cf`）
在 main 上修好——`.animation-badge` 的 `pointer-events: none` 移進
`stage-overlays.css` 的 `.stage-geometry, .stage-geometry * { pointer-
events: none !important }` 結構性規則，`BadgeLayer` 掛在該層之下，徽章
不會再擋住把手；`e2e/object-animation.test.ts:520-568` 已有同一行為的
e2e 回歸測試在 main 上綠燈。**這支腳本因此預期 base／分支都 PASS**（驗收
條件寫「本票 PASS、base FAIL」是父票／計畫沿用舊模板的殘留，不是這裡的
真實判準）——留著只是把票面指定的回歸案例腳本補齊，供 Dev-Reviewer 對照
父票驗收清單第二條打勾，PASS/PASS 不代表本票沒做事，代表 F-16 這部分不
是本票的修復範圍。
"""

import re  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def font_size_of(svg: str, element_id: str) -> str | None:
    """`<g id="el-step-one">...<text ... font-size="40" .../></g>` 的
    font-size 值——用最小可行的正規式抓同一個 `<g>` 區塊內第一個
    font-size，不引入完整 XML parser（這份腳本唯一需要的是「有沒有變」）。"""
    g_match = re.search(rf'<g id="{re.escape(element_id)}"[^>]*>(.*?)</g>', svg, re.S)
    if not g_match:
        return None
    fs_match = re.search(r'font-size="([^"]+)"', g_match.group(1))
    return fs_match.group(1) if fs_match else None


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(3)  # noqa: F821

    before = slide_svg(3)  # noqa: F821
    before_fs = font_size_of(before, "el-step-one")
    check("前置：el-step-one 縮放前 font-size=40", before_fs == "40", before_fs)

    sel = select("第一點")  # noqa: F821
    nw = sel["handles"].get("nw")
    check("前置：左上角把手 (nw) 存在", nw is not None, sel["handles"])
    if nw is None:
        print("總結：1 項失敗（無法取得把手座標，中止）")
        return 1

    # 票面重現手法：拖左上角把手往左上 (611,312) 一類座標，動畫徽章 ①
    # (603,304)-(619,320) 正好蓋住這個把手；[E5.T3] 已把徽章移到強制穿透
    # 的幾何層，這裡拖曳應該正常生效。
    drag(nw, (nw[0] - 40, nw[1] - 40))  # noqa: F821

    after = slide_svg(3)  # noqa: F821
    after_fs = font_size_of(after, "el-step-one")
    check("A 拖左上角把手後 el-step-one 的 font-size 改變（縮放生效）", after_fs is not None and after_fs != before_fs, after_fs)
    check("B 無 console error", console_errors() == [], console_errors())  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
