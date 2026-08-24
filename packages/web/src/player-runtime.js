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
  //
  // Object.create(null), not {}: element ids come straight from untrusted
  // slide content (ADR-0010), and a legal SVG id can be "constructor",
  // "toString", "__proto__", or any other name Object.prototype happens to
  // carry. A plain {} already has a truthy `mediaElements["constructor"]`
  // before this target is ever reached the first time, so the idempotence
  // guard below (`if (mediaElements[target]) return;`) would short-circuit
  // immediately and playMedia() would silently do nothing — no element,
  // no error — exactly the failure shape this project forbids (Codex
  // review gate round 1, P2; see player-runtime.test.ts's "constructor" id
  // test). Object.create(null) has no inherited properties at all, so
  // every key — however it is spelled — starts out genuinely absent.
  var mediaElements = Object.create(null);

  // Elements resetToStep() has deliberately torn down (paused + removed).
  // A WeakSet keyed by element, not by target id, for the same reason
  // mediaElements above is Object.create(null): element ids are untrusted
  // slide markup and must never be used as a lookup key. When playMedia()'s
  // play() promise settles after this teardown, the browser rejects it with
  // an AbortError — that rejection is *us* cancelling our own playback, not
  // a real failure, and must not surface as one (see playMedia's catch).
  var tornDownMedia = new WeakSet();

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
        // decision #12) — with one exception: if resetToStep() already tore
        // this exact element down before the browser got around to settling
        // the promise, an AbortError here is just the browser reporting the
        // cancellation this runtime itself caused, not a real playback
        // failure. Anything else — including an AbortError on an element
        // that was never torn down — still surfaces.
        if (err && err.name === "AbortError" && tornDownMedia.has(el)) return;
        post({
          event: "error",
          message: "媒體播放失敗（" + target + "）：" + (err && err.message ? err.message : String(err)),
        });
      });
    }
  }

  /**
   * Applies one step's effects to the DOM. `duringReplay` is true only when
   * this call is part of resetToStep's forward replay (settled decision #4):
   * media effects are skipped entirely there — playMedia is only ever
   * called from the live forward path (advance) — and every transition is
   * forced off, `fade` included, so retreating past a fade step never
   * re-plays it.
   */
  function applyStep(step, duringReplay) {
    var effects = step.effects;
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      if (effect.family === "media") {
        if (!duringReplay) playMedia(effect.target);
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
      // by setting inline opacity, per the design doc. During replay every
      // transition is off regardless of effect type (settled decision #4):
      // replaying earlier fades on retreat is exactly what #46 forbids.
      el.style.transition = !duringReplay && effect.effect === "fade" ? "opacity 0.4s" : "none";
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

  /**
   * Resets the slide to its opening state, then replays steps 0..target
   * (inclusive) forward without animation and without playing media. This
   * is the retreat approach settled for #46: rather than inverting each
   * effect family ("un-fade", "un-play"), reuse the runtime's existing
   * forward-apply capability from a known-clean starting point, so any
   * effect family — including ones that do not exist yet — retreats
   * correctly for free. Passing target = -1 replays nothing, landing back
   * on the slide's untouched opening state.
   *
   * Deliberate asymmetry (#46, do not "fix"): media is skipped during
   * replay (see applyStep), so retreating past a media step and then
   * advancing onto it again restarts that video from the beginning rather
   * than resuming it. This is intentional, not a bug to close. A single
   * key press carries exactly one transient activation (settled decision
   * #6 in the design doc), but a replay can cross several media steps at
   * once — calling .play() on more than one of them from that single
   * activation is not something the browser allows. And a rejected
   * play() must surface as a visible error, never fail silently (settled
   * decision #12) — so "fixing" this by replaying media too would turn an
   * ordinary retreat into a visible error toast whenever it crosses more
   * than one media step. Restarting instead of resuming is the only
   * option that stays inside both constraints.
   */
  function resetToStep(target) {
    for (var i = 0; i < plan.hidden.length; i++) {
      var el = document.getElementById(plan.hidden[i]);
      if (el) {
        // Force the transition off *before* removing the inline opacity, so
        // the opacity change that follows cannot be animated. Slide markup
        // is author-written and may legally carry its own CSS transition on
        // this element (an inline style or a <style> rule in the SVG); if we
        // removed our inline transition instead of overriding it, that
        // author transition would apply to the opacity drop below and the
        // element would fade out instead of vanishing instantly, breaking
        // the "retreat is instant" guarantee. Leaving `transition: none`
        // behind afterwards is deliberate, not an oversight: applyStep()
        // always sets the transition explicitly on every element it touches
        // (`opacity 0.4s` for a live fade, `none` otherwise), so nothing
        // downstream depends on this element's original transition value
        // being restored. Do not "fix" this back to removeProperty.
        el.style.setProperty("transition", "none");
        el.style.removeProperty("opacity");
      }
    }

    // Tear down every media overlay this runtime created: pause it, remove
    // it from the document, and forget it. Clearing mediaElements here is
    // load-bearing, not tidiness (settled decision #5): the idempotence
    // guard in playMedia (`if (mediaElements[target]) return;`, ticket
    // #30) would otherwise believe a fresh forward advance onto the same
    // media step had already played it, and silently do nothing.
    for (var mediaTarget in mediaElements) {
      if (!Object.prototype.hasOwnProperty.call(mediaElements, mediaTarget)) continue;
      var mediaEl = mediaElements[mediaTarget];
      tornDownMedia.add(mediaEl);
      mediaEl.pause();
      if (mediaEl.parentNode) mediaEl.parentNode.removeChild(mediaEl);
    }
    mediaElements = Object.create(null);

    for (var s = 0; s <= target; s++) {
      applyStep(steps[s], true);
    }
  }

  function advance() {
    if (currentStep + 1 < steps.length) {
      currentStep += 1;
      applyStep(steps[currentStep], false);
    } else {
      // Already on the last step (or there were no steps at all): forward
      // is the parent's move now — change slide.
      post({ event: "advance-past-end" });
    }
  }

  function retreat() {
    if (currentStep >= 1) {
      currentStep -= 1;
      resetToStep(currentStep);
    } else {
      // Already on the slide's first step (or nothing applied yet): back
      // is the parent's move now — change page. Mirrors advance-past-end
      // at the far end.
      post({ event: "retreat-past-start" });
    }
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      advance();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      retreat();
      return;
    }
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

  // Cross-page retreat (settled decision #6): the parent tells this slide
  // which step to land on, and this replays there before anything else
  // happens — the same replay-forward mechanism as ArrowLeft, just seeded
  // from a different starting point. -1 (the default) means "just arrived
  // normally", so nothing is replayed.
  var startStep = (plan && typeof plan.startStep === "number" ? plan.startStep : -1);
  if (startStep >= 0) {
    currentStep = startStep;
    resetToStep(startStep);
  }

  // "ready" must stay the last message this runtime ever posts on boot,
  // and its shape must stay exactly `{ source: "comot-player", event:
  // "ready" }` — packages/web/test/canvas.test.ts:851 asserts on that
  // literal substring to prove the runtime was injected.
  post({ event: "ready" });
})();
