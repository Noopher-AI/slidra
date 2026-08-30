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
  // Four corners only (top-left/top-right on `.sel::before`/`::after`,
  // bottom-left/bottom-right on `.sel i::before`/`::after`) — deliberately
  // not eight handles (the template's `b`/`u` elements are never created):
  // eight handles mean "you can drag this" in every tool, and neither
  // resize nor rotate handles are part of this ticket's delivered scope
  // (see the PR body's 風險與未處理項) — a multi-selection or a plain drag
  // must never show them.
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
    ".guide{position:fixed;background:" +
    colors.accent +
    ";pointer-events:none;}" +
    ".guide.v{width:1px;top:0;bottom:0;}" +
    ".guide.h{height:1px;left:0;right:0;}";
  shadow.appendChild(style);

  var box = document.createElement("div");
  box.className = "sel";
  box.appendChild(document.createElement("i"));
  shadow.appendChild(box);

  var marqueeBox = document.createElement("div");
  marqueeBox.className = "marquee";
  marqueeBox.style.display = "none";
  shadow.appendChild(marqueeBox);

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

  // Redraws whatever `selectedIds` currently holds. Called after every
  // selection change (click, marquee) and on resize/preview so the box(es)
  // track the element(s) as they move.
  function updateBoxes() {
    if (selectedIds.length === 0) {
      hideBox();
      hideMultiBoxes();
      return;
    }
    if (selectedIds.length === 1) {
      hideMultiBoxes();
      showBox();
      return;
    }
    hideBox();
    showMultiBoxes(selectedIds);
  }

  // Hit resolution: walk up from the clicked element to the `<svg>` root
  // and return the OUTERMOST ancestor carrying an `id` — not the nearest
  // one (#72). See the original comment history for the full rationale;
  // unchanged by this ticket.
  function findSelectable(el) {
    var current = el;
    var outermost = null;
    while (current && current !== document.body) {
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
      var target = findSelectable(event.target);
      var additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!target) {
        if (additive) return; // Shift/Cmd-click on blank changes nothing.
        selectedIds = [];
        updateBoxes();
        post({ event: "clear" });
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
      post({ event: "select", id: id, name: name, additive: additive });
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

  window.addEventListener(
    "pointerdown",
    function (event) {
      if (event.button !== 0) return; // Left button only — no gesture on right/middle click.
      var hit = findSelectable(event.target);
      gesture = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        lastClient: { x: event.clientX, y: event.clientY },
        hitId: hit ? hit.getAttribute("id") : null,
        started: false,
        kind: null,
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
        gesture.kind = gesture.hitId ? "move" : "marquee";
        if (gesture.kind === "move" && selectedIds.indexOf(gesture.hitId) === -1) {
          // Dragging an element that was not already part of the current
          // selection replaces the selection with just that element — the
          // same "select, then move" behaviour every direct-manipulation
          // editor gives a plain (non-additive) drag (§4.2's "多選" row
          // implies the selection in effect at drag start is what moves).
          var target = document.getElementById(gesture.hitId);
          selectedIds = [gesture.hitId];
          updateBoxes();
          post({ event: "select", id: gesture.hitId, name: target ? target.getAttribute("data-comot-name") : null, additive: false });
        }
        post({ event: "gesture-start", kind: gesture.kind, handle: null, point: gesture.startClient });
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
    if (event.key === "Escape" && gesture) {
      endGesture(gesture.lastClient, true);
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

  function applyPreviewTextbox(id, width) {
    // Reserved for the textbox-width gesture (§4.4), not part of this
    // ticket's delivered scope — see the PR body. Left as a documented
    // no-op rather than omitted outright, so a future unit extending this
    // runtime has an obvious seam instead of having to reinvent the host
    // command name.
    void id;
    void width;
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
      applyPreviewTextbox(data.id, data.width);
    } else if (data.command === "guides") {
      drawGuides(data.lines);
    } else if (data.command === "marquee") {
      drawMarquee(data.rect);
    } else if (data.command === "selection") {
      selectedIds = Array.isArray(data.ids) ? data.ids.slice() : [];
      updateBoxes();
    }
  });
})();
