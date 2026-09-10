"""CoMotion primitives for browser-use (BH_AGENT_WORKSPACE/agent_helpers.py).

Loaded once per `browser-use` invocation by browser_harness.helpers
(_load_agent_helpers): every top-level name not starting with "_" becomes a
global available to case scripts, the same way core helpers like js()/cdp()
are. Module-level code below must never fail — an exception here breaks
every browser-use call in this workspace, including `--doctor`.

Verified against browser-use 0.1.13. See qa/README.md for the primitive
list, known limitations, and how to run qa/cases/smoke.py.
"""

import json
import math
import os
import re
import time
from pathlib import Path

from browser_harness.helpers import (
    capture_screenshot as _capture_screenshot,
    cdp as _cdp,
    click_at_xy as _click_at_xy,
    current_tab as _current_tab,
    drain_events as _drain_events,
    http_get as _bh_http_get,
    js as _js,
    new_tab as _new_tab,
    wait_for_load as _wait_for_load,
)

_DEFAULT_URL = "http://127.0.0.1:5173"
_FRAME_READY_TIMEOUT = 15.0
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SLIDE_NAV_RE = re.compile(r"Slide (\d+) of (\d+)")


def _qa_dir():
    return Path(__file__).resolve().parent


def _server_url():
    return os.environ.get("CO_MOTION_QA_URL", _DEFAULT_URL).rstrip("/")


def _http_get(url):
    try:
        return _bh_http_get(url)
    except Exception as exc:
        hint = ""
        if not os.environ.get("CO_MOTION_QA_URL"):
            hint = "（CO_MOTION_QA_URL 未設，已使用預設值 http://127.0.0.1:5173；請先 source .quickstart/qa/qa.env）"
        raise RuntimeError(f"HTTP GET {url} 失敗：{exc}{hint}") from exc


def _iframe_frame_id():
    doc = _cdp("DOM.getDocument", depth=0)
    root_id = doc.get("root", {}).get("nodeId")
    if not root_id:
        return None
    node_id = _cdp("DOM.querySelector", nodeId=root_id, selector="iframe.slide-frame").get("nodeId")
    if not node_id:
        return None
    described = _cdp("DOM.describeNode", nodeId=node_id, depth=0)
    return described.get("node", {}).get("frameId")


def _iframe_target_id():
    """The slide iframe's CDP target id, or None if it doesn't exist yet.

    DOM.describeNode's frameId equals the OOPIF's Target.getTargets() targetId
    (verified empirically) — this is deliberately not iframe_target("srcdoc"),
    which matches every srcdoc iframe in the browser (overview thumbnails,
    other tabs), not just this deck's.
    """
    frame_id = _iframe_frame_id()
    if not frame_id:
        return None
    for t in _cdp("Target.getTargets").get("targetInfos", []):
        if t.get("type") == "iframe" and t.get("targetId") == frame_id:
            return frame_id
    return None


def _wait_frame_ready(timeout=_FRAME_READY_TIMEOUT):
    """Poll until the slide iframe exists, has a resolvable target, has
    rendered the selection-overlay host, AND has parsed the slide markup
    (a root <svg>). Re-resolved on every call — the target id changes
    across page navigations / slide changes, so it is never cached in a
    module variable.

    The selection host alone is not enough: it is appendChild'd by the
    runtime before bodyMarkup is parsed (NOOP-349 round 3), so a caller
    that only waited for the host could still race a marquee drag against
    an iframe with no <svg> yet. document.readyState is deliberately not
    checked here (round-3 plan §4.D) — it can sit at "interactive" for a
    long time on slow media/fonts, which would just move the timeout
    somewhere else without telling the caller anything about selection
    correctness.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        tid = _iframe_target_id()
        if tid:
            try:
                ready = _js(
                    "document.querySelector('[data-comot-selection-host]') != null "
                    "&& document.querySelector('svg') != null",
                    target_id=tid,
                )
            except Exception:
                ready = False
            if ready:
                return tid
        time.sleep(0.3)
    raise RuntimeError(f"投影片 iframe 在 {timeout:.0f} 秒內沒有就緒（slide-frame / frameId / selection host / svg markup 其中一項沒出現）")


def _iframe_offset():
    rect = _js(
        "(()=>{const f=document.querySelector('iframe.slide-frame');"
        "if(!f)return null;const r=f.getBoundingClientRect();return {x:r.x,y:r.y};})()"
    )
    if rect is None:
        raise RuntimeError("找不到 iframe.slide-frame（父文件）")
    return rect


def _find_target_box(tid, name_or_id):
    order = ["id", "name"] if name_or_id.startswith("el-") else ["name", "id"]
    expr = (
        f"(()=>{{const want={json.dumps(name_or_id)};const order={json.dumps(order)};"
        "let e=null;for(const kind of order){"
        "if(kind==='id'){e=document.getElementById(want);}"
        "else{e=Array.from(document.querySelectorAll('[data-comot-name]'))"
        ".find(x=>x.getAttribute('data-comot-name')===want)||null;}"
        "if(e)break;}"
        "if(!e)return null;const r=e.getBoundingClientRect();"
        "return {x:r.x,y:r.y,width:r.width,height:r.height};})()"
    )
    return _js(expr, target_id=tid)


def _wait_chip_update(timeout=2.0):
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        text = (_js("(document.querySelector('.status-selection-chip')||{}).textContent || ''") or "").strip()
        if text:
            return text
        time.sleep(0.1)
    return text


def open_deck():
    """Open (or reuse) the tab on CO_MOTION_QA_URL and wait for the deck to
    render. Returns {"url", "presentation_id", "slides"}."""
    url = _server_url()
    same = False
    try:
        cur = _current_tab()
        same = (cur.get("url") or "").rstrip("/") == url
    except Exception:
        same = False
    if not same:
        _new_tab(url)
    _wait_for_load()
    # --window-size gives Chromium a window, not a viewport (verified: it
    # undershoots by however tall the OS chrome is). This is the only way
    # that reliably lands on exactly 1440x900, and it persists across
    # browser-use calls since it's a CDP-level override, not a CLI flag.
    _cdp("Emulation.setDeviceMetricsOverride", width=1440, height=900, deviceScaleFactor=1, mobile=False)
    _wait_frame_ready()
    return {
        "url": url,
        "presentation_id": os.environ.get("CO_MOTION_QA_PRESENTATION_ID", ""),
        "slides": slide_count(),
    }


def goto_slide(n):
    """Click the overview thumbnail for slide `n` (1-based). Returns the
    slide number shown afterwards."""
    box = _js(
        f"(()=>{{const el=document.querySelector('.overview-thumb[aria-label=\"Slide {int(n)}\"]');"
        "if(!el)return null;const r=el.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    if box is None:
        raise RuntimeError(f"goto_slide: 找不到縮圖 Slide {n}")
    _click_at_xy(box["x"], box["y"])
    _wait_frame_ready()  # navigating rebuilds the srcdoc iframe -> new target id
    text = _js("(document.querySelector('.slide-nav-position')||{}).textContent || ''") or ""
    m = _SLIDE_NAV_RE.search(text)
    if not m:
        raise RuntimeError(f"goto_slide: 無法解析頁碼：{text!r}")
    return int(m.group(1))


def slide_count():
    """Number of slides in the deck (parent-document overview list)."""
    return int(_js("document.querySelectorAll('.overview-item').length"))


def select(name_or_id):
    """Click the element matched by `data-comot-name` (or `#id` for an
    `el-`-prefixed id) inside the slide iframe. Returns selection()."""
    tid = _wait_frame_ready()
    box = _find_target_box(tid, name_or_id)
    if box is None:
        names = _js(
            "Array.from(document.querySelectorAll('[data-comot-name]')).map(e=>e.getAttribute('data-comot-name'))",
            target_id=tid,
        )
        raise RuntimeError(f"select: 找不到元素 {name_or_id!r}；本頁現有的 data-comot-name：{names!r}")
    off = _iframe_offset()
    cx = box["x"] + box["width"] / 2 + off["x"]
    cy = box["y"] + box["height"] / 2 + off["y"]
    _click_at_xy(cx, cy)
    _wait_chip_update()
    return selection()


def selection():
    """Current selection: {"chip", "box", "handles"}. box/handles are in
    parent-document coordinates. Empty selection: {"chip": "", "box": None,
    "handles": {}}."""
    chip = (_js("(document.querySelector('.status-selection-chip')||{}).textContent || ''") or "").strip()
    if not chip:
        return {"chip": "", "box": None, "handles": {}}
    tid = _wait_frame_ready()
    off = _iframe_offset()
    # Every `.handle` name (corners, rotate, the text-box width edges) is
    # always present in the DOM with display:none as its resting state; only
    # the ones applicable to the current selection get shown. Filter on
    # getComputedStyle, not the class list — showing/hiding is driven by
    # style.display writes on re-render, not a CSS class toggle.
    result = _js(
        "(()=>{const host=document.querySelector('[data-comot-selection-host]');"
        "if(!host||!host.shadowRoot)return {box:null,handles:{}};"
        "const root=host.shadowRoot;const sel=root.querySelector('.sel');"
        "let box=null;if(sel){const r=sel.getBoundingClientRect();"
        "box={x:r.x,y:r.y,w:r.width,h:r.height};}"
        "const handles={};root.querySelectorAll('.handle').forEach(h=>{"
        "const name=h.getAttribute('data-comot-handle');if(!name)return;"
        "if(getComputedStyle(h).display==='none')return;"
        "const r=h.getBoundingClientRect();"
        "handles[name]=[r.x+r.width/2,r.y+r.height/2];});"
        "return {box:box,handles:handles};})()",
        target_id=tid,
    ) or {"box": None, "handles": {}}
    box = result.get("box")
    if box is not None:
        box = {"x": box["x"] + off["x"], "y": box["y"] + off["y"], "w": box["w"], "h": box["h"]}
    handles = {name: (xy[0] + off["x"], xy[1] + off["y"]) for name, xy in (result.get("handles") or {}).items()}
    return {"chip": chip, "box": box, "handles": handles}


_DRAG_SETTLE_TIMEOUT = 2.0
_DRAG_SETTLE_POLL = 0.1
_DRAG_SETTLE_STABLE_GAP = 0.1


def _wait_status_bar_settled(timeout=_DRAG_SETTLE_TIMEOUT):
    """Poll status_bar() until two reads at least _DRAG_SETTLE_STABLE_GAP
    apart return the same text, up to `timeout`. Never raises — PASS/FAIL is
    always decided by the case script's own assertions, not by this helper
    (round-3 plan §4.C); a caller that times out here just gets whatever the
    bar currently says, same as before this helper existed."""
    deadline = time.time() + timeout
    last = status_bar()
    last_read_at = time.time()
    while time.time() < deadline:
        time.sleep(_DRAG_SETTLE_POLL)
        cur = status_bar()
        now = time.time()
        if cur == last and (now - last_read_at) >= _DRAG_SETTLE_STABLE_GAP:
            return cur
        last, last_read_at = cur, now
    return last


def drag(from_xy, to_xy, steps=10):
    """CDP Input.dispatchMouseEvent pressed -> `steps` moved -> released, in
    parent-document coordinates. buttons=1 on every pressed/moved event is
    required — without it the page sees pointermove events with e.buttons==0
    and the drag gesture pipeline never engages. Raises ValueError when the
    total displacement is under 8px (below the app's 3px drag threshold,
    i.e. this would not register as a drag anyway).

    Before returning, waits (up to 2s) for the status bar text to stabilize
    (NOOP-349 round 3) — mouseReleased used to return immediately, racing
    every caller's next status_bar()/selection() read against the
    gesture-end -> host state update -> React re-render chain."""
    fx, fy = from_xy
    tx, ty = to_xy
    if math.hypot(tx - fx, ty - fy) < 8:
        raise ValueError("drag: 總位移小於 8px，等同沒有拖曳")
    _cdp("Input.dispatchMouseEvent", type="mousePressed", x=fx, y=fy, button="left", buttons=1, clickCount=1)
    for i in range(1, steps + 1):
        x = fx + (tx - fx) * i / steps
        y = fy + (ty - fy) * i / steps
        _cdp("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y, button="left", buttons=1)
        time.sleep(0.016)
    _cdp("Input.dispatchMouseEvent", type="mouseReleased", x=tx, y=ty, button="left", buttons=0, clickCount=1)
    _wait_status_bar_settled()


def dblclick(x, y):
    """Two pressed/released pairs at (x, y) in parent-document coordinates,
    clickCount 1 then 2."""
    _cdp("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", buttons=1, clickCount=1)
    _cdp("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", buttons=0, clickCount=1)
    _cdp("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", buttons=1, clickCount=2)
    _cdp("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", buttons=0, clickCount=2)


def slide_svg(n):
    """The raw source of slides/NNN.svg, read back from the server (not the
    DOM) via GET /api/raw/slides/NNN.svg."""
    return _http_get(f"{_server_url()}/api/raw/slides/{int(n):03d}.svg")


def save_state():
    """GET /api/save-state: {"known": True, "dirty": bool, "fileName": str}
    or {"known": False}."""
    return json.loads(_http_get(f"{_server_url()}/api/save-state"))


def active_element():
    """Parent document's document.activeElement, description. When it is
    the slide IFRAME, descends one level into the slide frame's own
    activeElement instead (in_iframe: True either way in that case)."""
    info = _js(
        "(()=>{const e=document.activeElement;if(!e)return null;"
        "return {tag:e.tagName,class:e.className||'',id:e.id||null};})()"
    )
    if info is None:
        return {"tag": "", "class": "", "id": None, "in_iframe": False}
    if info.get("tag") != "IFRAME":
        info["in_iframe"] = False
        return info
    tid = _iframe_target_id()
    if tid:
        inner = _js(
            "(()=>{const e=document.activeElement;if(!e)return null;"
            "return {tag:e.tagName,class:e.className||'',id:e.id||null};})()",
            target_id=tid,
        )
        if inner is not None:
            inner["in_iframe"] = True
            return inner
    info["in_iframe"] = True
    return info


def status_bar():
    """footer.status.status-bar's full textContent (chip, shortcut hints,
    page number)."""
    return _js("(document.querySelector('footer.status.status-bar')||{}).textContent || ''") or ""


def console_errors():
    """Console error messages seen since the last call — parent document and
    the slide iframe both included.

    Known limits (see qa/README.md): iframe errors are only captured after
    the iframe session below has been attached at least once (errors before
    the first console_errors() call on a given iframe target are missed);
    this shares the daemon's event buffer with wait_for_network_idle(), so
    the two are mutually exclusive within one polling window.
    """
    session_path = _qa_dir() / "out" / ".qa-session.json"
    state = {}
    if session_path.exists():
        try:
            state = json.loads(session_path.read_text())
        except Exception:
            state = {}
    tid = _iframe_target_id()
    if tid and state.get("iframe_target") != tid:
        try:
            sid = _cdp("Target.attachToTarget", targetId=tid, flatten=True)["sessionId"]
            _cdp("Runtime.enable", session_id=sid)
            state = {"iframe_target": tid, "iframe_session": sid}
            session_path.parent.mkdir(parents=True, exist_ok=True)
            session_path.write_text(json.dumps(state))
        except Exception:
            pass
    errors = []
    for event in _drain_events():
        if event.get("method") != "Runtime.consoleAPICalled":
            continue
        params = event.get("params", {})
        if params.get("type") != "error":
            continue
        text = " ".join(str(a.get("value", a.get("description", ""))) for a in params.get("args", []))
        errors.append(text)
    return errors


def shot(name):
    """Screenshot to qa/out/<name>.png (not version-controlled). `name` is
    restricted to [A-Za-z0-9._-]+ so this can never write outside qa/out/."""
    if not _NAME_RE.match(name):
        raise ValueError(f"shot: name 只能是 [A-Za-z0-9._-]+，收到 {name!r}")
    out_dir = _qa_dir() / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    return _capture_screenshot(str(out_dir / f"{name}.png"))
