// Plain JavaScript, no imports, self-contained — inlined into the view
// `srcdoc`'s <script> by the parent (canvas.ts, via `?raw`). Runs inside a
// sandboxed iframe with `allow-scripts` and no `allow-same-origin`
// (ADR-0011), so it has no way to reach anything outside itself except
// `postMessage`.
//
// Its whole job: report which element was clicked (hit resolution) and
// draw a four-corner selection box over it, in a Shadow DOM so the
// untrusted slide's own CSS cannot hide or cover it (ADR-0011's whole
// reason for existing). It never decides what "selected" means beyond
// that — the parent (canvas.ts) owns CanvasState.selection and the 顯示名稱
// fallback-to-識別碼 rule lives in the view layer (StatusBar.tsx).
(function () {
  "use strict";

  // Injected by the parent before this script runs (see canvas.ts's
  // wrapSelectionDocument) — the accent/handle colours come from the
  // parent's own tokens.css via getComputedStyle(document.documentElement),
  // never hard-coded here: this document is opaque-origin and has no
  // access to the parent's :root at all.
  var colors = window.__COMOT_SELECTION_COLORS__ || {};

  // Captured once, at init, rather than read as `parent` at click time:
  // `window.parent` is a writable global on this document and a hostile
  // slide script could reassign it before a click ever fires. This
  // runtime is injected first (canvas.ts's wrapSelectionDocument), so it
  // is the first script to run in this document and this is the
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
  // eight handles mean "you can drag this" in every tool, and this ticket
  // cannot drag.
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
    ".sel i::after{right:-4px;bottom:-4px;}";
  shadow.appendChild(style);

  var box = document.createElement("div");
  box.className = "sel";
  box.appendChild(document.createElement("i"));
  shadow.appendChild(box);

  // The currently selected element, or null. Kept so resize can
  // recompute the box's geometry without needing a fresh click.
  var currentTarget = null;

  function positionBox() {
    if (!currentTarget) return;
    var rect = currentTarget.getBoundingClientRect();
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  }

  function showBox(target) {
    currentTarget = target;
    box.style.display = "block";
    positionBox();
  }

  function hideBox() {
    currentTarget = null;
    box.style.display = "none";
  }

  // Hit resolution (settled in the dispatch): walk up from the clicked
  // element to the nearest ancestor carrying an `id` attribute, stopping
  // at the `<svg>` root or `<body>` without selecting either of those.
  function findSelectable(el) {
    var node = el;
    while (node && node !== document.body) {
      var tag = node.tagName ? node.tagName.toLowerCase() : "";
      if (tag === "svg") return null;
      if (node.hasAttribute && node.hasAttribute("id")) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Registered on `window`, in the capture phase, and as early as
  // possible (this runtime is injected before `bodyMarkup` — see
  // canvas.ts's wrapSelectionDocument). Capture on `window` is reached
  // before capture on `document`, which is reached before any bubbling
  // listener — so a bubbling `document` listener (the previous shape of
  // this code) can be silenced by a hostile slide script calling
  // `event.stopImmediatePropagation()` from anywhere on the way down.
  // Being on `window` in capture phase is necessary but not sufficient:
  // `stopImmediatePropagation()` also kills every other listener on the
  // *same target*, so a hostile capturing `window` listener registered
  // before ours would still win. Registering first (this script runs
  // before the slide's own script) is what actually wins that race —
  // see wrapSelectionDocument's comment. Do not move this back to
  // `document`/bubbling to "match" wrapPlayDocument's listener shape.
  window.addEventListener(
    "click",
    function (event) {
      var target = findSelectable(event.target);
      if (!target) {
        hideBox();
        post({ event: "clear" });
        return;
      }
      showBox(target);
      post({
        event: "select",
        id: target.getAttribute("id"),
        name: target.getAttribute("data-comot-name"),
      });
    },
    true,
  );

  window.addEventListener("resize", positionBox);
})();
