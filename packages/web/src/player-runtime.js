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
  // -1 means "no step applied yet" — everything the plan marked hidden is
  // still hidden, which is the slide's opening state.
  var currentStep = -1;

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

  function applyStep(step) {
    var effects = step.effects;
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      // Media playback (family "media") is #30's ticket, not this one — a
      // media effect in the plan is simply not acted on yet. It stays
      // exactly as visible as its poster placeholder already is.
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
      el.style.opacity = "1";
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
