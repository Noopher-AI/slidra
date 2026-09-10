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
    current_tab as _current_tab,
    drain_events as _drain_events,
    http_get as _bh_http_get,
    new_tab as _new_tab,
    wait_for_load as _wait_for_load,
)

_DEFAULT_URL = "http://127.0.0.1:5173"
_FRAME_READY_TIMEOUT = 15.0
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SLIDE_NAV_RE = re.compile(r"Slide (\d+) of (\d+)")

# Read-only CDP/JS calls (below, via _cdp_ro/_js_ro) get this per-attempt
# response timeout and up to _IPC_RETRY_ATTEMPTS tries, _IPC_RETRY_INTERVAL
# apart, applied uniformly — including calls made from inside the existing
# polling loops (_wait_frame_ready, _wait_chip_update, status_bar() as used
# by _wait_status_bar_settled). Those loops already either catch a failed
# attempt and keep polling (_wait_frame_ready's readiness check) or simply
# never caught one before this change either (a bare 5s timeout already
# propagated unhandled out of _wait_chip_update / _wait_status_bar_settled
# pre-round-5) — so retrying with a longer, configurable timeout only makes
# an already-possible slow/failed iteration deliberate and legible instead
# of an accidental bare TimeoutError. _FRAME_READY_TIMEOUT/
# _DRAG_SETTLE_TIMEOUT themselves are untouched; a degraded environment may
# now spend one longer attempt before a loop's own deadline check ends it,
# rather than looping fast against a too-short per-call timeout.
_DEFAULT_IPC_TIMEOUT = 20.0
_IPC_RETRY_ATTEMPTS = 3
_IPC_RETRY_INTERVAL = 0.5
_CHIP_UPDATE_TIMEOUT = 2.0


def _ipc_timeout():
    """CO_MOTION_QA_IPC_TIMEOUT, parsed lazily (never at import time — this
    module's top-level code must never raise, see module docstring)."""
    raw = os.environ.get("CO_MOTION_QA_IPC_TIMEOUT")
    if raw is None or raw == "":
        return _DEFAULT_IPC_TIMEOUT
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"CO_MOTION_QA_IPC_TIMEOUT 必須是數字，收到 {raw!r}") from None
    if value <= 0:
        raise ValueError(f"CO_MOTION_QA_IPC_TIMEOUT 必須是正數，收到 {raw!r}")
    return value


def _cdp_ro(method, **params):
    """Read-only CDP call with retry-on-timeout. Never use this for
    Input.dispatchMouseEvent — a timeout there doesn't mean the event wasn't
    delivered, so retrying could double-fire a gesture (see _dispatch_mouse)."""
    timeout = _ipc_timeout()
    last_exc = None
    for attempt in range(1, _IPC_RETRY_ATTEMPTS + 1):
        try:
            return _cdp(method, _response_timeout=timeout, **params)
        except TimeoutError as exc:
            last_exc = exc
            if attempt < _IPC_RETRY_ATTEMPTS:
                time.sleep(_IPC_RETRY_INTERVAL)
    raise RuntimeError(
        f"{method} 逾時：已嘗試 {_IPC_RETRY_ATTEMPTS} 次，每次逾時 {timeout:g}s"
    ) from last_exc


def _js_ro(expression, target_id=None):
    """Runtime.evaluate with _cdp_ro's timeout+retry. Reimplements
    browser_harness.helpers.js()'s eval semantics because the public js()
    hardcodes a 5s response timeout with no override (verified: helpers.py
    js()/_send at :561/:53 take no caller-supplied timeout)."""
    session_id = None
    if target_id:
        session_id = _cdp_ro("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]
    try:
        r = _cdp_ro(
            "Runtime.evaluate",
            session_id=session_id,
            expression=expression,
            returnByValue=True,
            awaitPromise=True,
        )
        result = r.get("result", {})
        details = r.get("exceptionDetails")
        if details or result.get("subtype") == "error":
            desc = result.get("description") or (details or {}).get("text") or "JavaScript evaluation failed"
            raise RuntimeError(f"JavaScript evaluation failed: {desc}; expression: {expression[:160]!r}")
        if "value" in result:
            return result["value"]
        if "unserializableValue" in result:
            return result["unserializableValue"]
        return None
    finally:
        if session_id:
            try:
                _cdp("Target.detachFromTarget", sessionId=session_id)
            except Exception:
                pass


def _dispatch_mouse(**params):
    """Input.dispatchMouseEvent, no retry (round-5 plan): a timeout here
    doesn't mean the event wasn't delivered, so retrying could double-fire
    the gesture. On timeout, best-effort release the mouse button so it
    doesn't stay stuck down for the next caller, then raise."""
    timeout = _ipc_timeout()
    try:
        return _cdp("Input.dispatchMouseEvent", _response_timeout=timeout, **params)
    except TimeoutError as exc:
        if params.get("type") != "mouseReleased":
            try:
                _cdp(
                    "Input.dispatchMouseEvent",
                    _response_timeout=timeout,
                    type="mouseReleased",
                    x=params.get("x"),
                    y=params.get("y"),
                    button=params.get("button", "left"),
                    buttons=0,
                    clickCount=params.get("clickCount", 1),
                )
            except Exception:
                pass
        raise RuntimeError(
            f"Input.dispatchMouseEvent({params.get('type')}) 逾時（{timeout:g}s）；"
            "已嘗試補送 mouseReleased 避免滑鼠鍵卡在按下狀態"
        ) from exc


def _click(x, y, clicks=1):
    """pressed -> released at (x, y), via _dispatch_mouse — reimplements
    browser_harness.helpers.click_at_xy()'s gesture because that core
    primitive (imported nowhere in this module anymore) hardcodes a 5s
    response timeout with no override, same gap as js()."""
    _dispatch_mouse(type="mousePressed", x=x, y=y, button="left", clickCount=clicks)
    _dispatch_mouse(type="mouseReleased", x=x, y=y, button="left", clickCount=clicks)


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


def _activate_current_tab():
    """Bring the QA tab to the front via CDP Target.activateTarget.

    Verified empirically (round 5): a freshly opened/reused headless-Chromium
    tab is not necessarily the browser's "active" target (another target,
    e.g. the initial about:blank page, can hold that state). Input events
    dispatched to a non-active target still land on the right DOM element
    (confirmed via document.elementFromPoint at the click coordinates) but
    produce no app-level effect at all -- deterministically, every time, not
    intermittently -- because the click never becomes a registered
    interaction. This reproduces r3/r4's "select() chip stays empty" /
    "'NoneType' object is not subscriptable" failures independently of any
    IPC timeout."""
    try:
        tid = _current_tab()["targetId"]
    except Exception:
        return
    _cdp_ro("Target.activateTarget", targetId=tid)


def _iframe_frame_id():
    doc = _cdp_ro("DOM.getDocument", depth=0)
    root_id = doc.get("root", {}).get("nodeId")
    if not root_id:
        return None
    node_id = _cdp_ro("DOM.querySelector", nodeId=root_id, selector="iframe.slide-frame").get("nodeId")
    if not node_id:
        return None
    described = _cdp_ro("DOM.describeNode", nodeId=node_id, depth=0)
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
    for t in _cdp_ro("Target.getTargets").get("targetInfos", []):
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
                ready = _js_ro(
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
    rect = _js_ro(
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
    return _js_ro(expr, target_id=tid)


def _wait_chip_update(timeout=_CHIP_UPDATE_TIMEOUT):
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        text = (_js_ro("(document.querySelector('.status-selection-chip')||{}).textContent || ''") or "").strip()
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
    _activate_current_tab()
    _wait_for_load()
    # --window-size gives Chromium a window, not a viewport (verified: it
    # undershoots by however tall the OS chrome is). This is the only way
    # that reliably lands on exactly 1440x900, and it persists across
    # browser-use calls since it's a CDP-level override, not a CLI flag.
    _cdp_ro("Emulation.setDeviceMetricsOverride", width=1440, height=900, deviceScaleFactor=1, mobile=False)
    _wait_frame_ready()
    return {
        "url": url,
        "presentation_id": os.environ.get("CO_MOTION_QA_PRESENTATION_ID", ""),
        "slides": slide_count(),
    }


def goto_slide(n):
    """Click the overview thumbnail for slide `n` (1-based). Returns the
    slide number shown afterwards."""
    box = _js_ro(
        f"(()=>{{const el=document.querySelector('.overview-thumb[aria-label=\"Slide {int(n)}\"]');"
        "if(!el)return null;const r=el.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    if box is None:
        raise RuntimeError(f"goto_slide: 找不到縮圖 Slide {n}")
    _click(box["x"], box["y"])
    _wait_frame_ready()  # navigating rebuilds the srcdoc iframe -> new target id
    text = _js_ro("(document.querySelector('.slide-nav-position')||{}).textContent || ''") or ""
    m = _SLIDE_NAV_RE.search(text)
    if not m:
        raise RuntimeError(f"goto_slide: 無法解析頁碼：{text!r}")
    return int(m.group(1))


def slide_count():
    """Number of slides in the deck (parent-document overview list)."""
    return int(_js_ro("document.querySelectorAll('.overview-item').length"))


def select(name_or_id):
    """Click the element matched by `data-comot-name` (or `#id` for an
    `el-`-prefixed id) inside the slide iframe. Returns selection()."""
    tid = _wait_frame_ready()
    box = _find_target_box(tid, name_or_id)
    if box is None:
        names = _js_ro(
            "Array.from(document.querySelectorAll('[data-comot-name]')).map(e=>e.getAttribute('data-comot-name'))",
            target_id=tid,
        )
        raise RuntimeError(f"select: 找不到元素 {name_or_id!r}；本頁現有的 data-comot-name：{names!r}")
    off = _iframe_offset()
    cx = box["x"] + box["width"] / 2 + off["x"]
    cy = box["y"] + box["height"] / 2 + off["y"]
    _click(cx, cy)
    chip = _wait_chip_update()
    if not chip:
        # Round-5 plan contract: don't let an empty chip flow into
        # selection() and surface as a bare TypeError downstream (r4's
        # "'NoneType' object is not subscriptable") — report it here, where
        # we still know which element the click targeted.
        raise RuntimeError(
            f"select: 點擊 {name_or_id!r} 後等待 {_CHIP_UPDATE_TIMEOUT:g}s，選取 chip 仍為空"
            "（點擊可能沒有效果，或渲染被延後）"
        )
    return selection()


def selection():
    """Current selection: {"chip", "box", "handles"}. box/handles are in
    parent-document coordinates. Empty selection: {"chip": "", "box": None,
    "handles": {}}."""
    chip = (_js_ro("(document.querySelector('.status-selection-chip')||{}).textContent || ''") or "").strip()
    if not chip:
        return {"chip": "", "box": None, "handles": {}}
    tid = _wait_frame_ready()
    off = _iframe_offset()
    # Every `.handle` name (corners, rotate, the text-box width edges) is
    # always present in the DOM with display:none as its resting state; only
    # the ones applicable to the current selection get shown. Filter on
    # getComputedStyle, not the class list — showing/hiding is driven by
    # style.display writes on re-render, not a CSS class toggle.
    result = _js_ro(
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
    _dispatch_mouse(type="mousePressed", x=fx, y=fy, button="left", buttons=1, clickCount=1)
    for i in range(1, steps + 1):
        x = fx + (tx - fx) * i / steps
        y = fy + (ty - fy) * i / steps
        _dispatch_mouse(type="mouseMoved", x=x, y=y, button="left", buttons=1)
        time.sleep(0.016)
    _dispatch_mouse(type="mouseReleased", x=tx, y=ty, button="left", buttons=0, clickCount=1)
    _wait_status_bar_settled()


def dblclick(x, y):
    """Two pressed/released pairs at (x, y) in parent-document coordinates,
    clickCount 1 then 2."""
    _dispatch_mouse(type="mousePressed", x=x, y=y, button="left", buttons=1, clickCount=1)
    _dispatch_mouse(type="mouseReleased", x=x, y=y, button="left", buttons=0, clickCount=1)
    _dispatch_mouse(type="mousePressed", x=x, y=y, button="left", buttons=1, clickCount=2)
    _dispatch_mouse(type="mouseReleased", x=x, y=y, button="left", buttons=0, clickCount=2)


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
    info = _js_ro(
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
        inner = _js_ro(
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
    return _js_ro("(document.querySelector('footer.status.status-bar')||{}).textContent || ''") or ""


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
            sid = _cdp_ro("Target.attachToTarget", targetId=tid, flatten=True)["sessionId"]
            _cdp_ro("Runtime.enable", session_id=sid)
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
