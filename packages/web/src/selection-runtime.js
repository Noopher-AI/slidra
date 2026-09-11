// Plain JavaScript, no imports, self-contained — inlined into the view
// `srcdoc`'s <script> by the parent (canvas.ts, via `?raw`). Runs inside a
// sandboxed iframe with `allow-scripts` and no `allow-same-origin`
// (ADR-0011), so it has no way to reach anything outside itself except
// `postMessage`.
//
// Its job (NOOP-91 extends #56's original click-only version): report which
// element was clicked (hit resolution), draw a selection box over it, and
// report raw pointer coordinates for direct-manipulation gestures (drag,
// marquee). Preview transforms and snapping stay entirely in the parent
// (canvas.ts) — this runtime paints whatever transform/guide string it is
// handed. Bounding-box geometry (F8, NOOP-289 決定 G1) is the one exception:
// since the browser has no bundled font-metrics engine any more, THIS
// runtime is the one place that can measure real rendered geometry
// (`getBBox()`/`getCTM()`) and reports it up rather than computing it in
// the parent.
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
    // 多選是單一虛線聯集框（05-INTERACTIONS.feature「多選」，取代舊版「每個
    // 元素各畫一個框」），與單選的實線框（`.sel`）區分開來。
    ".sel-multi{position:fixed;box-sizing:border-box;outline:2px dashed " +
    colors.accent +
    ";background:color-mix(in srgb, " +
    colors.accent +
    " 15%, transparent);pointer-events:none;}" +
    ".marquee{position:fixed;box-sizing:border-box;border:1px dashed " +
    colors.accent +
    ";background:color-mix(in srgb, " +
    colors.accent +
    " 12%, transparent);pointer-events:none;}" +
    ".group-frame{position:fixed;box-sizing:border-box;border:1px dashed " +
    colors.accent +
    ";pointer-events:none;display:none;}" +
    ".handle{position:fixed;box-sizing:border-box;width:9px;height:9px;margin:-4px 0 0 -4px;background:" +
    colors.handle +
    ";border:1px solid " +
    colors.accent +
    ";pointer-events:auto;display:none;}" +
    ".handle.corner{cursor:nwse-resize;}" +
    ".handle.corner[data-comot-handle=ne],.handle.corner[data-comot-handle=sw]{cursor:nesw-resize;}" +
    ".handle.rotate{border-radius:50%;cursor:grab;}" +
    ".handle.edge{cursor:ew-resize;}" +
    // In-place editing has no visible input of its own — the <textarea>
    // that actually holds the keystrokes is 1px and transparent — so
    // without these two the author cannot tell a double-click did
    // anything until they type. The frame says "this element is open for
    // editing"; the caret says where `textarea.selectionStart` currently
    // sits (ADR-0017 — this replaced the older "caret is always at the end
    // of the string" model, see updateEditDecoration()).
    ".edit-frame{position:fixed;box-sizing:border-box;border:1px dashed " +
    colors.accent +
    ";pointer-events:none;display:none;}" +
    ".edit-caret{position:fixed;width:2px;background:" +
    colors.accent +
    ";pointer-events:none;display:none;animation:comot-caret 1s step-end infinite;}" +
    ".edit-selection{position:fixed;box-sizing:border-box;background:color-mix(in srgb, " +
    colors.accent +
    " 30%, transparent);pointer-events:none;display:none;}" +
    "@keyframes comot-caret{50%{opacity:0;}}" +
    // [E2.T17] plan §4.4: the stage media layer. `.media-overlay-el` (the
    // actual <video>/<audio>) stays pointer-events:none so a click on the
    // media surface still hits the SVG placeholder underneath it and
    // selects the element like any other shape — only the control bar
    // itself is interactive.
    ".media-overlay-el{position:fixed;pointer-events:none;object-fit:contain;background:transparent;}" +
    ".media-control-bar{position:fixed;box-sizing:border-box;height:28px;display:flex;align-items:center;gap:4px;padding:0 6px;pointer-events:auto;background:color-mix(in srgb, " +
    colors.accent +
    " 70%, black 30%);}" +
    ".media-play{all:unset;cursor:pointer;color:" +
    colors.handle +
    ";font-size:12px;line-height:1;padding:2px 4px;}" +
    ".media-seek{flex:1;accent-color:" +
    colors.accent +
    ";cursor:pointer;}";
  shadow.appendChild(style);

  // One handle div per role, created once and repositioned/hidden on every
  // updateBoxes() call — same reuse pattern as the handle pool below.
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
    var rect = selectionClientRect(el);
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

  var editFrame = document.createElement("div");
  editFrame.className = "edit-frame";
  shadow.appendChild(editFrame);

  var editCaret = document.createElement("div");
  editCaret.className = "edit-caret";
  shadow.appendChild(editCaret);

  // Pool of selection-highlight divs, one per line touched by the current
  // text selection (ADR-0017's §4.3 "each line gets its own block" rule) —
  // same reuse pattern as multiBoxEls/groupFrameEls above.
  var selectionBlockEls = [];

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

  // Single dashed box for a multi-selection (>1 ids) — the union of every
  // selected element's own rect (05-INTERACTIONS.feature「多選」: one
  // dashed frame, not one box per element, replacing the old per-element
  // pool). No corner decorations, so acceptance criterion 9 ("多選看不到
  // 把手") holds simply because this element never carries any.
  var multiBoxEl = document.createElement("div");
  multiBoxEl.className = "sel-multi";
  multiBoxEl.style.display = "none";
  shadow.appendChild(multiBoxEl);

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

  // --- In-place text editing (NOOP-91/#70 US1, T5) ---
  //
  // The id of the text box currently being edited, or null between edits.
  // This is checked at the very top of every click/dblclick/pointerdown
  // handler below — editing suspends normal selection/gesture handling
  // entirely (§4.2's "編輯期間不觸發選取／拖曳邏輯" row) — rather than
  // layering an edit-mode branch into each one.
  var editingId = null;
  var textarea = null;
  var isComposing = false;

  // In-progress text-selection drag (ADR-0017 §4.5) — pointerdown landing
  // inside the box being edited starts this instead of an element gesture;
  // null between drags. `anchor` is the fixed end of the selection while
  // dragging; the moving end is whatever indexAtPoint() reports at the
  // current pointer position.
  var textSelectDrag = null;
  // Client point of the dblclick that requested the current begin-text-edit
  // round trip, so the caret lands where the author double-clicked once the
  // edit session actually opens; null for the Enter-key entry path (caret
  // stays at the end there).
  var pendingEditPoint = null;

  /** Any ancestor (including `el` itself) carrying `data-comot-lock="true"` — the same walk `findSelectable` does, exposed standalone because the host-initiated `beginTextEdit` path never goes through a click at all and so never runs `findSelectable`. */
  function isLockedOrInsideLocked(el) {
    var current = el;
    while (current && current !== document.body) {
      if (current.getAttribute && current.getAttribute("data-comot-lock") === "true") return true;
      current = current.parentElement;
    }
    return false;
  }

  /**
   * Lazily creates the hidden `<textarea>` that captures keyboard input
   * while editing (§4.2's IME row: `input`, not `keydown`, is what is
   * trusted for the string itself — `keydown` only ever intercepts Enter).
   * `opacity:0` rather than `display:none` — a display:none element cannot
   * hold focus or receive IME composition events.
   */
  function ensureTextarea() {
    if (textarea) return textarea;
    var el = document.createElement("textarea");
    el.setAttribute("aria-hidden", "true");
    el.style.position = "fixed";
    el.style.top = "0";
    el.style.left = "0";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.padding = "0";
    el.style.border = "none";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    // The slide document sets user-select:none (wrapSelectionDocument) so a
    // marquee drag cannot start a native text selection. This element is the
    // one place that still needs the default: it is the keyboard/IME sink for
    // text editing, and setSelectionRange()/composition work on a control
    // whose text is selectable.
    el.style.userSelect = "text";
    el.style.webkitUserSelect = "text";
    shadow.appendChild(el);
    el.addEventListener("compositionstart", function () {
      isComposing = true;
    });
    el.addEventListener("compositionend", function () {
      isComposing = false;
      applyTextEditContent(editingId, textarea.value);
      reportTextEditInput();
      scheduleDecorationSync();
    });
    el.addEventListener("keydown", function (event) {
      // NOOP-65 決定 A / §4.4: Enter now inserts a hard break (core's
      // wrapText has newline semantics as of this ticket) — the browser's
      // own default textarea action does that for free, so a plain Enter
      // is NOT prevented here any more. ⌘Enter/Ctrl+Enter is the one
      // exception: no insert, no commit, no leaving edit mode, and it must
      // never reach anything above this element (there is nothing there
      // today, but the contract is explicit either way). Esc is handled by
      // the window-level keydown listener below regardless of where focus
      // sits, and is unaffected by this branch.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // `selectionStart`/`selectionEnd` have not been updated by the
      // browser yet at this point in the event (arrow keys, Home/End,
      // Ctrl/Cmd+A move them as part of the DEFAULT action) — deferred one
      // tick by scheduleDecorationSync() itself (ADR-0017 §4.1).
      scheduleDecorationSync();
    });
    el.addEventListener("keyup", scheduleDecorationSync);
    el.addEventListener("select", scheduleDecorationSync);
    el.addEventListener("focus", scheduleDecorationSync);
    el.addEventListener("input", function () {
      if (!isComposing) sanitizeTextareaValue();
      // F8 (NOOP-289 決定 T1): repainted entirely locally, on every
      // keystroke (including mid-IME-composition — this only ever reads
      // `textarea.value` and writes the SEPARATE `<text>` element, so
      // unlike `sanitizeTextareaValue()` it cannot disturb an in-progress
      // composition) — no round trip to the host, no layout/measurement of
      // any kind. `reportTextEditInput()` still mirrors the string up so
      // the host's `editingState.currentText` has something to diff and
      // send on commit.
      applyTextEditContent(editingId, textarea.value);
      reportTextEditInput();
      scheduleDecorationSync();
    });
    textarea = el;
    return el;
  }

  /**
   * Batches redraws of the caret/selection decoration to at most once per
   * tick (ADR-0017 §4.1) — several of the events that can move
   * `selectionStart`/`selectionEnd` (keydown then keyup, or keydown then
   * input) fire back-to-back for the same user action, and `keydown`
   * itself fires BEFORE the browser applies the default action that moves
   * the selection, so this always defers via a macrotask rather than
   * reading `selectionStart` synchronously.
   */
  var decorationSyncScheduled = false;
  function scheduleDecorationSync() {
    if (decorationSyncScheduled) return;
    decorationSyncScheduled = true;
    setTimeout(function () {
      decorationSyncScheduled = false;
      updateEditDecoration();
    }, 0);
  }

  /**
   * Normalizes `\r\n`/`\r` to `\n` (NOOP-65 §4.4: pasted multi-line text is
   * user input, normalized here at the input-component layer — core's own
   * `\r` rejection, §4.1, is for API callers, not pasted keyboard text) —
   * never while an IME composition is in progress, which this same
   * replacement would corrupt.
   */
  function sanitizeTextareaValue() {
    var value = textarea.value;
    var sanitized = value.replace(/\r\n|\r/g, "\n");
    if (sanitized !== value) textarea.value = sanitized;
  }

  function reportTextEditInput() {
    if (editingId === null || !textarea) return;
    post({ event: "text-edit-input", id: editingId, text: textarea.value });
  }

  /** Starts editing `id` with `initialText` already loaded into the textarea — false (and no-op) when `id` is missing or locked. */
  function enterRuntimeTextEdit(id, initialText) {
    var el = document.getElementById(id);
    if (!el || isLockedOrInsideLocked(el)) return false;
    editingId = id;
    var ta = ensureTextarea();
    ta.value = typeof initialText === "string" ? initialText : "";
    // Caret starts at the end of the existing string — the same place a
    // freshly-focused, freshly-valued textarea would put it, made explicit
    // rather than relied upon (ADR-0017: entering edit no longer has an
    // implicit "always at the end" model, but a fresh edit session
    // starting the caret at the end, before any click repositions it, is
    // still the sensible default).
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.focus();
    // The frame and caret are the only thing that tells the author the
    // double-click landed — the textarea holding the keystrokes is 1px
    // and transparent.
    updateEditDecoration();
    return true;
  }

  function exitRuntimeTextEdit() {
    editingId = null;
    isComposing = false;
    textSelectDrag = null;
    if (textarea) textarea.blur();
    updateEditDecoration();
  }

  function positionBox() {
    if (selectedIds.length !== 1) return;
    var el = document.getElementById(selectedIds[0]);
    if (!el) return;
    var rect = selectionClientRect(el);
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
    multiBoxEl.style.display = "none";
  }

  // ── Stage media layer ([E2.T17] plan §4.4) ───────────────────────────
  // Kind derivation stays entirely in the parent (`player-plan.ts`'s
  // `stageMediaFor`, D3) — this runtime only ever builds what it is told
  // to, injected the same way `colors` is (canvas.ts's
  // wrapSelectionDocument sets `window.__COMOT_SELECTION_MEDIA__` before
  // this script runs). Keyed by untrusted SVG element ids (ADR-0010, a
  // legal id can be "__proto__") — read with `for...in` +
  // hasOwnProperty, never assumed to be a plain enumerable object.
  var mediaTable = window.__COMOT_SELECTION_MEDIA__ || {};
  // [E2.T17]: ids of the slide's third-party embeds. The <iframe> lives in
  // the PARENT document (ADR-0011 — this document may never be granted
  // allow-same-origin, and a nested iframe's sandbox flags are the
  // intersection with this one's, so the YouTube player cannot work from
  // in here); this runtime only measures where each placeholder sits and
  // posts it out, so the parent can keep its overlay aligned.
  var embedIds = window.__COMOT_SELECTION_EMBEDS__ || [];

  function reportEmbedBoxes() {
    if (embedIds.length === 0) return;
    var items = [];
    for (var i = 0; i < embedIds.length; i++) {
      var embedEl = document.getElementById(embedIds[i]);
      if (!embedEl) continue;
      var embedRect = embedEl.getBoundingClientRect();
      items.push({
        id: embedIds[i],
        rect: { x: embedRect.left, y: embedRect.top, width: embedRect.width, height: embedRect.height },
      });
    }
    post({ event: "embed-boxes", items: items });
  }
  // id -> { placeholder, media, bar, playButton, seek }
  var mediaOverlays = {};

  /** `data-comot-media-control`'s value ("play"/"seek") at or inside `event`'s real (composed) target, or null — same `composedPath()` technique as `findHandleTarget` below, needed for the identical reason: a click/pointerdown on an element inside this open shadow root is retargeted to `host` for a window-level listener's own `event.target`. */
  function findMediaControlTarget(event) {
    var path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node && node.getAttribute && node.hasAttribute && node.hasAttribute("data-comot-media-control")) {
        return node.getAttribute("data-comot-media-control");
      }
    }
    return null;
  }

  /**
   * Builds one placeholder's `<video>`/`<audio>` + self-drawn control bar
   * (D2: native `controls` is not used — a spike proved
   * `requestFullscreen()` is refused from inside this sandboxed iframe, so
   * the native control bar's own fullscreen button would be a dead one).
   * The media element itself is `pointer-events:none` so a click on the
   * video surface still hits the SVG placeholder underneath it and
   * selects the element, exactly like clicking any other shape.
   */
  function createMediaOverlay(id, cue, placeholder) {
    var el = document.createElement(cue.kind === "video" ? "video" : "audio");
    // The raw data-comot-media value, unmodified — same contract as
    // player-runtime.js's playMedia(): the view srcdoc already carries a
    // <base href="/api/raw/<slide dir>"> (wrapSelectionDocument, canvas.ts),
    // so the browser's own relative-URL resolution does the rest.
    el.src = cue.src;
    el.preload = "metadata";
    el.className = "media-overlay-el";
    // Inline + !important (same convention as `host` above), not left to
    // the injected stylesheet alone: pointer-events here is a correctness
    // property (a hostile slide's own CSS must not be able to make the
    // video capture clicks meant for the SVG placeholder underneath it),
    // not decoration.
    el.style.setProperty("pointer-events", "none", important);
    shadow.appendChild(el);

    var bar = document.createElement("div");
    bar.className = "media-control-bar";
    bar.style.setProperty("pointer-events", "auto", important);

    var playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "media-play";
    playButton.setAttribute("data-comot-media-control", "play");
    playButton.textContent = "▶";
    bar.appendChild(playButton);

    var seek = document.createElement("input");
    seek.type = "range";
    seek.min = "0";
    seek.max = "0";
    seek.step = "0.01";
    seek.value = "0";
    seek.className = "media-seek";
    seek.setAttribute("data-comot-media-control", "seek");
    bar.appendChild(seek);

    shadow.appendChild(bar);

    function reportError(err) {
      post({
        event: "error",
        message: "媒體播放失敗（" + id + "）：" + (err && err.message ? err.message : String(err)),
      });
    }

    playButton.addEventListener("click", function () {
      if (el.paused) {
        // Synchronous, no await before it — this runs inside the SAME
        // click dispatch that carries transient activation (same rule as
        // player-runtime.js's playMedia()).
        var playResult = el.play();
        if (playResult && typeof playResult.catch === "function") playResult.catch(reportError);
      } else {
        el.pause();
      }
    });
    el.addEventListener("play", function () {
      playButton.textContent = "⏸";
    });
    el.addEventListener("pause", function () {
      playButton.textContent = "▶";
    });
    el.addEventListener("loadedmetadata", function () {
      seek.max = String(el.duration || 0);
    });
    el.addEventListener("timeupdate", function () {
      seek.value = String(el.currentTime);
    });
    seek.addEventListener("input", function () {
      el.currentTime = Number(seek.value);
    });
    // A 404/decode failure must surface (D7's error posture extends here)
    // without taking down the rest of the slide's overlays — each
    // placeholder's overlay is independent.
    el.addEventListener("error", function () {
      post({ event: "error", message: "媒體載入失敗（" + id + "）：" + cue.src });
    });

    return { placeholder: placeholder, media: el, bar: bar, playButton: playButton, seek: seek };
  }

  /** Positions every overlay over its placeholder's current on-screen box (same `getBoundingClientRect()`-driven approach as `positionBox()` above) — called on init and again on resize/zoom, never assuming geometry stays put across either. */
  function positionMediaOverlays() {
    for (var id in mediaOverlays) {
      if (!Object.prototype.hasOwnProperty.call(mediaOverlays, id)) continue;
      var overlay = mediaOverlays[id];
      var rect = overlay.placeholder.getBoundingClientRect();
      overlay.media.style.left = rect.left + "px";
      overlay.media.style.top = rect.top + "px";
      overlay.media.style.width = rect.width + "px";
      overlay.media.style.height = rect.height + "px";
      var barHeight = 28;
      overlay.bar.style.left = rect.left + "px";
      overlay.bar.style.top = rect.top + Math.max(0, rect.height - barHeight) + "px";
      overlay.bar.style.width = rect.width + "px";
    }
  }

  /**
   * Only reachable once `bodyMarkup`'s SVG has actually been parsed
   * (`window`'s `load` event, same timing `reportViewport()` already
   * relies on) — `document.getElementById` for a placeholder resolves to
   * nothing before that. A `data-comot-media` id this table names but the
   * page turns out not to contain (should not happen — the table is
   * derived from this exact markup) is skipped, never thrown on.
   */
  function buildMediaOverlays() {
    for (var id in mediaTable) {
      if (!Object.prototype.hasOwnProperty.call(mediaTable, id)) continue;
      var placeholder = document.getElementById(id);
      if (!placeholder) continue;
      mediaOverlays[id] = createMediaOverlay(id, mediaTable[id], placeholder);
    }
    positionMediaOverlays();
  }

  /** Draws one dashed box around the union of every id in `ids` that still resolves to a live element — missing ids are simply skipped, never thrown on (the same "reload made a selected element vanish" tolerance `updateBoxes()`'s single-selection path already has). */
  function showMultiBoxes(ids) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var found = false;
    for (var i = 0; i < ids.length; i++) {
      var target = document.getElementById(ids[i]);
      if (!target) continue;
      var rect = target.getBoundingClientRect();
      found = true;
      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.left + rect.width);
      maxY = Math.max(maxY, rect.top + rect.height);
    }
    if (!found) {
      multiBoxEl.style.display = "none";
      return;
    }
    multiBoxEl.style.display = "block";
    multiBoxEl.style.left = minX + "px";
    multiBoxEl.style.top = minY + "px";
    multiBoxEl.style.width = maxX - minX + "px";
    multiBoxEl.style.height = maxY - minY + "px";
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

  /**
   * Converts an SVG user-space point (as returned by
   * `getStartPositionOfChar`/`getEndPositionOfChar`) to viewport (client
   * px) coordinates via `textEl`'s own screen CTM — the transform used
   * throughout ADR-0017 to place the fixed-position overlay divs.
   */
  function toClientPoint(ctm, point) {
    return new DOMPoint(point.x, point.y).matrixTransform(ctm);
  }

  /**
   * `el`'s on-screen rect for the selection box/handles: the actual
   * rendered `getBoundingClientRect()`, UNLESS a textbox-width drag is
   * live-previewing a different width for this EXACT element
   * (`previewTextWidth`, F8/NOOP-289 決定 (b)) — then the width component
   * is recomputed from the element's own (unchanged) local bbox plus the
   * previewed width, transformed through its own `getScreenCTM()`, so the
   * box/handles track the drag even though the `<text>` itself was never
   * touched. Falls back to `getBoundingClientRect()` when `getBBox`/
   * `getScreenCTM` are unavailable (jsdom).
   */
  function selectionClientRect(el) {
    if (
      previewTextWidth &&
      el.getAttribute("id") === previewTextWidth.id &&
      typeof el.getBBox === "function" &&
      typeof el.getScreenCTM === "function"
    ) {
      var bbox = el.getBBox();
      var ctm = el.getScreenCTM();
      if (bbox && ctm) {
        var corners = [
          toClientPoint(ctm, { x: bbox.x, y: bbox.y }),
          toClientPoint(ctm, { x: bbox.x + previewTextWidth.width, y: bbox.y }),
          toClientPoint(ctm, { x: bbox.x, y: bbox.y + bbox.height }),
          toClientPoint(ctm, { x: bbox.x + previewTextWidth.width, y: bbox.y + bbox.height }),
        ];
        var xs = corners.map(function (p) {
          return p.x;
        });
        var ys = corners.map(function (p) {
          return p.y;
        });
        var left = Math.min.apply(null, xs);
        var top = Math.min.apply(null, ys);
        return { left: left, top: top, width: Math.max.apply(null, xs) - left, height: Math.max.apply(null, ys) - top };
      }
    }
    var rect = el.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  /**
   * `textEl.getScreenCTM()`, or `null` when it is missing (jsdom, used by
   * this repo's own non-geometry unit tests, implements neither this nor
   * `getNumberOfChars`) or returns nothing usable — the single guard point
   * that keeps every geometry helper below from ever throwing, per
   * ADR-0017 §4.2's "格式錯誤／型別錯誤" row.
   */
  function getTextCTM(textEl) {
    return typeof textEl.getScreenCTM === "function" ? textEl.getScreenCTM() : null;
  }

  /**
   * `el`'s content `<text>` — excludes a list-marker `<text>` sibling
   * (NOOP-65 決定 E: the bullet/number glyphs are a second `<text>` in the
   * same `<g>`, never part of the edited content). Every place in this file
   * that used to do `el.querySelector("text")` now goes through this.
   */
  function contentTextElement(el) {
    return el.querySelector('text:not([data-comot-list-marker])');
  }

  /**
   * The character-index ranges covered by each visual line of `textEl`,
   * outermost/topmost first, each with the direct-child `<tspan>` (or, for
   * a single-line plain `<text>`, the `<text>` itself) client rect that
   * line occupies.
   *
   * Two index spaces, not one (NOOP-65 決定 A/F): `domStart/domEnd` is what
   * `getStartPositionOfChar`/`getEndPositionOfChar`/`getNumberOfChars`
   * address (every real character, INCLUDING nested run tspans' text via
   * `tspan.textContent`, since bold/italic runs never add or remove a
   * character — 決定 B); `valueStart/valueEnd` is `textarea.value`'s own
   * space, which additionally counts one virtual character per hard break
   * (`data-comot-break="1"`, 決定 A) that has no DOM position at all. Only
   * DIRECT child `<tspan>`s are lines — `getElementsByTagName` (this
   * function's pre-NOOP-65 shape) would also pick up nested run tspans and
   * double-count every bold/italic span as its own extra "line".
   */
  function textLineRanges(textEl) {
    var directTspans = [];
    for (var c = 0; c < textEl.children.length; c++) {
      if (textEl.children[c].tagName === "tspan") directTspans.push(textEl.children[c]);
    }
    var lines = [];
    if (directTspans.length > 0) {
      var valueIdx = 0;
      var domIdx = 0;
      for (var i = 0; i < directTspans.length; i++) {
        var tspan = directTspans[i];
        var domLen = tspan.textContent.length;
        var hasBreak = tspan.getAttribute("data-comot-break") === "1";
        lines.push({
          valueStart: valueIdx,
          valueEnd: valueIdx + domLen + (hasBreak ? 1 : 0),
          domStart: domIdx,
          domEnd: domIdx + domLen,
          hardBreak: hasBreak,
          rect: tspan.getBoundingClientRect(),
        });
        valueIdx += domLen + (hasBreak ? 1 : 0);
        domIdx += domLen;
      }
    } else {
      var n = textEl.getNumberOfChars();
      lines.push({ valueStart: 0, valueEnd: n, domStart: 0, domEnd: n, hardBreak: false, rect: textEl.getBoundingClientRect() });
    }
    return lines;
  }

  /**
   * The line (from `textLineRanges`) whose vertical band contains
   * `clientY`, clamped to the first/last line when `clientY` falls above
   * or below all of them (ADR-0017 §4.2's "點在整段文字上方／下方" row).
   */
  function lineAtClientY(lines, clientY) {
    var line = lines[0];
    for (var li = 0; li < lines.length; li++) {
      line = lines[li];
      if (clientY < line.rect.bottom || li === lines.length - 1) break;
    }
    return line;
  }

  /**
   * Hit-tests a viewport point against the `<text>` currently being edited
   * and returns a `textarea.value` character index (NOOP-65 決定 F — never
   * a DOM index), or `null` when there is nothing to test against
   * (ADR-0017 §4.2's contract table: no editing session, missing
   * element/`<text>`, or an unusable CTM all return `null` rather than a
   * guessed index). Horizontal placement uses the midpoint of each
   * character's box — `clientX` past the midpoint lands the index after
   * that character — and a point past a line's last character resolves to
   * that line's end: the slot BEFORE the line's virtual hard-break
   * character, never after it (that slot is the next line's start).
   */
  function indexAtPoint(clientX, clientY) {
    if (editingId === null) return null;
    var el = document.getElementById(editingId);
    if (!el) return null;
    var textEl = contentTextElement(el);
    if (!textEl) return null;
    var ctm = getTextCTM(textEl);
    if (!ctm) return null;
    var lines = textLineRanges(textEl);
    if (lines.length === 0 || lines[lines.length - 1].valueEnd === 0) return 0;
    var line = lineAtClientY(lines, clientY);
    for (var domI = line.domStart; domI < line.domEnd; domI++) {
      var start = toClientPoint(ctm, textEl.getStartPositionOfChar(domI));
      var end = toClientPoint(ctm, textEl.getEndPositionOfChar(domI));
      if (clientX < (start.x + end.x) / 2) return line.valueStart + (domI - line.domStart);
    }
    return line.valueEnd - (line.hardBreak ? 1 : 0);
  }

  /**
   * The screen rect the caret should be drawn at for `textarea.value`
   * character index `i` (`textarea.selectionStart === selectionEnd`), or
   * `null` when there is no text geometry to measure at all (every line
   * has zero real DOM characters — an empty box, or one made only of hard
   * breaks — handled by the caller's container-box fallback, same as the
   * pre-ADR-0017 0×0 case).
   */
  function caretRectForIndex(textEl, ctm, lines, i) {
    var lastLine = lines[lines.length - 1];
    if (lastLine.domEnd === 0) return null;
    if (i >= lastLine.valueEnd) {
      var end = toClientPoint(ctm, textEl.getEndPositionOfChar(lastLine.domEnd - 1));
      return { x: end.x, top: lastLine.rect.top, height: lastLine.rect.height };
    }
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (i >= line.valueStart && i < line.valueEnd) {
        var domI = line.domStart + (i - line.valueStart);
        if (domI >= line.domEnd) {
          // `i` is the line's virtual hard-break slot (no DOM char of its
          // own): the caret sits after the line's last real character.
          if (line.domEnd === line.domStart) return { x: line.rect.left, top: line.rect.top, height: line.rect.height };
          var lineEnd = toClientPoint(ctm, textEl.getEndPositionOfChar(line.domEnd - 1));
          return { x: lineEnd.x, top: line.rect.top, height: line.rect.height };
        }
        var start = toClientPoint(ctm, textEl.getStartPositionOfChar(domI));
        return { x: start.x, top: line.rect.top, height: line.rect.height };
      }
    }
    return null;
  }

  /**
   * One rect per line touched by `[start, end)` (both `textarea.value`
   * indices — ADR-0017 §4.3) — a mid-line selection uses the selected
   * characters' own start/end x, not the tspan's full rect, so a partial
   * selection never paints a block over the unselected trailing wrap
   * space; a fully-selected line's block still stops at its last real
   * character for the same reason. A selection that covers only a line's
   * trailing virtual hard-break character (no real DOM character on that
   * line at all) draws a zero-width marker at the line's own end instead
   * of silently vanishing.
   */
  function selectionRectsForRange(textEl, ctm, lines, start, end) {
    var rects = [];
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var s = Math.max(start, line.valueStart);
      var e = Math.min(end, line.valueEnd);
      if (s >= e) continue;
      var domS = Math.min(line.domStart + (s - line.valueStart), line.domEnd);
      // Clamp: `e` may include the line's virtual hard-break char, which has
      // no DOM index — reading `domEnd` would measure the NEXT line's first char.
      var domELast = Math.min(line.domStart + (e - line.valueStart) - 1, line.domEnd - 1);
      if (domELast < domS || line.domEnd === 0) {
        var edgePoint = domS < line.domEnd
          ? toClientPoint(ctm, textEl.getStartPositionOfChar(domS))
          : line.domEnd > 0
            ? toClientPoint(ctm, textEl.getEndPositionOfChar(line.domEnd - 1))
            : null;
        if (!edgePoint) continue;
        rects.push({ left: edgePoint.x, right: edgePoint.x, top: line.rect.top, height: line.rect.height });
        continue;
      }
      var startPoint = toClientPoint(ctm, textEl.getStartPositionOfChar(domS));
      var endPoint = toClientPoint(ctm, textEl.getEndPositionOfChar(domELast));
      rects.push({
        left: Math.min(startPoint.x, endPoint.x),
        right: Math.max(startPoint.x, endPoint.x),
        top: line.rect.top,
        height: line.rect.height,
      });
    }
    return rects;
  }

  function hideSelectionBlocks() {
    for (var i = 0; i < selectionBlockEls.length; i++) selectionBlockEls[i].style.display = "none";
  }

  function showSelectionBlocks(rects) {
    while (selectionBlockEls.length < rects.length) {
      var el = document.createElement("div");
      el.className = "edit-selection";
      shadow.appendChild(el);
      selectionBlockEls.push(el);
    }
    for (var i = 0; i < selectionBlockEls.length; i++) {
      if (i >= rects.length) {
        selectionBlockEls[i].style.display = "none";
        continue;
      }
      var r = rects[i];
      var el2 = selectionBlockEls[i];
      el2.style.display = "block";
      el2.style.left = r.left + "px";
      el2.style.top = r.top + "px";
      el2.style.width = r.right - r.left + "px";
      el2.style.height = r.height + "px";
    }
  }

  // Redraws whatever `selectedIds` currently holds. Called after every
  // selection change (click, marquee) and on resize/preview so the box(es)
  // track the element(s) as they move.
  /**
   * Paints the editing frame plus either the caret or the selection
   * blocks (never both — ADR-0017 §4.3) for whatever `editingId`/
   * `textarea.selectionStart/End` currently are, or hides everything when
   * nothing is being edited. `textarea.selectionStart/End` is the single
   * source of truth for where the caret/selection are (ADR-0017 §4.1);
   * this function only ever reads them, never writes them.
   */
  function updateEditDecoration() {
    var el = editingId === null ? null : document.getElementById(editingId);
    if (!el || !textarea) {
      editFrame.style.display = "none";
      editCaret.style.display = "none";
      hideSelectionBlocks();
      return;
    }
    var rect = el.getBoundingClientRect();
    editFrame.style.display = "block";
    editFrame.style.left = rect.left - 3 + "px";
    editFrame.style.top = rect.top - 3 + "px";
    editFrame.style.width = rect.width + 6 + "px";
    editFrame.style.height = rect.height + 6 + "px";

    var textEl = contentTextElement(el);
    var ctm = textEl ? getTextCTM(textEl) : null;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;

    if (start !== end && textEl && ctm) {
      editCaret.style.display = "none";
      var lines = textLineRanges(textEl);
      showSelectionBlocks(selectionRectsForRange(textEl, ctm, lines, Math.min(start, end), Math.max(start, end)));
      return;
    }

    hideSelectionBlocks();
    var caretRect = textEl && ctm ? caretRectForIndex(textEl, ctm, textLineRanges(textEl), start) : null;
    // An empty string (or an unmeasurable <text>) has no character
    // geometry to place the caret against — fall back to the container's
    // own box, same as the pre-ADR-0017 code's 0×0 fallback.
    editCaret.style.display = "block";
    editCaret.style.left = (caretRect ? caretRect.x : rect.left) + "px";
    editCaret.style.top = (caretRect ? caretRect.top : rect.top) + "px";
    editCaret.style.height = (caretRect ? caretRect.height : rect.height) + "px";
  }

  /**
   * The chain of id-carrying ancestor containers from (but not including)
   * `el` up to (but not including) the `<svg>` root, outermost first —
   * NOOP-90/T2 §4.6's `bounds` event payload, and the source F9 (群組) will
   * read for its "Group 2 › Group 1" drill-in label. Every container in the
   * normal form carries an `id` (ADR-0012), so this never needs to guess at
   * a missing one the way `findSelectable`'s upward walk defensively does.
   */
  function ancestorChain(el) {
    var chain = [];
    var current = el.parentElement;
    while (current && current.tagName && current.tagName.toLowerCase() !== "svg") {
      if (current.hasAttribute && current.hasAttribute("id")) {
        chain.unshift({ id: current.getAttribute("id"), name: current.getAttribute("data-comot-name") || null });
      }
      current = current.parentElement;
    }
    return chain;
  }

  /**
   * Reports each selected element's own precise `getBoundingClientRect()`
   * (client px, no conversion done here — `canvas.ts`'s `toParentClientPoint`
   * owns that) plus its ancestor chain, and the union of every box — ADR-0011
   * amend: this is what lets the parent draw name/group labels and snap
   * guides without re-deriving geometry itself. A selected id no longer
   * present in the DOM (a reload raced the selection) is simply skipped, not
   * reported as an error — the same tolerance `updateBoxes()`'s single-
   * selection path already has for a vanished element.
   */
  function reportBounds() {
    var items = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < selectedIds.length; i++) {
      var el = document.getElementById(selectedIds[i]);
      if (!el) continue;
      var rect = el.getBoundingClientRect();
      items.push({
        id: selectedIds[i],
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        ancestors: ancestorChain(el),
      });
      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.left + rect.width);
      maxY = Math.max(maxY, rect.top + rect.height);
    }
    var union = items.length === 0 ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    post({ event: "bounds", items: items, union: union });
  }

  /**
   * [E2.T7]/D9: reports `getBoundingClientRect()` for an ARBITRARY id list
   * — not `selectedIds` — so the parent can position the stage's animation
   * number badges over every element that has an effect, regardless of
   * what is currently selected. Deliberately a separate on-demand command
   * rather than folding into `reportBounds()`/the `bounds` event: that path
   * runs on every selection change and drag frame, and widening it to cover
   * every animated element (not just the selection) would turn a
   * drag-time hot path into one that scales with the slide's total effect
   * count instead of the (usually tiny) current selection (D9's own
   * rationale — do not "fix" this into one shared function). An id not
   * currently in the DOM is simply omitted, the same tolerance
   * `reportBounds()` already gives a vanished selected id.
   */
  function reportMeasured(ids) {
    var items = [];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el) continue;
      var rect = el.getBoundingClientRect();
      items.push({ id: ids[i], rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } });
    }
    post({ event: "measured", items: items });
  }

  /** `table-cells` host->runtime command (E2.T14, plan §4.5): every cell's client rect, plus the table's own box, for `id`'s table container. Silently reports nothing for an id that no longer resolves or is not a table — same "no fallback, just skip" posture `reportMeasured` above has for a stale id. */
  function reportTableCells(id) {
    var tableEl = document.getElementById(id);
    if (!tableEl || tableEl.getAttribute("data-comot-type") !== "table") return;
    var cellEls = tableEl.querySelectorAll("[data-comot-cell]");
    var cells = [];
    for (var i = 0; i < cellEls.length; i++) {
      var address = tableCellAddress(cellEls[i]);
      if (!address) continue;
      var cellRect = cellEls[i].getBoundingClientRect();
      cells.push({
        row: address.row,
        col: address.col,
        rect: { x: cellRect.left, y: cellRect.top, width: cellRect.width, height: cellRect.height },
      });
    }
    var boxRect = tableEl.getBoundingClientRect();
    post({
      event: "table-cells",
      id: id,
      cells: cells,
      box: { x: boxRect.left, y: boxRect.top, width: boxRect.width, height: boxRect.height },
    });
  }

  /**
   * `preview-table-cols` host->runtime command (E2.T14, plan §4.5): a
   * column-width drag's live preview. Moves only each cell `<g>`'s own
   * `translate` x and its `<rect>`'s `width` — never re-wraps text (決定
   * 13: "拖曳期間不重新換行"). `cols` not being an array of the SAME
   * length as the table's current column count leaves the DOM completely
   * untouched (same "bad input is a no-op, never a partial mutation"
   * posture `applyPreviewTextboxWidth` already has for its own malformed
   * input).
   */
  function applyPreviewTableCols(id, cols) {
    var tableEl = document.getElementById(id);
    if (!tableEl || tableEl.getAttribute("data-comot-type") !== "table" || !Array.isArray(cols)) return;
    if (!cols.every(function (value) { return typeof value === "number" && isFinite(value) && value > 0; })) return;

    var cellEls = tableEl.querySelectorAll("[data-comot-cell]");
    var colCount = cols.length;
    // Column left-edge x offsets, from the previewed widths.
    var offsets = [];
    var x = 0;
    for (var c = 0; c < colCount; c++) {
      offsets.push(x);
      x += cols[c];
    }

    for (var i = 0; i < cellEls.length; i++) {
      var cellEl = cellEls[i];
      var address = tableCellAddress(cellEl);
      if (!address || address.col >= colCount) continue;
      var rectEl = cellEl.querySelector("rect");
      if (!rectEl) continue;
      var currentTransform = cellEl.getAttribute("transform") || "";
      var yMatch = /translate\([^,\s]+[,\s]+([^)]+)\)/.exec(currentTransform);
      var y = yMatch ? yMatch[1].trim() : "0";
      cellEl.setAttribute("transform", "translate(" + offsets[address.col] + " " + y + ")");
      rectEl.setAttribute("width", String(cols[address.col]));
    }
  }

  function updateBoxes() {
    updateEditDecoration();
    positionGroupFrames();
    if (selectedIds.length === 0) {
      hideBox();
      hideMultiBoxes();
      hideAllHandles();
      reportBounds();
      return;
    }
    if (selectedIds.length === 1) {
      hideMultiBoxes();
      showBox();
      positionHandles();
      reportBounds();
      return;
    }
    hideBox();
    hideAllHandles();
    showMultiBoxes(selectedIds);
    reportBounds();
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
      // The outermost slide <svg> (no `ownerSVGElement` of its own) stops
      // the walk — nothing above it is selectable. E2.T12 introduced this
      // codebase's first NESTED <svg> (a chart's embedded rendering,
      // ADR-0012 amend): `ownerSVGElement` is non-null for it (it points
      // at the enclosing root svg), so it is walked straight through like
      // any other container instead of wrongly stopping the search one
      // level short of the chart's own id-carrying `<g>`.
      if (tag === "svg" && !current.ownerSVGElement) break;
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

  /**
   * True when `el` wraps at least one further id-carrying descendant — the
   * normal form's own rule that only containers, never primitives, carry
   * `id` (ADR-0012) makes this exactly "is `el` a group". A table's cells
   * (E2.T14) never carry `id` either, so this already returns `false` for
   * a table container with no further checks needed — the dblclick
   * handler below still special-cases `data-comot-type="table"` FIRST so
   * it opens cell editing instead of merely falling through to "not a
   * group, do nothing".
   */
  function isGroupContainer(el) {
    return !!(el && el.querySelector("[id]"));
  }

  /** Walks up from `rawTarget` to the nearest `data-comot-cell` ancestor, or null (E2.T14, plan §4.5). */
  function findTableCellElement(rawTarget) {
    var current = rawTarget;
    while (current && current !== document.body) {
      if (current.getAttribute && current.hasAttribute("data-comot-cell")) return current;
      current = current.parentElement;
    }
    return null;
  }

  /** Parses a cell `<g>`'s own `data-comot-cell="r,c"` into `{row, col}`, or null if malformed. */
  function tableCellAddress(cellEl) {
    var raw = cellEl.getAttribute("data-comot-cell");
    var match = raw ? /^(\d+),(\d+)$/.exec(raw) : null;
    return match ? { row: Number(match[1]), col: Number(match[2]) } : null;
  }

  /** The template-row cell sharing `generatedCell`'s column, within the same table container — architecture: "雙擊編輯的是模板列" (plan §4.5). */
  function findTemplateCellForColumn(tableEl, col) {
    var candidates = tableEl.querySelectorAll('[data-comot-repeat="row"]');
    for (var i = 0; i < candidates.length; i++) {
      var addr = tableCellAddress(candidates[i]);
      if (addr && addr.col === col) return candidates[i];
    }
    return null;
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

  /**
   * Radius, in CSS pixels, of the forgiveness ring below. Large enough that
   * a default-width line (`stroke-width: 2`) becomes comfortably clickable,
   * small enough that it never reaches past a neighbouring element a user
   * could have aimed at instead.
   */
  var HIT_TOLERANCE_PX = 6;

  /**
   * `resolveClickTarget`, plus a forgiveness ring for thin geometry.
   *
   * SVG hit testing is exact: a `<line stroke-width="2">` is only clickable
   * within those 2 pixels, which in practice means it cannot be clicked at
   * all. On a miss this re-runs the SAME resolution at eight points on a
   * ring around the pointer, so the browser's own hit testing (and with it
   * z-order, `pointer-events`, and the lock/group-scope rules inside
   * `findSelectable`) still decides what was hit — this only widens where
   * we ask, never how the answer is computed.
   *
   * Only reached when the exact hit already missed, so it can never take a
   * click away from an element the pointer was genuinely over.
   */
  function resolveClickTargetAtEvent(event) {
    var exact = resolveClickTarget(event.target);
    if (exact) return exact;
    // A miss on blank canvas is the overwhelmingly common case and must
    // stay a miss when there is genuinely nothing near the pointer.
    for (var i = 0; i < 8; i++) {
      var angle = (i * Math.PI) / 4;
      var el = document.elementFromPoint(
        event.clientX + Math.cos(angle) * HIT_TOLERANCE_PX,
        event.clientY + Math.sin(angle) * HIT_TOLERANCE_PX,
      );
      if (!el || el === host || el === document.body || el === document.documentElement) continue;
      var near = resolveClickTarget(el);
      if (near) return near;
    }
    return null;
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
      // [E2.T17] plan §4.4: clicking the stage media layer's own play/seek
      // controls must never change selection — checked first, before any
      // other short-circuit below, the same `composedPath()` technique
      // `findHandleTarget` uses (this listener is on `window`, outside the
      // open shadow root the controls live in).
      if (findMediaControlTarget(event)) return;
      // A commit-triggering outside pointerdown already cleared editingId
      // and set suppressNextClick before this click fires (§4.2's
      // "pointerdown 落在被編輯元素之外" row) — this guard only matters for
      // a click with no preceding pointerdown at all (e.g. synthetic).
      if (editingId !== null) return;
      // 抓取模式下放開拖曳後，瀏覽器仍會補發一次原生 click——不短路的話會
      // 多選到／清掉一個元素（05-INTERACTIONS.feature「抓取模式」場景，
      // NOOP-83 §4.2）。stage-pan-end 本身不設 suppressNextClick，因為那個
      // 旗標是給「已經送出 gesture-end 的手勢」用的，這裡是完全不同的路徑。
      if (stageHandMode) return;
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      var additive = event.shiftKey || event.metaKey || event.ctrlKey;
      var target = resolveClickTargetAtEvent(event);
      if (!target) {
        if (additive) return; // Shift/Cmd-click on blank changes nothing.
        selectedIds = [];
        updateBoxes();
        post(withGroupPath({ event: "clear" }));
        return;
      }
      var id = target.getAttribute("id");
      var name = target.getAttribute("data-comot-name");
      var isTable = target.getAttribute("data-comot-type") === "table";
      // E2.T14 §4.5: every cell in a table resolves to the SAME container
      // id (cells carry no id of their own) — a ⇧-click on a second cell
      // of an ALREADY-selected table would otherwise hit the ordinary
      // multi-element toggle logic below and read as "this id is already
      // selected, shift-click removes it", deselecting the whole table
      // out from under the cell-range gesture the user actually performed
      // (found via the manual browser smoke test: the range overlay
      // vanished on the second, ⇧-held click). A ⇧-click that stays
      // inside the same already-selected table is therefore a pure
      // cell-range gesture — the table's own selection is left untouched,
      // and the ordinary "select" toggle/post below is skipped entirely.
      var isRangeGestureWithinSelectedTable = additive && isTable && selectedIds.length === 1 && selectedIds[0] === id;
      if (!isRangeGestureWithinSelectedTable) {
        if (additive) {
          var idx = selectedIds.indexOf(id);
          if (idx >= 0) selectedIds.splice(idx, 1);
          else selectedIds.push(id);
        } else {
          selectedIds = [id];
        }
        updateBoxes();
        post(withGroupPath({ event: "select", id: id, name: name, additive: additive }));
      }
      // A click on any cell also reports which one, alongside the
      // ordinary "select" of the table container itself (skipped above
      // for the same-table ⇧-click case) — the host sets the cell range
      // from this, the table's own selection state from "select".
      if (isTable) {
        var cellEl = findTableCellElement(event.target);
        var address = cellEl && tableCellAddress(cellEl);
        if (address) {
          post({ event: "table-cell-click", id: id, row: address.row, col: address.col, additive: event.shiftKey });
        }
      }
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
      if (editingId !== null) return;
      var target = resolveClickTargetAtEvent(event);
      if (!target) return;
      // A text box's container carries data-comot-text-width (#76) — double
      // clicking it opens in-place editing instead of the group-entry
      // logic below. resolveClickTarget already ran findSelectable, which
      // returns null (so `target` is null, handled above) for a locked
      // box or anything inside one — this is the dblclick path's half of
      // the "two checks" lock posture (§7 決定 8); enterRuntimeTextEdit's
      // own isLockedOrInsideLocked is the other half, for the
      // host-initiated beginTextEdit path this click never goes through.
      if (target.hasAttribute("data-comot-text-width") || isPlainTextContainer(target)) {
        pendingEditPoint = { x: event.clientX, y: event.clientY };
        post({ event: "dblclick-textbox", id: target.getAttribute("id") });
        return;
      }
      // E2.T14 §4.5: double-clicking a table cell opens cell editing
      // instead of the group-entry logic below (a table is never a group,
      // see `isGroupContainer`'s own comment) — a generated cell reports
      // its template row's row index instead of its own (架構:
      // "雙擊編輯的是模板列").
      // E2.T14 §4.5: a double-click on a table cell ALWAYS edits that cell,
      // however many not-yet-entered groups wrap the table — the group
      // chain becomes the drill-in path in one go (a table is never a group
      // itself, see `isGroupContainer`). One level per double-click (the
      // ordinary group rule below) made a grouped table read as "cannot be
      // edited any more" in manual review: the first double-click looked
      // like nothing happened.
      var dblclickCell = findTableCellElement(event.target);
      var dblclickTable = dblclickCell && tableContainerOf(dblclickCell);
      if (dblclickTable) {
        var chain = unlockedAncestorChain(dblclickTable);
        if (chain) {
          groupPath = chain;
          selectedIds = [dblclickTable.getAttribute("id")];
          updateBoxes();
          post(withGroupPath({ event: "select", id: dblclickTable.getAttribute("id"), name: dblclickTable.getAttribute("data-comot-name"), additive: false }));
          postTableCellDblclick(dblclickTable, event.target);
          return;
        }
      }
      // E2.T12 plan §3.6: a chart container opens its data window instead
      // of the group-entry logic below. A chart nested inside a not-yet-
      // entered group resolves to that GROUP here (findSelectable's
      // outermost-within-scope rule), so this branch naturally only fires
      // once the chart itself is the resolved target — the group-drilling
      // branch below still runs first for the outer dblclick, exactly the
      // existing "group 鑽入" two-dblclick sequence plan §4.4 asks for.
      if (target.getAttribute("data-comot-type") === "chart") {
        post({ event: "dblclick-chart", id: target.getAttribute("id") });
        return;
      }
      if (!isGroupContainer(target)) return;
      groupPath.push(target.getAttribute("id"));
      var inner = resolveClickTargetAtEvent(event);
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

  /** The `data-comot-type="table"` container a cell belongs to, or null. */
  function tableContainerOf(cellEl) {
    var current = cellEl.parentElement;
    while (current && current !== document.body) {
      if (current.getAttribute && current.getAttribute("data-comot-type") === "table") return current;
      current = current.parentElement;
    }
    return null;
  }

  /** The ids of every id-carrying container above `el` up to the slide root, outermost first — the `groupPath` that makes `el` the resolved target. `null` when `el` or any ancestor is locked (ADR-0013: not reachable in view mode at all). */
  function unlockedAncestorChain(el) {
    if (el.getAttribute("data-comot-lock") === "true") return null;
    var chain = [];
    var current = el.parentElement;
    while (current && current !== document.body) {
      var tag = current.tagName ? current.tagName.toLowerCase() : "";
      if (tag === "svg" && !current.ownerSVGElement) break;
      if (current.getAttribute && current.getAttribute("data-comot-lock") === "true") return null;
      if (current.hasAttribute && current.hasAttribute("id")) chain.unshift(current.getAttribute("id"));
      current = current.parentElement;
    }
    return chain;
  }

  /** E2.T14 §4.5: reports the cell under `rawTarget` of table `tableEl` for editing — a generated cell reports its template row's row index instead of its own (架構: "雙擊編輯的是模板列"). */
  function postTableCellDblclick(tableEl, rawTarget) {
    var tableCellEl = findTableCellElement(rawTarget);
    var cellAddress = tableCellEl && tableCellAddress(tableCellEl);
    if (!cellAddress) return;
    var reportedRow = cellAddress.row;
    if (tableCellEl.getAttribute("data-comot-generated") === "1") {
      var templateCell = findTemplateCellForColumn(tableEl, cellAddress.col);
      var templateAddress = templateCell && tableCellAddress(templateCell);
      if (templateAddress) reportedRow = templateAddress.row;
    }
    // `atRow` is the clicked cell's OWN row — the template row is display:none,
    // so the editor must be drawn over the generated cell the author actually hit.
    post({ event: "table-cell-dblclick", id: tableEl.getAttribute("id"), row: reportedRow, col: cellAddress.col, atRow: cellAddress.row });
  }

  window.addEventListener("resize", function () {
    reportViewport();
    updateBoxes();
    positionMediaOverlays();
    reportEmbedBoxes();
  });

  // T3/NOOP-142: a system file dragged over this iframe never reaches the
  // parent document's own dragenter listener — the browser delivers drag
  // events to whichever document the pointer is physically over, and this
  // opaque-origin document is a separate delivery target. This is the only
  // signal the parent needs to show its drop overlay, so it is the only
  // thing sent: never dataTransfer's files/items (ADR-0010 — this document
  // is untrusted, its "files" could be forged by slide script, and the
  // real bytes only ever leave through the browser's own native drop event
  // firing on the parent's overlay once it is shown).
  window.addEventListener("dragenter", function () {
    post({ event: "drag-enter" });
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
  // [E2.T17] plan §4.4: only reachable once bodyMarkup's SVG has actually
  // been parsed — same reason reportViewport() itself waits for `load`.
  window.addEventListener("load", buildMediaOverlays);
  window.addEventListener("load", reportEmbedBoxes);
  // [NOOP-349 round 3] wrapSelectionDocument() places this runtime's <script>
  // before bodyMarkup, so the IIFE-end call to reportElementBounds() below
  // always runs before the root <svg> exists and reports an empty map. The
  // only other trigger was document.fonts.ready, which can take seconds (or
  // never fire for shape-only slides) — until then, a marquee drawn right
  // after a slide change hits an empty elementBoundsById on the host and
  // silently selects nothing. This "load" listener closes that window with a
  // real report as soon as the markup is parsed.
  window.addEventListener("load", reportElementBounds);

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

  // [E5.T7]/F-17: separate rAF/pending state from scheduleGestureMove's own
  // above — a hover report and an in-progress gesture's move report are
  // mutually exclusive (see the pointermove listener below), but keeping
  // independent scheduling state means neither one's coalescing can ever
  // drop or delay the other's.
  var hoverRafScheduled = false;
  var pendingHover = null;

  function scheduleHoverMove(point) {
    pendingHover = point;
    if (hoverRafScheduled) return;
    hoverRafScheduled = true;
    requestAnimationFrame(function () {
      hoverRafScheduled = false;
      if (!pendingHover) return;
      var point = pendingHover;
      pendingHover = null;
      post({ event: "stage-hover", point: point });
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

  // E2.T14r2 §4.2: the id of the table currently owning an active cell
  // range, set by the host's own "table-range" command (below) — `null`
  // means no range is active, and every key this flag would otherwise
  // reroute (Delete/Backspace/Tab/⌘B/Esc) keeps its pre-existing behaviour
  // bit-for-bit (§2.20).
  var tableRangeId = null;

  // --- Stage navigation relay (Dev-Leader 裁決核准的擴大範圍：舞台導航
  // 5 場景，NOOP-83 §3.3/§4) ---
  // Same posture as every other message in this file: report raw
  // client-px coordinates and a wheel event's own ctrl/meta flag, do zero
  // geometry here. The parent (canvas.ts) converts iframe-local client
  // coordinates to parent-document client coordinates and calls
  // stage-view.ts's zoomByWheel/panBy — this runtime never reads or
  // computes zoom/pan itself.
  var stageHandMode = false;
  // The pointerId of an in-progress stage-pan drag, or null between drags
  // — mirrors `gesture`'s own single-active-pointer tracking above, kept
  // separate because a pan and an element gesture are mutually exclusive
  // (stageHandMode gates which one a given pointerdown can start).
  var stagePanPointerId = null;

  window.addEventListener(
    "wheel",
    function (event) {
      // Always relayed regardless of stageHandMode — wheel-zoom/pan works
      // whether or not 抓取模式 is toggled on (05-INTERACTIONS.feature).
      // preventDefault() is load-bearing for the ctrl/meta case: without
      // it the browser treats ⌘/Ctrl+wheel as a page zoom instead of
      // delivering the gesture here.
      event.preventDefault();
      post({
        event: "stage-wheel",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        zoomModifier: event.ctrlKey || event.metaKey,
        point: { x: event.clientX, y: event.clientY },
      });
    },
    { passive: false },
  );

  // NOOP-65 §4.4: Enter (no modifier at all), when nothing is being edited
  // and exactly one text-bearing element is selected, opens it for
  // in-place editing — the keyboard equivalent of double-click, reusing
  // the exact same `dblclick-textbox` message and host-side flow (so the
  // caret lands wherever `enterRuntimeTextEdit`'s own default already
  // puts it: the end of the string). Any other selection shape (0, ≥2, or
  // a non-text element) is a no-op, not an error (§4.4's contract table) —
  // falls through untouched to whatever this key would otherwise do.
  // Deliberately does NOT pre-check `data-comot-lock` itself: a locked
  // element reaches here only via the host's own "selection" command (a
  // plain click can never select one at all — `findSelectable` already
  // refuses it), and the existing `begin-text-edit` round trip
  // (`enterRuntimeTextEdit`'s own lock check → `text-edit-denied`) is
  // already the one place that denial is decided — re-deciding it here
  // would just be a second, easier-to-drift copy of the same rule.
  // Guarded on `editingId === null` and `!gesture` the same way
  // `isRelayedStageKey` below is: once an edit session is open, the
  // textarea's own keydown handler owns Enter instead.
  window.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (editingId !== null || gesture) return;
    if (selectedIds.length !== 1) return;
    var el = document.getElementById(selectedIds[0]);
    if (!el) return;
    // E2.T12 plan §3.6: same keyboard-equivalent-of-double-click reuse, for
    // a selected chart's data window instead of text editing.
    if (el.getAttribute("data-comot-type") === "chart") {
      event.preventDefault();
      post({ event: "dblclick-chart", id: el.getAttribute("id") });
      return;
    }
    if (!el.hasAttribute("data-comot-text-width") && !isPlainTextContainer(el)) return;
    event.preventDefault();
    pendingEditPoint = null;
    post({ event: "dblclick-textbox", id: el.getAttribute("id") });
  });

  // Space 暫時抓取的中繼 (§4.4)：when focus has moved into this iframe
  // (e.g. after clicking a slide element), the parent document's own
  // window-level keydown listener (Stage.tsx) never sees Space at all —
  // without this relay, temporary-grab would only work before the first
  // click. Skipped while text-editing so Space still types a space
  // character, matching Stage.tsx's own targetIsTextInput guard.
  window.addEventListener("keydown", function (event) {
    if (event.key !== " " && event.code !== "Space") return;
    if (editingId !== null) return;
    event.preventDefault();
    post({ event: "stage-space", down: true });
  });
  window.addEventListener("keyup", function (event) {
    if (event.key !== " " && event.code !== "Space") return;
    if (editingId !== null) return;
    post({ event: "stage-space", down: false });
  });
  // iframe losing focus while Space is physically still held (e.g. Alt-Tab)
  // must not leave the parent stuck in temporary-grab forever — releaseSpace
  // is idempotent host-side, so sending this unconditionally on every blur
  // is safe even when Space was never down.
  window.addEventListener("blur", function () {
    post({ event: "stage-space", down: false });
  });

  window.addEventListener(
    "pointerdown",
    function (event) {
      if (event.button !== 0) return; // Left button only — no gesture on right/middle click.
      // [E2.T17] plan §4.4: a drag that starts on the media control bar
      // (dragging the seek `<input type="range">`) must never be hijacked
      // into an element/marquee gesture — letting the browser's own native
      // range-drag handling run untouched is what makes seeking work at
      // all, so this returns before any of the gesture state below is set.
      if (findMediaControlTarget(event)) return;
      if (editingId !== null) {
        var editedEl = document.getElementById(editingId);
        var insideEdited = editedEl && (editedEl === event.target || editedEl.contains(event.target));
        if (insideEdited) {
          // Still editing — no element gesture starts on the box being
          // edited itself. Instead this begins a text-selection drag
          // (ADR-0017 §4.5), unless an IME composition is in progress
          // (§4.4: pointer input must not disturb selectionStart/End while
          // composing).
          if (isComposing) return;
          var idx = indexAtPoint(event.clientX, event.clientY);
          if (idx === null) return;
          // The click lands on the SVG text, not the textarea itself — a
          // browser's default mousedown action blurs whatever currently
          // has focus when the pressed target isn't itself focusable.
          // Without preventDefault() here, this would blur `textarea`
          // (dropping keyboard focus out of the edit session) the instant
          // this same click sets the selection it was meant to change.
          event.preventDefault();
          textSelectDrag = { pointerId: event.pointerId, anchor: idx };
          textarea.focus();
          textarea.setSelectionRange(idx, idx);
          updateEditDecoration();
          return;
        }
        // Outside the edited box: commit and leave editing (§4.2's
        // "pointerdown 落在被編輯元素之外" row). This same pointerdown does
        // not also start a new gesture/selection — suppressNextClick only
        // eats the trailing click; a second, separate click is what
        // resumes normal selection.
        post({ event: "text-edit-commit", id: editingId });
        exitRuntimeTextEdit();
        suppressNextClick = true;
        return;
      }
      if (stageHandMode) {
        // 抓取模式短路分支：no element gesture starts at all while the
        // ✋ toggle (or temporary Space-hold) is active — this branch
        // takes over the pointer completely instead of falling through
        // to the hit-test/gesture logic below, which stays byte-for-byte
        // unchanged for the handMode === false case.
        stagePanPointerId = event.pointerId;
        document.documentElement.style.cursor = "grabbing";
        post({ event: "stage-pan-start", point: { x: event.clientX, y: event.clientY } });
        return;
      }
      var handleName = findHandleTarget(event);
      var hit = handleName ? null : resolveClickTargetAtEvent(event);
      gesture = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        lastClient: { x: event.clientX, y: event.clientY },
        hitId: hit ? hit.getAttribute("id") : null,
        handleName: handleName,
        // ⇧/⌘/Ctrl held at pointer-down: a drag that starts on an unselected
        // element ADDS it to the selection instead of replacing it (below).
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
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
      // [E5.T7]/F-17: the context bar's own hover-solidify state (parent
      // document, OverlayLayer) needs to know where the pointer is while it
      // is over the slide — but only when nothing else here is already
      // consuming it (a text-select drag, a stage-pan, or an element
      // gesture all report their own point for their own purpose), and only
      // when something is selected (no selection means no context bar to
      // solidify).
      if (!textSelectDrag && stagePanPointerId === null && !gesture && selectedIds.length > 0) {
        scheduleHoverMove({ x: event.clientX, y: event.clientY });
      }
      if (textSelectDrag && event.pointerId === textSelectDrag.pointerId) {
        var dragIdx = indexAtPoint(event.clientX, event.clientY);
        if (dragIdx === null) return;
        textarea.setSelectionRange(Math.min(textSelectDrag.anchor, dragIdx), Math.max(textSelectDrag.anchor, dragIdx));
        updateEditDecoration();
        return;
      }
      if (stagePanPointerId !== null) {
        if (event.pointerId !== stagePanPointerId) return;
        post({ event: "stage-pan-move", point: { x: event.clientX, y: event.clientY } });
        return;
      }
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
            // With ⇧/⌘/Ctrl held it ADDS instead: a ⇧-click that jitters
            // past DRAG_THRESHOLD_PX (trackpads do) must not silently throw
            // away the multi-selection the user was building — found when a
            // human's "⇧-click chart, Group" kept ending up with only the
            // chart selected.
            var target = document.getElementById(gesture.hitId);
            selectedIds = gesture.additive ? selectedIds.concat([gesture.hitId]) : [gesture.hitId];
            updateBoxes();
            post(withGroupPath({ event: "select", id: gesture.hitId, name: target ? target.getAttribute("data-comot-name") : null, additive: gesture.additive }));
          }
        }
        // reportViewport() is otherwise only wired to the iframe's own
        // "load"/"resize" events (below). A gesture can start before "load"
        // has fired, and postMessage delivery preserves send order, so
        // sending "viewport" here — synchronously, before "gesture-start" —
        // guarantees the host already has a viewport by the time it
        // processes gesture-start, instead of racing "load" (NOOP-328: that
        // race let the host's toUserPoint fall back to (0,0), producing a
        // drag landing 180px off target).
        if (gesture.kind === "marquee") {
          // [NOOP-349 round 3] Same race as NOOP-328, for the other message
          // a marquee needs: elementBoundsById. A marquee that starts before
          // "load" (or before document.fonts.ready) races an empty bounds
          // map on the host, which makes endMarqueeGesture's hit test find
          // nothing and silently select zero elements. Only marquee needs
          // bounds to determine its hits; move/scale/rotate/textbox-width
          // only use bounds as snap candidates, so they don't pay for this
          // extra report on every gesture start.
          reportElementBounds();
        }
        reportViewport();
        post({ event: "gesture-start", kind: gesture.kind, handle: gesture.handle, point: gesture.startClient });
      }
      scheduleGestureMove({ x: event.clientX, y: event.clientY }, { shift: event.shiftKey, alt: event.altKey });
    },
    true,
  );

  window.addEventListener(
    "pointerup",
    function (event) {
      if (textSelectDrag && event.pointerId === textSelectDrag.pointerId) {
        textSelectDrag = null;
        suppressNextClick = true; // Eat the trailing click (§4.5) — the editingId!==null click handler already ignores it, but this matches every other gesture's own suppression.
        updateEditDecoration();
        return;
      }
      if (stagePanPointerId !== null) {
        if (event.pointerId === stagePanPointerId) {
          stagePanPointerId = null;
          document.documentElement.style.cursor = stageHandMode ? "grab" : "";
          post({ event: "stage-pan-end" });
        }
        return;
      }
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
    if (textSelectDrag && event.pointerId === textSelectDrag.pointerId) {
      textSelectDrag = null;
      return;
    }
    if (stagePanPointerId !== null && event.pointerId === stagePanPointerId) {
      stagePanPointerId = null;
      document.documentElement.style.cursor = stageHandMode ? "grab" : "";
      post({ event: "stage-pan-end" });
      return;
    }
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    endGesture(gesture.lastClient, true);
  });

  window.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    // Esc COMMITS an in-progress edit rather than cancelling it (§7 決定
    // 4) — checked before the gesture-cancel branch below, since Escape
    // must never fall through to popping groupPath while mid-edit. Works
    // regardless of whether the hidden textarea currently has focus: this
    // listener is on `window`, and keydown bubbles there from any focus
    // target in this document.
    if (editingId !== null) {
      // Mid-composition, Esc belongs to the IME (cancelling the candidate,
      // not the edit) — ADR-0017 §4.4. `compositionend` will fire from
      // that, and Esc resumes committing the edit on any subsequent press.
      if (isComposing) return;
      post({ event: "text-edit-commit", id: editingId });
      exitRuntimeTextEdit();
      return;
    }
    if (gesture) {
      endGesture(gesture.lastClient, true);
      return;
    }
    // E2.T14r2 §4.2: a cell range in progress owns Esc while active — it
    // exits the range (parent decides: table stays selected) instead of
    // popping group-path or clearing the selection. Must sit here: after
    // the editingId/gesture branches above (§4.2's own ordering), before
    // the groupPath branch below.
    if (tableRangeId !== null) {
      post({ event: "table-key", id: tableRangeId, key: "Escape", meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey });
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
  // Otherwise: right-click on an element selects it (if not already part of
  // the current selection) and suppresses the browser's own menu — there is
  // no element context menu any more (issue 198 review: its items moved into
  // the parent's left-click context bar). Right-click on blank canvas is
  // left alone entirely.
  window.addEventListener("contextmenu", function (event) {
    if (gesture && gesture.started) {
      event.preventDefault();
      endGesture(gesture.lastClient, true);
      return;
    }
    if (editingId !== null || stageHandMode) return;
    var target = resolveClickTargetAtEvent(event);
    if (!target) return;
    event.preventDefault();
    var id = target.getAttribute("id");
    if (selectedIds.indexOf(id) === -1) {
      selectedIds = [id];
      updateBoxes();
      post(withGroupPath({ event: "select", id: id, name: target.getAttribute("data-comot-name"), additive: false }));
    }
    // E2.T14 §4.5: right-clicking a table cell also reports which one —
    // the host uses this to open the cell context menu (§3.7: the right-
    // click menu itself is a parent-document floating layer, this runtime
    // only ever reports the hit).
    if (target.getAttribute("data-comot-type") === "table") {
      var cellEl = findTableCellElement(event.target);
      var address = cellEl && tableCellAddress(cellEl);
      if (address) {
        post({ event: "table-cell-contextmenu", id: id, row: address.row, col: address.col, x: event.clientX, y: event.clientY });
      }
    }
  });

  // Keyboard relay for the shortcuts that must work even when focus is
  // inside this iframe (NOOP-90/T2 §4.4's "焦點在投影片 iframe 內" row —
  // the parent document's own window-level keydown listener never sees a
  // keypress that landed in here). Whitelisted to exactly the keys the
  // parent has shortcuts for: this ticket's four, plus ⌘Z/⇧⌘Z (issue 198;
  // written without the hash so the no-hex-colour source check stays
  // honest) — once a click on the stage has moved focus in here, App.tsx's
  // document-level undo/redo listener would otherwise go deaf. Everything
  // else (⌘S, arrow
  // keys, Tab, …) is untouched and falls through to whatever this iframe's
  // own default handling already does. Never relayed while editing text or
  // mid-gesture — same posture as the existing Space relay above — nor in
  // play mode, which the parent itself already gates before acting on
  // `stage-key`.
  function isRelayedStageKey(event) {
    if (event.key === "Delete" || event.key === "Backspace") return true;
    // E2.T12: Escape closing the chart data window is a parent-side (React)
    // concern with no runtime-local meaning of its own — unlike every other
    // relayed key, this one is on top of, not instead of, the runtime's own
    // unconditional Escape handling above (text-edit-commit / gesture
    // cancel / group-path pop / clear-selection), since those and "close
    // the chart window if one happens to be open" are independent.
    if (event.key === "Escape") return true;
    var withModifier = event.metaKey || event.ctrlKey;
    if (!withModifier) return false;
    // [E2.T18]: c/x/v added alongside a/d/]/[/z/Z — headless Chromium
    // testing showed Ctrl/Cmd+C/X do not fire a native ClipboardEvent for a
    // keyboard-only trigger with no real DOM/text selection (our selection
    // is a Shadow DOM overlay, not one Chromium's clipboard commands see),
    // so ⌘C/⌘X/⌘V are relayed as ordinary keys and handled with the async
    // `navigator.clipboard` API on the host side (canvas.ts's "stage-key"
    // handler), exactly like every other shortcut in this list.
    // event.key for Shift+] is "}" on a US layout (not "]"), and on
    // non-US layouts the bracket may sit on a different key entirely —
    // event.code identifies the physical key regardless of layout or
    // Shift, so it is checked alongside the character forms.
    if (event.code === "BracketRight" || event.code === "BracketLeft") return true;
    return (
      event.key === "a" || event.key === "d" || event.key === "]" || event.key === "[" ||
      event.key === "}" || event.key === "{" ||
      event.key === "z" || event.key === "Z" || event.key === "c" || event.key === "x" || event.key === "v"
    );
  }
  window.addEventListener("keydown", function (event) {
    if (!isRelayedStageKey(event)) return;
    if (editingId !== null || gesture) return;
    // E2.T14r2 §4.2: while a cell range owns Delete/Backspace, the listener
    // below relays it as "table-key" instead — never both for the same
    // keypress. Every other key this function whitelists (⌘A/⌘D/⌘]/⌘[/⌘Z)
    // keeps going through "stage-key" unchanged even with a range active
    // (§2.22).
    if (tableRangeId !== null && (event.key === "Delete" || event.key === "Backspace")) return;
    event.preventDefault();
    post({
      event: "stage-key",
      key: event.key,
      code: event.code,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
    });
  });

  /** Tab/⇧Tab and ⌘B/Ctrl+B — relayed ONLY while a cell range is active (E2.T14r2 §4.2); untouched otherwise, same as this file's own pre-existing comment on `isRelayedStageKey` already promises ("Everything else … is untouched"). */
  function isTableRangeKey(event) {
    if (event.key === "Tab") return true;
    return (event.key === "b" || event.key === "B") && (event.metaKey || event.ctrlKey);
  }
  window.addEventListener("keydown", function (event) {
    if (tableRangeId === null) return;
    if (editingId !== null || gesture) return;
    var isRangeDelete = event.key === "Delete" || event.key === "Backspace";
    if (!isRangeDelete && !isTableRangeKey(event)) return;
    event.preventDefault(); // Tab would otherwise move focus; Delete/⌘B have their own default actions to suppress too.
    post({
      event: "table-key",
      id: tableRangeId,
      key: event.key,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
    });
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
   * A container holding exactly one `<text>` and no other element — the
   * shape `text set` writes through unchanged (core's
   * `replaceContainerText`). Text boxes are the wrapping variant of this,
   * marked by `data-comot-text-width`; everything else here is a plain
   * `<text>` whose own x/y/text-anchor stay authoritative.
   */
  function isPlainTextContainer(el) {
    var children = el.children;
    var texts = 0;
    for (var i = 0; i < children.length; i++) {
      if (children[i].tagName === "text") texts++;
      else return false;
    }
    return texts === 1;
  }

  /**
   * F8 (NOOP-289 決定 T1): rebuilds a text box's `<text>` content into "one
   * hard-break paragraph = one `<tspan>`" — zero measurement, zero wrap.
   * `x` is read off the CURRENT first line (either an existing tspan, or —
   * on the very first call for a given edit session — the `<text>`'s own
   * `x`) so re-entering the same content is idempotent; every line after
   * the first gets a plain relative `dy` (no attempt at the real line
   * height core's font metrics used to compute) and `data-comot-break="1"`,
   * the same marker `textLineRanges()` already reads to place a virtual
   * `\n` in the caret's `textarea.value` index space. Alignment/runs are
   * NOT reproduced — decision T1 accepts left-anchored, unstyled text
   * during an edit session as the known UX regression this ticket trades
   * for removing the browser's font-metrics engine entirely.
   */
  function renderTextBoxLines(textEl, text) {
    var firstChild = textEl.firstElementChild;
    var x = firstChild && firstChild.tagName === "tspan" ? firstChild.getAttribute("x") : textEl.getAttribute("x");
    var y = firstChild && firstChild.tagName === "tspan" ? firstChild.getAttribute("y") : textEl.getAttribute("y");
    while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
    var lines = (typeof text === "string" ? text : "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      if (x !== null) tspan.setAttribute("x", x);
      if (i === 0) {
        if (y !== null) tspan.setAttribute("y", y);
      } else {
        tspan.setAttribute("dy", "1.2em");
      }
      // `data-comot-break="1"` marks a line that is FOLLOWED by a "\n" in
      // the original content string (textLineRanges()'s own contract,
      // read/write-symmetric with core's original convention) — i.e.
      // every line except the last one, not every line except the first.
      // Putting it on the wrong tspan is exactly the off-by-one A16/A17
      // guard against (see this file's own textLineRanges doc comment).
      if (i < lines.length - 1) tspan.setAttribute("data-comot-break", "1");
      tspan.textContent = lines[i];
      textEl.appendChild(tspan);
    }
  }

  /**
   * The one place `<text>` content is repainted during an edit session
   * (begin-text-edit's initial paint, every keystroke, and a failed
   * commit's revert) — text-box vs plain-`<text>` is decided by
   * `data-comot-text-width`'s presence on the CONTAINER, which this
   * function already knows how to check, so none of its three call sites
   * (all host-driven, or the runtime's own `input` handler) have to.
   */
  function applyTextEditContent(id, text) {
    var container = document.getElementById(id);
    if (!container) return;
    var textEl = contentTextElement(container);
    if (!textEl) return;
    if (container.hasAttribute("data-comot-text-width")) renderTextBoxLines(textEl, text);
    else textEl.textContent = typeof text === "string" ? text : "";
    updateBoxes();
  }

  // F8 (NOOP-289 決定 (b)): while dragging a textbox-width handle, the box
  // and handles track the PROPOSED width without the `<text>` content
  // moving at all (there is no font engine left here to re-wrap it with) —
  // {id, width} of the element currently being live-previewed, read by
  // `selectionClientRect()` below. Left set after the drag ends (host
  // always sends one final "preview-textbox-width" — either the committed
  // width or a revert to `originalWidth`), which is harmless: at that
  // point it agrees with the container's own real bbox again.
  var previewTextWidth = null;

  /** `preview-textbox-width` (F8, NOOP-289 決定 (b)): updates `data-comot-text-width` and the live-preview override the box/handles read — never touches `<text>`. */
  function applyPreviewTextboxWidth(id, width) {
    var container = document.getElementById(id);
    if (!container || typeof width !== "number" || !(width > 0)) return;
    container.setAttribute("data-comot-text-width", String(width));
    previewTextWidth = { id: id, width: width };
    updateBoxes();
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
    } else if (data.command === "preview-textbox-width") {
      applyPreviewTextboxWidth(data.id, data.width);
    } else if (data.command === "revert-text-edit") {
      // Sent after a failed `text set` — the runtime has already exited
      // its own edit session by then (enterRuntimeTextEdit's caller always
      // calls exitRuntimeTextEdit() before the host's commit round trip
      // even starts), so this just repaints `<text>` back to the file's
      // real content, independent of editingId/textarea.
      applyTextEditContent(data.id, data.text);
    } else if (data.command === "begin-text-edit") {
      var started = enterRuntimeTextEdit(data.id, data.text);
      if (started) {
        // 決定 T1: always repaint immediately — a text box's existing
        // content may still carry rich runs/soft-wrap tspans from before
        // this edit session; this flattens it to the "one tspan per hard
        // break" shape before the first keystroke, matching every
        // keystroke that follows (the `input` handler below).
        applyTextEditContent(data.id, typeof data.text === "string" ? data.text : "");
        // Only now is the edit-time DOM in place to hit-test against.
        if (pendingEditPoint) {
          var clickIdx = indexAtPoint(pendingEditPoint.x, pendingEditPoint.y);
          if (clickIdx !== null) {
            textarea.setSelectionRange(clickIdx, clickIdx);
            updateEditDecoration();
          }
        }
      } else post({ event: "text-edit-denied", id: data.id });
      pendingEditPoint = null;
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
    } else if (data.command === "stage-mode") {
      stageHandMode = Boolean(data.hand);
      document.documentElement.style.cursor = stageHandMode ? "grab" : "";
    } else if (data.command === "measure") {
      reportMeasured(Array.isArray(data.ids) ? data.ids : []);
    } else if (data.command === "table-cells") {
      reportTableCells(data.id);
    } else if (data.command === "preview-table-cols") {
      applyPreviewTableCols(data.id, data.cols);
    } else if (data.command === "table-range") {
      // E2.T14r2 §4.2: a malformed id (neither string nor null) leaves the
      // flag untouched — same "bad input is a no-op" posture
      // `applyPreviewTableCols` already has for its own malformed input.
      if (typeof data.id === "string" || data.id === null) tableRangeId = data.id;
    }
  });

  /**
   * F8 (NOOP-289 決定 G1): every id-carrying element's bounding box — the
   * browser has no bundled font-metrics engine any more to compute one
   * from the parsed model, so this replaces core's `elementBounds` as the
   * host's one source for marquee hit-testing and drag-to-move's snap
   * candidates (`canvas.ts`'s `elementBoundsById`). Two numbers per id:
   *
   * `rect` is the full container-chain box in the SLIDE'S OWN viewBox
   * coordinate system — the same space `elementBounds(element,
   * {ancestors, fonts})` used to compute. `el.getCTM()` does NOT give this
   * on its own (verified empirically, not assumed): for an element whose
   * nearest viewport-establishing ancestor is the top-level `<svg>`,
   * `getCTM()` resolves the WHOLE way out through that svg's own
   * viewBox-to-viewport scaling to actual CSS pixels — i.e. the same thing
   * `getScreenCTM()` gives when nothing above the svg carries a CSS
   * transform (`root.getCTM()` on the outermost `<svg>` itself already
   * shows the viewBox scale factor, not identity). The fix: compose the
   * element's own `getScreenCTM()` with the ROOT `<svg>`'s
   * `getScreenCTM()` INVERTED — `rootInverse ∘ elementScreenCTM` maps
   * element-local space to client px and then undoes exactly the root's
   * own client-px mapping, landing in the root's viewBox units regardless
   * of any zoom/pan CSS transform sitting above the svg.
   *
   * `local` is `el.getBBox()` alone — the element's own bbox before its
   * own transform, which is what the scale-gesture anchor corner needs
   * (already in the same "user units" space, no conversion required).
   *
   * `getBBox`/`getScreenCTM` unavailable (jsdom) or throwing (a genuinely
   * degenerate element, or no root `<svg>` at all) both just skip — same
   * "leave it out" degradation `computeBounds`'s old try/catch already had.
   */
  function reportElementBounds() {
    var items = [];
    var svgRoot = document.querySelector("svg");
    var rootInverse = null;
    if (svgRoot && typeof svgRoot.getScreenCTM === "function") {
      try {
        var rootScreenCTM = svgRoot.getScreenCTM();
        if (rootScreenCTM) rootInverse = rootScreenCTM.inverse();
      } catch (err) {
        rootInverse = null;
      }
    }
    if (rootInverse) {
      var els = document.querySelectorAll("[id]");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (typeof el.getBBox !== "function" || typeof el.getScreenCTM !== "function") continue;
        var bbox, screenCtm;
        try {
          bbox = el.getBBox();
          screenCtm = el.getScreenCTM();
        } catch (err2) {
          continue;
        }
        if (!bbox || !screenCtm) continue;
        var combined = rootInverse.multiply(screenCtm);
        var corners = [
          toClientPoint(combined, { x: bbox.x, y: bbox.y }),
          toClientPoint(combined, { x: bbox.x + bbox.width, y: bbox.y }),
          toClientPoint(combined, { x: bbox.x, y: bbox.y + bbox.height }),
          toClientPoint(combined, { x: bbox.x + bbox.width, y: bbox.y + bbox.height }),
        ];
        var xs = corners.map(function (p) {
          return p.x;
        });
        var ys = corners.map(function (p) {
          return p.y;
        });
        var left = Math.min.apply(null, xs);
        var top = Math.min.apply(null, ys);
        items.push({
          id: el.getAttribute("id"),
          rect: { x: left, y: top, width: Math.max.apply(null, xs) - left, height: Math.max.apply(null, ys) - top },
          local: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
        });
      }
    }
    post({ event: "element-bounds", items: items });
  }

  // Tells the parent this document's listeners (including the one right
  // above) are attached — a `postMessage` sent before that would be
  // silently dropped (same race `selectOnceLoaded` in canvas.ts already
  // works around for other host->runtime commands). The parent re-sends
  // "stage-mode" on this signal so 抓取模式 survives a slide's srcdoc being
  // rebuilt (e.g. navigating to another slide) instead of reverting to
  // off on every new document.
  post({ event: "runtime-ready" });
  // Measured once at startup for shapes/already-loaded fonts, and again
  // once every embedded web font has actually settled — text geometry can
  // change once a late-loading font swaps in, and the first measurement
  // would otherwise under/over-report a text element's box until the next
  // unrelated report happened to run.
  reportElementBounds();
  if (typeof document.fonts !== "undefined" && document.fonts && typeof document.fonts.ready !== "undefined") {
    document.fonts.ready.then(reportElementBounds, function () {});
  }
})();
