// Plain JavaScript, no imports, self-contained — inlined into the view
// `srcdoc`'s <script> by the parent (canvas.ts, via `?raw`). Runs inside a
// sandboxed iframe with `allow-scripts` and no `allow-same-origin`
// (ADR-0011), so it has no way to reach anything outside itself except
// `postMessage`.
//
// Its job (NOOP-91 extends #56's original click-only version): report which
// element was clicked (hit resolution), draw a selection box over it, and
// report raw pointer coordinates for direct-manipulation gestures (drag,
// marquee) — never doing geometry math itself. All of that math (preview
// transforms, snapping, bounding boxes) lives in the parent (canvas.ts),
// using `@co-motion/core`, because this script cannot import anything: it
// is a `?raw` string with no module system. This runtime only ever reports
// raw coordinates and paints whatever the parent already computed.
(function () {
  "use strict";

  // Injected by the parent before this script runs (see canvas.ts's
  // wrapSelectionDocument) — the accent/handle colours come from the
  // parent's own tokens.css via getComputedStyle(document.documentElement),
  // never hard-coded here: this document is opaque-origin and has no
  // access to the parent's :root at all.
  var colors = window.__COMOT_SELECTION_COLORS__ || {};

  // Captured once, at init, rather than read as `parent` at click/message
  // time: `window.parent` is a writable global on this document and a
  // hostile slide script could reassign it before a click ever fires. This
  // runtime is injected first (canvas.ts's wrapSelectionDocument), so it is
  // the first script to run in this document and this is the
  // earliest-possible capture.
  var parentWindow = parent;

  function post(message) {
    // Same reasoning as player-runtime.js's post(): this frame is
    // opaque-origin, so there is no meaningful target origin to name.
    var payload = { source: "comot-selection" };
    for (var key in message) {
      if (Object.prototype.hasOwnProperty.call(message, key)) {
        payload[key] = message[key];
      }
    }
    parentWindow.postMessage(payload, "*");
  }

  /**
   * Attaches the current `groupPath` to a "select"/"clear" message, but
   * only when it is non-empty. Existing tests (and canvas.ts's own
   * postMessage-shape assertions, jsdom side) `toEqual` the exact plain
   * top-level message shape with no `groupPath` field at all — omitting it
   * whenever there is nothing to report keeps every one of those exact
   * either unchanged. The host treats a missing field the same as `[]`
   * (`select`/`clear` always describe the FULL current state, never a
   * delta), so this is lossless: entering/staying in a group is the only
   * case that ever needs the field, and that is also the only case where
   * `groupPath` is non-empty.
   */
  function withGroupPath(message) {
    if (groupPath.length > 0) message.groupPath = groupPath.slice();
    return message;
  }

  // The shadow *host* lives in the light DOM, where the slide's own CSS
  // can still target it (e.g. `* { display: none !important }`). Every
  // property that could hide or bury it is set inline with `!important`,
  // which outranks an author stylesheet's own `!important` in the
  // cascade. What lives *inside* the shadow root is safe from the outer
  // document's CSS entirely — a `*`/`::before` rule in the slide's <style>
  // does not cross the shadow boundary — which is why the box's actual
  // geometry and corner decorations are built there instead.
  var host = document.createElement("div");
  // Identifies the shadow host by attribute, not DOM position: this
  // runtime now runs before `bodyMarkup` is parsed (wrapSelectionDocument,
  // canvas.ts), so the host is no longer document.body's last child once
  // the slide markup lands after it.
  host.setAttribute("data-comot-selection-host", "");
  var important = "important";
  host.style.setProperty("all", "initial", important);
  host.style.setProperty("display", "block", important);
  host.style.setProperty("position", "fixed", important);
  host.style.setProperty("top", "0", important);
  host.style.setProperty("left", "0", important);
  host.style.setProperty("width", "0", important);
  host.style.setProperty("height", "0", important);
  host.style.setProperty("visibility", "visible", important);
  host.style.setProperty("opacity", "1", important);
  host.style.setProperty("z-index", "2147483647", important);
  host.style.setProperty("pointer-events", "none", important);
  document.body.appendChild(host);

  var shadow = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  // Four corners only on `.sel` itself (top-left/top-right on
  // `.sel::before`/`::after`, bottom-left/bottom-right on
  // `.sel i::before`/`::after`) — those are pure decoration, never
  // interactive. The scale/rotate/textbox-width handles are separate real
  // elements (`.handle`), each carrying `pointer-events:auto` so a gesture
  // can start on them even though the shadow host and every other overlay
  // element stay `pointer-events:none`.
  style.textContent =
    ".sel{position:fixed;box-sizing:border-box;outline:1px solid " +
    colors.accent +
    ";pointer-events:none;display:none;}" +
    ".sel::before,.sel::after,.sel i::before,.sel i::after{content:\"\";position:absolute;width:7px;height:7px;background:" +
    colors.handle +
    ";border:1px solid " +
    colors.accent +
    ";}" +
    ".sel::before{left:-4px;top:-4px;}" +
    ".sel::after{right:-4px;top:-4px;}" +
    ".sel i::before{left:-4px;bottom:-4px;}" +
    ".sel i::after{right:-4px;bottom:-4px;}" +
    ".sel-multi{position:fixed;box-sizing:border-box;outline:1px solid " +
    colors.accent +
    ";pointer-events:none;}" +
    ".marquee{position:fixed;box-sizing:border-box;border:1px dashed " +
    colors.accent +
    ";background:color-mix(in srgb, " +
    colors.accent +
    " 12%, transparent);pointer-events:none;}" +
    ".group-frame{position:fixed;box-sizing:border-box;border:1px dashed " +
    colors.accent +
    ";pointer-events:none;display:none;}" +
    ".guide{position:fixed;background:" +
    colors.accent +
    ";pointer-events:none;}" +
    ".guide.v{width:1px;top:0;bottom:0;}" +
    ".guide.h{height:1px;left:0;right:0;}" +
    ".handle{position:fixed;box-sizing:border-box;width:9px;height:9px;margin:-4px 0 0 -4px;background:" +
    colors.handle +
    ";border:1px solid " +
    colors.accent +
    ";pointer-events:auto;display:none;}" +
    ".handle.corner{cursor:nwse-resize;}" +
    ".handle.rotate{border-radius:50%;cursor:grab;}" +
    ".handle.edge{cursor:ew-resize;}";
  shadow.appendChild(style);

  // One handle div per role, created once and repositioned/hidden on every
  // updateBoxes() call — same reuse pattern as multiBoxEls/guideEls below.
  // "nw"/"ne"/"sw"/"se" are the four corner scale handles, "rotate" sits
  // above top-center, "width-left"/"width-right" are the textbox mid-edge
  // handles.
  var HANDLE_NAMES = ["nw", "ne", "sw", "se", "rotate", "width-left", "width-right"];
  var handleEls = {};
  for (var hi = 0; hi < HANDLE_NAMES.length; hi++) {
    var hname = HANDLE_NAMES[hi];
    var hel = document.createElement("div");
    hel.className = "handle " + (hname === "rotate" ? "rotate" : hname === "width-left" || hname === "width-right" ? "edge" : "corner");
    hel.setAttribute("data-comot-handle", hname);
    shadow.appendChild(hel);
    handleEls[hname] = hel;
  }

  /** Fixed screen-px distance the rotate handle sits above the box's top edge. */
  var ROTATE_HANDLE_OFFSET = 24;

  // Which handles the host currently allows, per the last "selection" host
  // command (NOOP-91 follow-up §5): "full" (single, non-textbox-only
  // selection — corner + rotate), "move-only" (0 or 2+ selected — no
  // handles at all beyond the plain box), "none". `textboxHandles` is an
  // independent flag layered on top of "full": textbox-width handles show
  // only when the host says the single selected element is a text box.
  var handleMode = "none";
  var textboxHandlesEnabled = false;

  function hideAllHandles() {
    for (var i = 0; i < HANDLE_NAMES.length; i++) handleEls[HANDLE_NAMES[i]].style.display = "none";
  }

  function positionHandles() {
    if (selectedIds.length !== 1) {
      hideAllHandles();
      return;
    }
    var el = document.getElementById(selectedIds[0]);
    if (!el) {
      hideAllHandles();
      return;
    }
    var rect = el.getBoundingClientRect();
    var showScaleRotate = handleMode === "full";
    var corners = {
      nw: { x: rect.left, y: rect.top },
      ne: { x: rect.left + rect.width, y: rect.top },
      sw: { x: rect.left, y: rect.top + rect.height },
      se: { x: rect.left + rect.width, y: rect.top + rect.height },
    };
    for (var key in corners) {
      if (!Object.prototype.hasOwnProperty.call(corners, key)) continue;
      var cel = handleEls[key];
      if (showScaleRotate) {
        cel.style.display = "block";
        cel.style.left = corners[key].x + "px";
        cel.style.top = corners[key].y + "px";
      } else {
        cel.style.display = "none";
      }
    }
    var rotateEl = handleEls.rotate;
    if (showScaleRotate) {
      rotateEl.style.display = "block";
      rotateEl.style.left = rect.left + rect.width / 2 + "px";
      rotateEl.style.top = rect.top - ROTATE_HANDLE_OFFSET + "px";
    } else {
      rotateEl.style.display = "none";
    }
    var showTextbox = textboxHandlesEnabled;
    var leftEl = handleEls["width-left"];
    var rightEl = handleEls["width-right"];
    if (showTextbox) {
      leftEl.style.display = "block";
      leftEl.style.left = rect.left + "px";
      leftEl.style.top = rect.top + rect.height / 2 + "px";
      rightEl.style.display = "block";
      rightEl.style.left = rect.left + rect.width + "px";
      rightEl.style.top = rect.top + rect.height / 2 + "px";
    } else {
      leftEl.style.display = "none";
      rightEl.style.display = "none";
    }
  }

  var box = document.createElement("div");
  box.className = "sel";
  box.appendChild(document.createElement("i"));
  shadow.appendChild(box);

  var marqueeBox = document.createElement("div");
  marqueeBox.className = "marquee";
  marqueeBox.style.display = "none";
  shadow.appendChild(marqueeBox);

  // Pool of dashed frames, one per level of `groupPath` currently in scope
  // (outermost first) — distinct from `.sel`'s solid outline so "selected
  // the group" and "selected a child inside it" don't look identical, and
  // distinct *per level* so entering a nested group keeps every ancestor's
  // frame on screen instead of replacing it (NOOP-149 r2: a single-element
  // frame that just moved to the innermost level made the outer group
  // vanish the moment you entered it). Reused across updateBoxes() calls —
  // same pool pattern as multiBoxEls below. See groupFrameIds()/
  // positionGroupFrames() below.
  var groupFrameEls = [];

  // Pool of plain outline boxes for a multi-selection (>1 ids) — no corner
  // decorations, so acceptance criterion 9 ("多選看不到把手") holds simply
  // because these elements never carry any. Reused across updateBoxes()
  // calls rather than recreated, to keep resize-driven repositioning cheap.
  var multiBoxEls = [];
  // Guide-line divs, reused the same way; count varies 0-2 per frame.
  var guideEls = [];

  // The ids currently selected, in selection order. Single source of truth
  // for what showBox()/showMultiBoxes() paint — kept in sync with the
  // parent's own CanvasState.selection via the "select"/"clear" messages
  // this script sends, and via the "selection" host command for gestures
  // the parent alone can resolve (marquee).
  var selectedIds = [];

  // Group ids entered via double-click, outermost first; [] at top level
  // (NOOP-91 follow-up §4.8's group-edit row). Purely local to this
  // runtime — it changes what findSelectable() below walks up to, and is
  // mirrored up to the host on every "select"/"clear"/"group-path" message
  // so CanvasState.selection.groupPath agrees, but no command is ever sent
  // for it.
  var groupPath = [];

  function positionBox() {
    if (selectedIds.length !== 1) return;
    var el = document.getElementById(selectedIds[0]);
    if (!el) return;
    var rect = el.getBoundingClientRect();
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  }

  function showBox() {
    box.style.display = "block";
    positionBox();
  }

  function hideBox() {
    box.style.display = "none";
  }

  function hideMultiBoxes() {
    for (var i = 0; i < multiBoxEls.length; i++) multiBoxEls[i].style.display = "none";
  }

  function showMultiBoxes(ids) {
    while (multiBoxEls.length < ids.length) {
      var el = document.createElement("div");
      el.className = "sel-multi";
      shadow.appendChild(el);
      multiBoxEls.push(el);
    }
    for (var i = 0; i < multiBoxEls.length; i++) {
      if (i >= ids.length) {
        multiBoxEls[i].style.display = "none";
        continue;
      }
      var target = document.getElementById(ids[i]);
      if (!target) {
        multiBoxEls[i].style.display = "none";
        continue;
      }
      var rect = target.getBoundingClientRect();
      var el2 = multiBoxEls[i];
      el2.style.display = "block";
      el2.style.left = rect.left + "px";
      el2.style.top = rect.top + "px";
      el2.style.width = rect.width + "px";
      el2.style.height = rect.height + "px";
    }
  }

  /**
   * The ids `.group-frame` boxes should currently outline, outermost
   * first: every level already entered (`groupPath`, in order), plus —
   * only when nothing has been entered yet — the top-level selected group
   * itself, so selecting a group still previews its frame before you
   * double-click into it. A group reached via `groupPath` never needs the
   * fallback added on top: `resolveClickTarget` never lets `selectedIds`
   * resolve to an id already on `groupPath` (the walk stops at the scope
   * boundary), so the `indexOf` guard is a defensive no-op, not a
   * necessary de-dupe.
   */
  function groupFrameIds() {
    var ids = groupPath.slice();
    if (selectedIds.length === 1) {
      var el = document.getElementById(selectedIds[0]);
      if (isGroupContainer(el) && ids.indexOf(selectedIds[0]) === -1) ids.push(selectedIds[0]);
    }
    return ids;
  }

  /** Screen-px each `.group-frame` sits outside its outlined element's own rect, so it never coincides exactly with `.sel`'s box on the same element. */
  var GROUP_FRAME_INSET = 3;

  function positionGroupFrames() {
    var ids = groupFrameIds();
    while (groupFrameEls.length < ids.length) {
      var el = document.createElement("div");
      el.className = "group-frame";
      shadow.appendChild(el);
      groupFrameEls.push(el);
    }
    for (var i = 0; i < groupFrameEls.length; i++) {
      var frameEl = groupFrameEls[i];
      var target = i < ids.length ? document.getElementById(ids[i]) : null;
      if (!target) {
        frameEl.style.display = "none";
        continue;
      }
      var rect = target.getBoundingClientRect();
      frameEl.style.display = "block";
      frameEl.style.left = rect.left - GROUP_FRAME_INSET + "px";
      frameEl.style.top = rect.top - GROUP_FRAME_INSET + "px";
      frameEl.style.width = rect.width + GROUP_FRAME_INSET * 2 + "px";
      frameEl.style.height = rect.height + GROUP_FRAME_INSET * 2 + "px";
    }
  }

  // Redraws whatever `selectedIds` currently holds. Called after every
  // selection change (click, marquee) and on resize/preview so the box(es)
  // track the element(s) as they move.
  function updateBoxes() {
    positionGroupFrames();
    if (selectedIds.length === 0) {
      hideBox();
      hideMultiBoxes();
      hideAllHandles();
      return;
    }
    if (selectedIds.length === 1) {
      hideMultiBoxes();
      showBox();
      positionHandles();
      return;
    }
    hideBox();
    hideAllHandles();
    showMultiBoxes(selectedIds);
  }

  // Hit resolution: walk up from `el` and return the OUTERMOST ancestor
  // carrying an `id` — not the nearest one (#72). `scopeId`, when given
  // (NOOP-91 follow-up's group-edit), stops the walk the moment it reaches
  // the element with that id: the walk never goes past the current
  // group's own boundary, so it resolves to the outermost id'd element
  // STRICTLY INSIDE the entered group rather than the group itself or
  // anything above it. When `el` is not actually inside the scope element
  // at all, the walk never reaches it and this degrades to the plain
  // top-level resolution — which is exactly the signal
  // resolveClickTarget() below uses to detect "clicked outside the
  // current group".
  function findSelectable(el, scopeId) {
    var current = el;
    var outermost = null;
    var scopeEl = scopeId ? document.getElementById(scopeId) : null;
    while (current && current !== document.body) {
      if (scopeEl && current === scopeEl) break;
      var tag = current.tagName ? current.tagName.toLowerCase() : "";
      if (tag === "svg") break;
      // T3 / ADR-0013: a locked element is not selectable at all in view
      // mode, and neither is anything inside it — checking only the
      // resolved `outermost` node let a locked child hide behind an
      // unlocked outer group and still be reachable. The lock check must
      // run on every ancestor on the way up, not just the one we end up
      // returning.
      if (current.getAttribute && current.getAttribute("data-comot-lock") === "true") {
        return null;
      }
      if (current.hasAttribute && current.hasAttribute("id")) outermost = current;
      current = current.parentElement;
    }
    return outermost;
  }

  /** True when `el` wraps at least one further id-carrying descendant — the normal form's own rule that only containers, never primitives, carry `id` (ADR-0012) makes this exactly "is `el` a group". */
  function isGroupContainer(el) {
    return !!(el && el.querySelector("[id]"));
  }

  /**
   * Resolves what a click/pointerdown at `rawTarget` hits, honouring the
   * current group-edit scope and exiting it when the click lands outside
   * the entered group. Mutates `groupPath` (never `selectedIds`) and
   * returns the resolved outermost-within-scope element, or null for a
   * miss. Shared by the click handler and pointerdown's own hit test so
   * a drag-to-select-then-move gesture scopes exactly the same way a
   * plain click does.
   */
  function resolveClickTarget(rawTarget) {
    if (groupPath.length > 0) {
      var scopeEl = document.getElementById(groupPath[groupPath.length - 1]);
      if (!scopeEl || !scopeEl.contains(rawTarget)) {
        groupPath = [];
      }
    }
    var effectiveScopeId = groupPath.length > 0 ? groupPath[groupPath.length - 1] : null;
    return findSelectable(rawTarget, effectiveScopeId);
  }

  // Set right before a completed drag/marquee gesture's trailing native
  // `click` event would otherwise fire (browsers dispatch `click` after
  // `pointerup` regardless of how far the pointer moved in between) —
  // without this, that click would re-run plain single-select logic and
  // silently collapse the multi-selection or reselection a gesture just
  // produced (found while building this ticket, not from any prior gate).
  var suppressNextClick = false;

  // Registered on `window`, in the capture phase, and as early as
  // possible (this runtime is injected before `bodyMarkup` — see
  // canvas.ts's wrapSelectionDocument). See the original comment history
  // for why capture-phase `window` is load-bearing against a hostile
  // slide script; unchanged by this ticket.
  window.addEventListener(
    "click",
    function (event) {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      var additive = event.shiftKey || event.metaKey || event.ctrlKey;
      var target = resolveClickTarget(event.target);
      if (!target) {
        if (additive) return; // Shift/Cmd-click on blank changes nothing.
        selectedIds = [];
        updateBoxes();
        post(withGroupPath({ event: "clear" }));
        return;
      }
      var id = target.getAttribute("id");
      var name = target.getAttribute("data-comot-name");
      if (additive) {
        var idx = selectedIds.indexOf(id);
        if (idx >= 0) selectedIds.splice(idx, 1);
        else selectedIds.push(id);
      } else {
        selectedIds = [id];
      }
      updateBoxes();
      post(withGroupPath({ event: "select", id: id, name: name, additive: additive }));
    },
    true,
  );

  // Double-click enters a group: pushes its id onto `groupPath` and
  // re-resolves the pointer's own target through `resolveClickTarget` at
  // the newly-entered scope (NOOP-91 follow-up's group-edit row; fixed
  // under NOOP-149r3 — see below). Never sends a command — this is pure
  // front-end selection-scope state. The two leading single clicks a
  // dblclick is made of already ran the plain click handler above and
  // left `selectedIds`/`groupPath` at whatever a normal (possibly
  // now-exited-scope) click would — this handler only refines that
  // further when the resolved target turns out to be a group.
  //
  // NOOP-149r3: this used to call a separate `nearestId(event.target)` —
  // the truly nearest id-carrying ancestor, ignoring scope entirely —
  // which could skip straight past an intervening un-entered group
  // container to a deeper descendant (e.g. entering a 3-level-nested
  // group's outer level and landing directly on the innermost leaf). That
  // produced a selection the drag/pointerdown hit-test (`resolveClickTarget`
  // + `findSelectable`'s OUTERMOST-within-scope rule, per ADR-0012 "a group
  // is a container of containers") disagreed with: the highlighted box
  // showed the leaf, but a following drag actually moved its enclosing
  // group. Calling `resolveClickTarget` again here — the exact same
  // function `click` and `pointerdown` already use — guarantees the
  // just-entered level's selection is always the same node a subsequent
  // click or drag at that scope would hit, by construction.
  window.addEventListener(
    "dblclick",
    function (event) {
      var target = resolveClickTarget(event.target);
      if (!target || !isGroupContainer(target)) return;
      groupPath.push(target.getAttribute("id"));
      var inner = resolveClickTarget(event.target);
      if (!inner) {
        updateBoxes();
        return;
      }
      selectedIds = [inner.getAttribute("id")];
      updateBoxes();
      post(withGroupPath({ event: "select", id: inner.getAttribute("id"), name: inner.getAttribute("data-comot-name"), additive: false }));
    },
    true,
  );

  window.addEventListener("resize", function () {
    reportViewport();
    updateBoxes();
  });

  // --- Direct manipulation: viewport reporting + raw gesture coordinates ---
  // (NOOP-91 §4.1). Everything below only ever reports numbers and applies
  // parent-computed results; no geometry is computed in this file.

  function reportViewport() {
    var svg = document.querySelector("svg");
    if (!svg) return;
    var rect = svg.getBoundingClientRect();
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var viewBox = vb
      ? { x: vb.x, y: vb.y, width: vb.width, height: vb.height }
      : { x: 0, y: 0, width: rect.width, height: rect.height };
    post({
      event: "viewport",
      svgRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewBox: viewBox,
    });
  }
  window.addEventListener("load", reportViewport);

  var DRAG_THRESHOLD_PX = 3;
  /** The in-progress pointer gesture, or null between gestures. */
  var gesture = null;
  var rafScheduled = false;
  var pendingMove = null;

  function scheduleGestureMove(point, modifiers) {
    pendingMove = { point: point, modifiers: modifiers };
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () {
      rafScheduled = false;
      if (!pendingMove) return;
      var move = pendingMove;
      pendingMove = null;
      post({ event: "gesture-move", point: move.point, modifiers: move.modifiers });
    });
  }

  function endGesture(point, cancelled) {
    if (!gesture) return;
    var started = gesture.started;
    gesture = null;
    pendingMove = null;
    if (started) {
      suppressNextClick = true;
      post({ event: "gesture-end", point: point, cancelled: cancelled });
    }
  }

  /** The `data-comot-handle` name at or inside `event`'s real (composed) target, or null. `composedPath()` sees into the open shadow root even though `event.target` itself gets retargeted to the shadow host once the event reaches a window-level listener. */
  function findHandleTarget(event) {
    var path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node && node.getAttribute && node.hasAttribute && node.hasAttribute("data-comot-handle")) {
        return node.getAttribute("data-comot-handle");
      }
    }
    return null;
  }

  window.addEventListener(
    "pointerdown",
    function (event) {
      if (event.button !== 0) return; // Left button only — no gesture on right/middle click.
      var handleName = findHandleTarget(event);
      var hit = handleName ? null : resolveClickTarget(event.target);
      gesture = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        lastClient: { x: event.clientX, y: event.clientY },
        hitId: hit ? hit.getAttribute("id") : null,
        handleName: handleName,
        started: false,
        kind: null,
        handle: null,
      };
    },
    true,
  );

  window.addEventListener(
    "pointermove",
    function (event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture.lastClient = { x: event.clientX, y: event.clientY };
      var dx = event.clientX - gesture.startClient.x;
      var dy = event.clientY - gesture.startClient.y;
      if (!gesture.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        gesture.started = true;
        if (gesture.handleName === "rotate") {
          gesture.kind = "rotate";
          gesture.handle = null;
        } else if (gesture.handleName === "width-left" || gesture.handleName === "width-right") {
          gesture.kind = "textbox-width";
          gesture.handle = gesture.handleName === "width-left" ? "left" : "right";
        } else if (gesture.handleName) {
          gesture.kind = "scale";
          gesture.handle = gesture.handleName;
        } else {
          gesture.kind = gesture.hitId ? "move" : "marquee";
          gesture.handle = null;
          if (gesture.kind === "move" && selectedIds.indexOf(gesture.hitId) === -1) {
            // Dragging an element that was not already part of the current
            // selection replaces the selection with just that element — the
            // same "select, then move" behaviour every direct-manipulation
            // editor gives a plain (non-additive) drag (§4.2's "多選" row
            // implies the selection in effect at drag start is what moves).
            var target = document.getElementById(gesture.hitId);
            selectedIds = [gesture.hitId];
            updateBoxes();
            post(withGroupPath({ event: "select", id: gesture.hitId, name: target ? target.getAttribute("data-comot-name") : null, additive: false }));
          }
        }
        post({ event: "gesture-start", kind: gesture.kind, handle: gesture.handle, point: gesture.startClient });
      }
      scheduleGestureMove({ x: event.clientX, y: event.clientY }, { shift: event.shiftKey, alt: event.altKey });
    },
    true,
  );

  window.addEventListener(
    "pointerup",
    function (event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      var point = { x: event.clientX, y: event.clientY };
      var wasStarted = gesture.started;
      gesture = null;
      pendingMove = null;
      if (wasStarted) {
        suppressNextClick = true;
        post({ event: "gesture-end", point: point, cancelled: false });
      }
    },
    true,
  );

  window.addEventListener("pointercancel", function (event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    endGesture(gesture.lastClient, true);
  });

  window.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (gesture) {
      endGesture(gesture.lastClient, true);
      return;
    }
    // Not mid-gesture (NOOP-91 follow-up's group-edit row): pop one level
    // of group-edit scope, or — already at the top — clear the selection
    // instead. Never both in the same keypress.
    if (groupPath.length > 0) {
      groupPath.pop();
      post({ event: "group-path", groupPath: groupPath.slice() });
      updateBoxes();
      return;
    }
    if (selectedIds.length > 0) {
      selectedIds = [];
      updateBoxes();
      post({ event: "clear" });
    }
  });

  // A right-click while a gesture is in progress cancels it instead of
  // opening the browser's context menu (§4.2's "拖曳中按 Esc" row extends
  // naturally to the other cancel gesture named in §4.1's gesture-end row).
  window.addEventListener("contextmenu", function (event) {
    if (gesture && gesture.started) {
      event.preventDefault();
      endGesture(gesture.lastClient, true);
    }
  });

  // --- Host -> runtime commands (parent has already done all the math) ---

  function applyPreview(items) {
    if (!Array.isArray(items)) return;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || typeof item.id !== "string" || typeof item.transform !== "string") continue;
      var el = document.getElementById(item.id);
      if (!el) continue;
      if (item.transform === "") el.removeAttribute("transform");
      else el.setAttribute("transform", item.transform);
    }
    updateBoxes();
  }

  /**
   * Textbox-width live preview (NOOP-91 follow-up §4.4): the host has
   * already computed the re-wrapped lines with `@co-motion/core`'s own
   * `wrapText` (the exact function `textbox width`'s server handler calls
   * internally) — this only ever swaps the `<text>` element's `<tspan>`
   * children for structured `{text, y}` data, never a raw HTML/XML string,
   * so there is no injection surface even though `text` is untrusted-slide
   * content round-tripped through the host.
   */
  function applyPreviewTextbox(id, lines, width) {
    var container = document.getElementById(id);
    if (!container) return;
    var textEl = container.querySelector("text");
    if (!textEl) return;
    while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
    if (Array.isArray(lines)) {
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line || typeof line.text !== "string" || typeof line.y !== "number") continue;
        var tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        tspan.setAttribute("x", "0");
        tspan.setAttribute("y", String(line.y));
        tspan.textContent = line.text;
        textEl.appendChild(tspan);
      }
    }
    if (typeof width === "number") container.setAttribute("data-comot-text-width", String(width));
    updateBoxes();
  }

  function drawGuides(lines) {
    if (!Array.isArray(lines)) lines = [];
    while (guideEls.length < lines.length) {
      var el = document.createElement("div");
      shadow.appendChild(el);
      guideEls.push(el);
    }
    for (var i = 0; i < guideEls.length; i++) {
      var guideEl = guideEls[i];
      if (i >= lines.length) {
        guideEl.style.display = "none";
        continue;
      }
      var line = lines[i];
      if (!line || (line.orientation !== "h" && line.orientation !== "v") || typeof line.position !== "number") {
        guideEl.style.display = "none";
        continue;
      }
      guideEl.className = "guide " + line.orientation;
      guideEl.style.display = "block";
      if (line.orientation === "v") guideEl.style.left = line.position + "px";
      else guideEl.style.top = line.position + "px";
    }
  }

  function drawMarquee(rect) {
    if (!rect || typeof rect.x !== "number" || typeof rect.y !== "number") {
      marqueeBox.style.display = "none";
      return;
    }
    marqueeBox.style.display = "block";
    marqueeBox.style.left = rect.x + "px";
    marqueeBox.style.top = rect.y + "px";
    marqueeBox.style.width = rect.width + "px";
    marqueeBox.style.height = rect.height + "px";
  }

  window.addEventListener("message", function (event) {
    // Only the parent frame may issue host commands — an opaque-origin
    // document has no same-origin script other than parent that could
    // legitimately be `event.source` here.
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!data || data.source !== "comot-host") return;
    if (data.command === "preview") {
      applyPreview(data.items);
    } else if (data.command === "preview-textbox") {
      applyPreviewTextbox(data.id, data.lines, data.width);
    } else if (data.command === "guides") {
      drawGuides(data.lines);
    } else if (data.command === "marquee") {
      drawMarquee(data.rect);
    } else if (data.command === "selection") {
      selectedIds = Array.isArray(data.ids) ? data.ids.slice() : [];
      // The host is authoritative for handle visibility (it alone knows
      // the slide model — whether the single selection is a text box) and
      // for group scope whenever IT drove the selection change (e.g.
      // marquee, which always operates at top level and so always exits
      // group-edit). A runtime-originated change already updated
      // `groupPath` itself before reporting up; this mirrors the host's
      // value back down rather than trusting it blindly, so the two sides
      // can never drift.
      handleMode = data.handles === "full" || data.handles === "move-only" ? data.handles : "none";
      textboxHandlesEnabled = Boolean(data.textbox);
      groupPath = Array.isArray(data.groupPath) ? data.groupPath.slice() : [];
      updateBoxes();
    }
  });
})();
