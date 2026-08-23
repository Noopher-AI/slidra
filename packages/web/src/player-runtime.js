// Plain JavaScript, no imports, self-contained — inlined into the play
// `srcdoc`'s <script> by the parent (canvas.ts, via `?raw`). Runs inside a
// sandboxed iframe with `allow-scripts` and no `allow-same-origin`, so it
// has no way to reach anything outside itself except `postMessage`.
//
// Its whole job: read window.__COMOT_PLAN__ (injected by the parent before
// this script runs — see player-plan.ts / canvas.ts), listen for the
// forward arrow key, apply visibility to the current step's elements, and
// report what happened to the parent over postMessage (C4 in the design
// doc). It never derives anything itself — all derivation (parsing the
// effect list, grouping steps) happens in the parent, in player-plan.ts,
// where it can be unit tested without a browser.
(function () {
  "use strict";

  var plan = window.__COMOT_PLAN__;
  var steps = (plan && plan.steps) || [];
  var media = (plan && plan.media) || {};
  // -1 means "no step applied yet" — everything the plan marked hidden is
  // still hidden, which is the slide's opening state.
  var currentStep = -1;
  // Target id -> the <video>/<audio> element already created for it.
  // Idempotence (ticket #30): reaching the same media target twice must
  // reuse this element rather than creating (and playing) a second one.
  var mediaElements = {};

  function post(message) {
    // The parent document has an opaque origin from this frame's point of
    // view (this frame is itself opaque-origin, with no allow-same-origin),
    // so there is no meaningful target origin to name — "*" is correct
    // here, not a shortcut. The parent authenticates the sender by identity
    // (`event.source === iframe.contentWindow`), never by trusting origin.
    var payload = { source: "comot-player" };
    for (var key in message) {
      if (Object.prototype.hasOwnProperty.call(message, key)) {
        payload[key] = message[key];
      }
    }
    parent.postMessage(payload, "*");
  }

  /**
   * Positions an overlay element exactly over its placeholder's current
   * on-screen box (ADR-0005: align to the SVG placeholder's geometry, never
   * <foreignObject>). Document coordinates, not viewport coordinates —
   * getBoundingClientRect() is viewport-relative, and this element is
   * appended to document.body as position:absolute, which is positioned
   * against the initial containing block in document coordinates — hence
   * the scrollX/scrollY correction. Called again on resize (see the
   * listener below): #29's fullscreen toggle resizes this frame without
   * reloading the document, so a once-positioned overlay would otherwise be
   * wrong after the viewport changes size mid-presentation.
   */
  function positionOverlay(el, placeholder) {
    var rect = placeholder.getBoundingClientRect();
    el.style.position = "absolute";
    el.style.left = rect.left + window.scrollX + "px";
    el.style.top = rect.top + window.scrollY + "px";
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
  }

  /**
   * Creates (or reuses) the HTML media element for a `family: "media"`
   * effect and plays it. `.play()` here is on the synchronous path from the
   * ArrowRight keydown handler all the way down — no await, no setTimeout,
   * nothing async before it — because the browser's transient activation
   * from that key press is only good for the current task; anything async
   * in between and playback-with-sound is refused (design doc, settled
   * decision #6).
   */
  function playMedia(target) {
    // Idempotence (#30 acceptance criterion): reaching the same target
    // twice must never produce a second media element playing alongside
    // the first.
    if (mediaElements[target]) return;

    var cue = media[target];
    if (!cue) {
      // The parent's plan builder (player-plan.ts) already verified every
      // media effect's target carries a cue before this plan was built, so
      // this should not happen — reported rather than silently skipped, in
      // case it ever does.
      post({ event: "error", message: "找不到媒體效果的設定：" + target });
      return;
    }
    var placeholder = document.getElementById(target);
    if (!placeholder) {
      post({ event: "error", message: "找不到媒體效果指向的元素：" + target });
      return;
    }

    var el = document.createElement(cue.kind === "video" ? "video" : "audio");
    // The raw data-comot-media value, unmodified (settled decision #3): the
    // play document already carries a <base href="/api/raw/<slide dir>">
    // (see wrapPlayDocument in canvas.ts), so the browser's own relative-URL
    // resolution turns this into the right /api/raw/ request — no URL
    // rewriting here.
    el.src = cue.src;
    positionOverlay(el, placeholder);
    document.body.appendChild(el);
    mediaElements[target] = el;

    var playResult = el.play();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(function (err) {
        // A rejected play() (autoplay refusal, decode failure, missing
        // file, …) must surface, never fail silently (design doc, settled
        // decision #12).
        post({
          event: "error",
          message: "媒體播放失敗（" + target + "）：" + (err && err.message ? err.message : String(err)),
        });
      });
    }
  }

  function applyStep(step) {
    var effects = step.effects;
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      if (effect.family === "media") {
        playMedia(effect.target);
        continue;
      }
      if (effect.family !== "enter") continue;

      var el = document.getElementById(effect.target);
      if (!el) {
        // The parent's parser (effects.ts) already verified every target
        // exists before this plan was ever built, so this should not
        // happen. Reported rather than silently skipped, in case it ever
        // does — e.g. a future bug in the parent's derivation.
        post({ event: "error", message: "找不到步驟中要顯示的元素：" + effect.target });
        continue;
      }

      // "appear" must be instant, "fade" must transition — both are driven
      // by setting inline opacity, per the design doc.
      el.style.transition = effect.effect === "fade" ? "opacity 0.4s" : "none";
      // !important: the hide stylesheet in player-plan.ts's renderHideStyle
      // also had to become !important, because a legal slide element can
      // carry its own inline opacity (e.g. style="opacity:1"), and inline
      // style normally wins the cascade over an injected stylesheet rule
      // regardless of that rule's specificity. Once the hide rule is
      // !important, a plain `el.style.opacity = "1"` here can no longer
      // beat it — inline !important is required on both sides, or a step
      // could set opacity:1 and have it silently overridden by the hide
      // rule that was supposed to have already been superseded.
      el.style.setProperty("opacity", "1", "important");
    }
  }

  function advance() {
    if (currentStep + 1 < steps.length) {
      currentStep += 1;
      applyStep(steps[currentStep]);
    } else {
      // Already on the last step (or there were no steps at all): forward
      // is the parent's move now — change slide.
      post({ event: "advance-past-end" });
    }
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      advance();
      return;
    }
    // ArrowLeft is deliberately ignored — stepping backwards is Out of
    // Scope (see #23). No other key does anything here.
  });

  window.addEventListener("resize", function () {
    // See positionOverlay's comment: the frame can be resized in place
    // (e.g. #29's requestFullscreen() on the iframe element) without this
    // document ever reloading, so every already-created media overlay must
    // be re-aligned to its placeholder's new box.
    for (var target in mediaElements) {
      if (!Object.prototype.hasOwnProperty.call(mediaElements, target)) continue;
      var placeholder = document.getElementById(target);
      if (placeholder) positionOverlay(mediaElements[target], placeholder);
    }
  });

  window.addEventListener("focus", function () {
    post({ event: "focus", hasFocus: true });
  });
  window.addEventListener("blur", function () {
    post({ event: "focus", hasFocus: false });
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "comot-host") return;
    if (data.command === "focus") {
      window.focus();
    }
  });

  post({ event: "ready" });
})();
