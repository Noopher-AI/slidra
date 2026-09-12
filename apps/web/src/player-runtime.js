// Plain JavaScript, no imports, self-contained — inlined into the play
// `srcdoc`'s <script> by the parent (canvas.ts, via `?raw`). Runs inside a
// sandboxed iframe with `allow-scripts` and no `allow-same-origin`, so it
// has no way to reach anything outside itself except `postMessage`.
//
// Its whole job: read window.__SLIDRA_PLAN__ (injected by the parent before
// this script runs — see player-plan.ts / canvas.ts), listen for the
// forward arrow key, apply each step's effects to the DOM via the Web
// Animations API (ADR-0005: no SMIL, no CSS `animation`), and report what
// happened to the parent over postMessage (C4 in the design doc). It never
// derives anything itself — all derivation (parsing the effect list,
// grouping steps, computing which ids start hidden) happens in the parent,
// in player-plan.ts, where it can be unit tested without a browser.
//
// [E2.T7]/D7.5: this runtime does NOT feature-detect `el.animate` or
// `document.getAnimations` — every browser this project targets has both.
// A future environment that genuinely lacks them should fail loudly (a
// TypeError here), not silently degrade to doing nothing.
(function () {
  "use strict";

  var plan = window.__SLIDRA_PLAN__;
  var steps = (plan && plan.steps) || [];
  var media = (plan && plan.media) || {};
  var hideSelectors = (plan && plan.hideSelectors) || {};
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

  // [E2.T7]/D7: which of `plan.hidden`'s ids are STILL hidden right now —
  // starts as the full set, and loses one entry every time that target's
  // first `enter` effect runs (see unhideForEnter). Object.create(null) for
  // the same untrusted-id reason as mediaElements above; keys are used only
  // via `for...in` + `hasOwnProperty`, never bare property access on
  // anything resembling a prototype method name.
  var hiddenNow = Object.create(null);
  for (var hi = 0; hi < ((plan && plan.hidden) || []).length; hi++) {
    hiddenNow[plan.hidden[hi]] = true;
  }
  var hideStyleEl = document.getElementById("slidra-hide");

  function post(message) {
    // The parent document has an opaque origin from this frame's point of
    // view (this frame is itself opaque-origin, with no allow-same-origin),
    // so there is no meaningful target origin to name — "*" is correct
    // here, not a shortcut. The parent authenticates the sender by identity
    // (`event.source === iframe.contentWindow`), never by trusting origin.
    var payload = { source: "slidra-player" };
    for (var key in message) {
      if (Object.prototype.hasOwnProperty.call(message, key)) {
        payload[key] = message[key];
      }
    }
    parent.postMessage(payload, "*");
  }

  /**
   * Rewrites `<style id="slidra-hide">`'s content to exactly the ids still in
   * `hiddenNow` (D7): one `{opacity:0 !important}` rule per id, using the
   * already-escaped selector the parent computed (`plan.hideSelectors`) —
   * this runtime never re-implements CSS id escaping.
   */
  function rewriteHideStyle() {
    if (!hideStyleEl) return;
    var rules = "";
    for (var id in hiddenNow) {
      if (!Object.prototype.hasOwnProperty.call(hiddenNow, id)) continue;
      var selector = hideSelectors[id];
      if (!selector) continue;
      rules += selector + "{opacity:0 !important}";
    }
    hideStyleEl.textContent = rules;
  }

  /**
   * D7 step 2: removes `target` from the hide stylesheet and returns
   * synchronously — the caller must call `el.animate(...)` in the same
   * task, before any paint, or the element would flash at full opacity for
   * one frame before its entrance keyframes take over.
   */
  function unhideForEnter(target) {
    if (!hiddenNow[target]) return;
    delete hiddenNow[target];
    rewriteHideStyle();
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

  // ── Stage media in play mode ─────────────────────────────────────────
  // A video the author simply inserted carries no `family="media"` effect,
  // so `media` above — which is keyed by effect targets only — knows
  // nothing about it and playMedia() is never called for it. Before this,
  // play mode painted such a video as its bare SVG placeholder: nothing to
  // click, nothing that plays. `plan.stageMedia` (player-plan.ts) is the
  // same table view mode's stage layer already gets, and these overlays are
  // built once at boot, independently of the step machinery.
  var stageMedia = (plan && plan.stageMedia) || {};
  // id -> { media, button }. Object.create(null) for the same untrusted-id
  // reason as mediaElements above.
  var stageMediaElements = Object.create(null);

  /**
   * D2 holds here as it does in view mode: native `controls` is not used,
   * because `requestFullscreen()` is refused inside this sandbox and the
   * native bar's fullscreen button would be a dead one. Play mode gets a
   * single play/pause button rather than view mode's full bar with a seek
   * slider — an audience watches a video, it does not scrub one, and the
   * button is the whole of what "the video can be played" needs.
   */
  function createStageMedia(id, cue, placeholder) {
    var el = document.createElement(cue.kind === "video" ? "video" : "audio");
    // The raw data-slidra-media value, unmodified — same <base href>
    // contract as playMedia() below.
    el.src = cue.src;
    el.preload = "metadata";
    document.body.appendChild(el);

    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "\u25B6";
    button.setAttribute("data-slidra-stage-media-control", "play");
    button.style.position = "absolute";
    button.style.zIndex = "2";
    button.style.width = "48px";
    button.style.height = "48px";
    button.style.borderRadius = "50%";
    button.style.border = "none";
    button.style.cursor = "pointer";
    button.style.font = "20px/1 sans-serif";
    // CSS keywords + color-mix, not a hex/rgba literal: design-contract.test.ts
    // forbids literal colour values under apps/web/src, and this
    // runtime has no injected palette to read from the way
    // selection-runtime.js's `colors` gives it one.
    button.style.color = "white";
    button.style.background = "color-mix(in srgb, black 55%, transparent)";
    document.body.appendChild(button);

    button.addEventListener("click", function () {
      if (el.paused) {
        // Synchronous, no await before it — the click's own transient
        // activation is what allows playback with sound (same rule as
        // playMedia() below).
        var playResult = el.play();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch(function (err) {
            post({
              event: "error",
              message: "媒體播放失敗（" + id + "）：" + (err && err.message ? err.message : String(err)),
            });
          });
        }
      } else {
        el.pause();
      }
    });
    el.addEventListener("play", function () {
      button.textContent = "\u23F8";
    });
    el.addEventListener("pause", function () {
      button.textContent = "\u25B6";
    });
    // A 404/decode failure surfaces the same way every other runtime
    // failure does, rather than leaving a button that silently does
    // nothing.
    el.addEventListener("error", function () {
      post({ event: "error", message: "媒體載入失敗（" + id + "）：" + cue.src });
    });

    var overlay = { media: el, button: button, placeholder: placeholder };
    positionStageMedia(overlay);
    return overlay;
  }

  /** Aligns one stage overlay (and its button) to its placeholder's current on-screen box — called at boot and again on every resize, exactly like positionOverlay's own callers. */
  function positionStageMedia(overlay) {
    positionOverlay(overlay.media, overlay.placeholder);
    var rect = overlay.placeholder.getBoundingClientRect();
    var size = 48;
    overlay.button.style.left = rect.left + window.scrollX + (rect.width - size) / 2 + "px";
    overlay.button.style.top = rect.top + window.scrollY + (rect.height - size) / 2 + "px";
  }

  // ── Third-party embeds ───────────────────────────────────────────────
  // The <iframe> itself lives in the PARENT document (ADR-0011: this
  // document may never be granted allow-same-origin, and a nested iframe's
  // sandbox flags are the intersection with this one's, so the YouTube
  // player cannot be made to work from in here at all). All this runtime
  // does is measure where the placeholder currently sits and post it out,
  // so the parent can keep its overlay aligned.
  var embedIds = (plan && plan.embedIds) || [];

  /** Whether `target` is one of this slide's third-party embeds. A linear scan over `embedIds` (never a lookup keyed by an untrusted id, ADR-0010) — the list is one entry per embed on a slide, so its length is measured in single digits. */
  function isEmbedTarget(target) {
    for (var i = 0; i < embedIds.length; i++) {
      if (embedIds[i] === target) return true;
    }
    return false;
  }

  function reportEmbedBoxes() {
    if (embedIds.length === 0) return;
    var items = [];
    for (var i = 0; i < embedIds.length; i++) {
      var el = document.getElementById(embedIds[i]);
      if (!el) continue;
      var rect = el.getBoundingClientRect();
      items.push({ id: embedIds[i], rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } });
    }
    post({ event: "embed-boxes", items: items });
  }

  function buildStageMedia() {
    for (var id in stageMedia) {
      if (!Object.prototype.hasOwnProperty.call(stageMedia, id)) continue;
      // A target the effect list already drives stays the effect list's
      // business: playMedia() creates and plays it at its own step, and a
      // second element here would play alongside that one.
      if (Object.prototype.hasOwnProperty.call(media, id)) continue;
      var placeholder = document.getElementById(id);
      if (!placeholder) continue;
      stageMediaElements[id] = createStageMedia(id, stageMedia[id], placeholder);
    }
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
      // `play` media effect's target carries a cue before this plan was
      // built, so this should not happen — reported rather than silently
      // skipped, in case it ever does.
      post({ event: "error", message: "找不到媒體效果的設定：" + target });
      return;
    }
    var placeholder = document.getElementById(target);
    if (!placeholder) {
      post({ event: "error", message: "找不到媒體效果指向的元素：" + target });
      return;
    }

    var el = document.createElement(cue.kind === "video" ? "video" : "audio");
    // The raw data-slidra-media value, unmodified (settled decision #3): the
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

  /** `getComputedStyle(el).transform`'s resolved `matrix(...)` (or `""` for the identity transform) — the base every family's keyframes compose their own offset on top of, so an element's existing `transform="translate(x y)"` attribute (this project's own element-move convention) is never clobbered by a WAAPI keyframe's own `transform` value (CSS `transform` overrides the SVG presentation attribute entirely; it does not layer on top of it). */
  function baseTransform(el) {
    var computed = getComputedStyle(el).transform;
    return computed && computed !== "none" ? computed : "";
  }

  function composeTransform(base, fn) {
    return base ? base + " " + fn : fn;
  }

  /** Family/effect-name -> WAAPI keyframes (D4.4). `null` for a combination this function does not know how to animate (should not happen — core's `validateEffectItem` already rejected anything outside the fixed value set, 4.1). Never called for `family: "path"`, which has its own sampling-based builder (`animatePath`) — a straight-line keyframe list cannot express a curve. */
  function keyframesFor(el, effect) {
    var base = baseTransform(el);
    if (effect.family === "enter") {
      switch (effect.effect) {
        case "appear":
        case "fade":
          return [{ opacity: 0 }, { opacity: 1 }];
        case "fly-up":
          return [
            { opacity: 0, transform: composeTransform(base, "translateY(40px)") },
            { opacity: 1, transform: composeTransform(base, "translateY(0px)") },
          ];
        case "fly-left":
          return [
            { opacity: 0, transform: composeTransform(base, "translateX(40px)") },
            { opacity: 1, transform: composeTransform(base, "translateX(0px)") },
          ];
        case "zoom":
          return [
            { opacity: 0, transform: composeTransform(base, "scale(0.5)") },
            { opacity: 1, transform: composeTransform(base, "scale(1)") },
          ];
      }
      return null;
    }
    if (effect.family === "emphasis") {
      switch (effect.effect) {
        case "pulse":
          return [
            { transform: composeTransform(base, "scale(1)") },
            { transform: composeTransform(base, "scale(1.15)") },
            { transform: composeTransform(base, "scale(1)") },
          ];
        case "spin":
          return [
            { transform: composeTransform(base, "rotate(0deg)") },
            { transform: composeTransform(base, "rotate(360deg)") },
          ];
        case "grow":
          return [
            { transform: composeTransform(base, "scale(1)") },
            { transform: composeTransform(base, "scale(1.3)") },
            { transform: composeTransform(base, "scale(1)") },
          ];
      }
      return null;
    }
    if (effect.family === "exit") {
      switch (effect.effect) {
        case "disappear":
        case "fade-out":
          return [{ opacity: 1 }, { opacity: 0 }];
        case "zoom-out":
          return [
            { opacity: 1, transform: composeTransform(base, "scale(1)") },
            { opacity: 0, transform: composeTransform(base, "scale(0.5)") },
          ];
      }
      return null;
    }
    return null;
  }

  /**
   * `family: "path"` (D4.4, ADR-0005 amended): builds a detached `<path
   * d="...">` purely to sample it — `getTotalLength`/`getPointAtLength`
   * work on a node that is never inserted into the document — and turns
   * those samples into a `transform: translate(dx,dy)` keyframe list, one
   * sample per `1/SAMPLE_COUNT` of the path's length. Deliberately not
   * `offset-path`/`motion-path` CSS (D4.4): support differs enough across
   * engines that it would become a second animation mechanism, not a
   * shortcut. Every offset composes onto the element's existing transform
   * (`baseTransform`), same as every other family — the coordinate motion
   * is *relative to* wherever the element already sits, not absolute.
   */
  function animatePath(el, effect, duration, delay) {
    var d = effect.d;
    if (!d) {
      post({ event: "error", message: "路徑效果缺少 d：" + effect.target });
      return null;
    }
    var pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", d);

    var length;
    try {
      length = pathEl.getTotalLength();
    } catch (err) {
      post({
        event: "error",
        message: "路徑資料無法解析（" + effect.target + "）：" + (err && err.message ? err.message : String(err)),
      });
      return null;
    }
    if (!isFinite(length) || length <= 0) {
      post({ event: "error", message: "路徑效果的 d 長度為 0，無法建立動畫：" + effect.target });
      return null;
    }

    var SAMPLE_COUNT = 20;
    var start = pathEl.getPointAtLength(0);
    var base = baseTransform(el);
    var keyframes = [];
    for (var i = 0; i <= SAMPLE_COUNT; i++) {
      var point = pathEl.getPointAtLength((length * i) / SAMPLE_COUNT);
      var dx = point.x - start.x;
      var dy = point.y - start.y;
      keyframes.push({ transform: composeTransform(base, "translate(" + dx + "px, " + dy + "px)") });
    }
    return el.animate(keyframes, { duration: duration, delay: delay, fill: "forwards", easing: "linear" });
  }

  /**
   * Applies one effect (D4.4). Returns the `Animation` WAAPI handed back
   * (so `playEffectsAwaitable`, used only by Preview, can wait on
   * `.finished`), or `null` for a media effect or an effect this runtime
   * could not animate. `duringReplay` (settled decision #4, extended by
   * [E2.T7]): every family runs with `duration: 0`/`delay: 0` — a step's
   * final state applies instantly — and media is skipped entirely (a
   * replay never plays sound). `offsetSeconds` is the step-clock start
   * `scheduleStep` computed for this effect (with/after-previous); the
   * effect's own `delay` is added on top of it.
   */
  function applyEffect(effect, duringReplay, offsetSeconds) {
    if (effect.family === "media") {
      if (duringReplay) return null;
      // [E2.T17]: a third-party embed has no <video> in this document to
      // drive — the player lives in the parent's overlay and is spoken to
      // through its own API. The runtime forwards the intent and stops
      // there; it never learns what a YouTube player is.
      if (isEmbedTarget(effect.target)) {
        if (effect.effect === "play" || effect.effect === "pause") {
          post({ event: "embed-command", id: effect.target, command: effect.effect });
        }
        return null;
      }
      if (effect.effect === "play") {
        playMedia(effect.target);
        return null;
      }
      if (effect.effect === "pause") {
        var mediaEl = mediaElements[effect.target];
        if (mediaEl) {
          mediaEl.pause();
        } else {
          post({ event: "error", message: "找不到要暫停的媒體元素：" + effect.target });
        }
        return null;
      }
      return null;
    }

    var el = document.getElementById(effect.target);
    if (!el) {
      // The parent's parser (effects.ts) already verified every target
      // exists before this plan was ever built, so this should not happen.
      // Reported rather than silently skipped, in case it ever does — e.g.
      // a future bug in the parent's derivation.
      post({ event: "error", message: "找不到步驟中要顯示的元素：" + effect.target });
      return null;
    }

    if (effect.family === "enter") unhideForEnter(effect.target);

    var duration = duringReplay ? 0 : Math.round((effect.duration || 0) * 1000);
    var delay = duringReplay ? 0 : Math.round(((offsetSeconds || 0) + (effect.delay || 0)) * 1000);

    if (effect.family === "path") {
      return animatePath(el, effect, duration, delay);
    }

    var keyframes = keyframesFor(el, effect);
    if (!keyframes) return null;
    return el.animate(keyframes, {
      duration: duration,
      delay: delay,
      // exit's whole point is to stay gone; every other family's final
      // keyframe already composes back to the identity offset (D7/D4.4),
      // so nothing else needs its effect held once it finishes.
      fill: effect.family === "exit" ? "forwards" : "none",
      easing: "ease",
    });
  }

  /**
   * Applies one step's effects to the DOM, fire-and-forget (the normal
   * forward-advance / replay path — nothing here ever needs to know when
   * the animations finish). See `playEffectsAwaitable` for the one caller
   * that does (Preview).
   */
  /**
   * Schedules one step's effects on a shared clock (PPTX mental model):
   * `on-click` opens the step at 0, `with-previous` starts together with
   * the previous effect, `after-previous` starts once the previous effect
   * has ended (its start + duration). Each effect's own `delay` is added
   * on top of that start. Calls `fn(effect, offsetSeconds)` in file order.
   */
  function scheduleStep(effects, fn) {
    var prevStart = 0;
    var prevEnd = 0;
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      var base = effect.start === "after-previous" ? prevEnd : effect.start === "with-previous" ? prevStart : 0;
      fn(effect, base);
      var start = base + (effect.delay || 0);
      prevStart = start;
      prevEnd = start + (effect.duration || 0);
    }
  }

  function applyStep(step, duringReplay) {
    scheduleStep(step.effects, function (effect, offset) {
      applyEffect(effect, duringReplay, offset);
    });
  }

  /**
   * Resets the slide to its opening state, then replays steps 0..target
   * (inclusive) forward without animation and without playing media. This
   * is the retreat approach settled for #46: rather than inverting each
   * effect family ("un-fade", "un-play"), reuse the runtime's existing
   * forward-apply capability from a known-clean starting point, so any
   * effect family — including path/emphasis/exit, added by [E2.T7] —
   * retreats correctly for free. Passing target = -1 replays nothing,
   * landing back on the slide's untouched opening state.
   *
   * [E2.T7]: cancelling every live `Animation` up front is what makes "known
   * clean starting point" true for WAAPI the same way the old code's manual
   * inline-style clearing made it true for plain opacity/transition — an
   * `exit`/`path` effect's `fill: "forwards"` hold is exactly the kind of
   * lingering state a retreat must not carry across.
   *
   * Deliberate asymmetry (#46, do not "fix"): media is skipped during
   * replay (see applyEffect), so retreating past a media step and then
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
    hiddenNow = Object.create(null);
    for (var hi = 0; hi < ((plan && plan.hidden) || []).length; hi++) {
      hiddenNow[plan.hidden[hi]] = true;
    }
    rewriteHideStyle();

    var animations = document.getAnimations();
    for (var ai = 0; ai < animations.length; ai++) animations[ai].cancel();

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
    // Embeds are torn down the same way, just through the parent: they are
    // not this document's elements, so there is nothing here to remove —
    // only a "stop playing" to forward (same reason as applyEffect above).
    for (var i = 0; i < embedIds.length; i++) {
      post({ event: "embed-command", id: embedIds[i], command: "pause" });
    }

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

  // ---------------------------------------------------------------------
  // Preview ([E2.T7]/D8): plan.preview, set only by canvas.ts's
  // previewEffects(), never by computePlayerPlan. Plays either one card's
  // specific effect-list positions (`effectIndices`) or the whole slide's
  // steps in sequence (`null`), then posts exactly one `preview-done` and
  // goes quiet — the parent tears this iframe down on that signal.
  // ---------------------------------------------------------------------

  var PREVIEW_STEP_GAP_MS = 250;

  function waitFor(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** Runs every effect in `effects` (real timing, not a replay) and resolves once every one of them that produced a WAAPI `Animation` has finished — a rejected `.finished` (e.g. cancelled by a `resetToStep` racing this preview) is swallowed, never left unhandled. */
  function playEffectsAwaitable(effects) {
    var pending = [];
    scheduleStep(effects, function (effect, offset) {
      var result = applyEffect(effect, false, offset);
      if (result && result.finished && typeof result.finished.then === "function") {
        pending.push(
          result.finished.catch(function () {
            /* cancelled mid-preview — treat as settled, not an error */
          }),
        );
      }
    });
    return Promise.all(pending);
  }

  function runPreview(effectIndices) {
    function finishPreview() {
      post({ event: "preview-done" });
    }

    if (effectIndices) {
      var byIndex = Object.create(null);
      for (var s = 0; s < steps.length; s++) {
        var stepEffects = steps[s].effects;
        for (var e = 0; e < stepEffects.length; e++) {
          byIndex[stepEffects[e].index] = stepEffects[e];
        }
      }
      var selected = [];
      for (var i = 0; i < effectIndices.length; i++) {
        var effect = byIndex[effectIndices[i]];
        if (effect) selected.push(effect);
      }
      playEffectsAwaitable(selected).then(finishPreview, finishPreview);
      return;
    }

    var stepIndex = 0;
    function playNextStep() {
      if (stepIndex >= steps.length) {
        finishPreview();
        return;
      }
      var effects = steps[stepIndex].effects;
      stepIndex += 1;
      playEffectsAwaitable(effects).then(function () {
        if (stepIndex >= steps.length) {
          finishPreview();
        } else {
          waitFor(PREVIEW_STEP_GAP_MS).then(playNextStep);
        }
      }, finishPreview);
    }
    playNextStep();
  }

  document.addEventListener("keydown", function (event) {
    // [E2.T11]: Space/PageDown mirror ArrowRight (「前進一步」), PageUp
    // mirrors ArrowLeft (「後退一步」) — App.tsx's own keydown listeners
    // already forward these same keys when focus sits in the PARENT
    // document; this is the other half, for when focus is inside this
    // iframe (the common case right after entering play mode).
    if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
      event.preventDefault();
      advance();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      retreat();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // canvas.ts decides whether this actually leaves play mode — it may
      // instead be fullscreen's Esc (§4.5), which this runtime has no way
      // to know about.
      post({ event: "exit-play" });
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
    for (var stageTarget in stageMediaElements) {
      if (!Object.prototype.hasOwnProperty.call(stageMediaElements, stageTarget)) continue;
      positionStageMedia(stageMediaElements[stageTarget]);
    }
    reportEmbedBoxes();
  });

  window.addEventListener("focus", function () {
    post({ event: "focus", hasFocus: true });
  });
  window.addEventListener("blur", function () {
    post({ event: "focus", hasFocus: false });
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "slidra-host") return;
    if (data.command === "focus") {
      window.focus();
      return;
    }
    // #68: the parent forwards an arrow key when the browser focus has
    // landed outside this iframe, where this document's own keydown
    // listener never fires. Same advance()/retreat() the key press itself
    // would have called — the only difference is what the browser grants
    // us. postMessage does not carry the sender's transient activation
    // into a sandboxed, non-same-origin frame, so a media effect reached
    // this way gets its play() refused by the autoplay policy. That is
    // not silent: playMedia's catch above posts a visible error. The
    // parent calls focusPlayer() alongside the forward, so this only ever
    // applies to the first key press after focus was lost.
    if (data.command === "advance") {
      advance();
      return;
    }
    if (data.command === "retreat") {
      retreat();
    }
  });

  // Cross-page retreat (settled decision #6): the parent tells this slide
  // which step to land on, and this replays there before anything else
  // happens — the same replay-forward mechanism as ArrowLeft, just seeded
  // from a different starting point. -1 (the default) means "just arrived
  // normally", so nothing is replayed. Skipped entirely in Preview (D8):
  // Preview has no notion of "which step to land on", only "which effects
  // to play right now".
  var startStep = plan && typeof plan.startStep === "number" ? plan.startStep : -1;
  if (!(plan && plan.preview) && startStep >= 0) {
    currentStep = startStep;
    resetToStep(startStep);
  }

  // "ready" must stay the last message this runtime posts ON BOOT, and its
  // shape must stay exactly `{ source: "slidra-player", event: "ready" }` —
  // apps/web/test/canvas.test.ts:851 asserts on that literal substring
  // to prove the runtime was injected. Preview's own `preview-done` is a
  // later, separate message (D8) — it does not change this contract.
  buildStageMedia();
  reportEmbedBoxes();

  // #305: wait for this document's OWN fonts before saying ready. The
  // presentation's `@font-face` is injected into every play document, but
  // each one is an opaque origin (sandbox="allow-scripts", ADR-0010), so
  // the host awaiting `document.fonts.ready` on its own document only
  // warms the HTTP cache — it cannot know whether the face has been
  // applied *in here*. Saying ready before it is lets the PDF export print
  // a page whose text has fallen back to a system font (observed: pages
  // 2-5 rendered in STSongti while page 1 got the embedded face).
  // `fonts.ready` settles even when a face fails to load, so this delays
  // the message but can never withhold it; jsdom (which has no
  // `document.fonts`) takes the immediate path.
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
    document.fonts.ready.then(function () {
      post({ event: "ready" });
    });
  } else {
    post({ event: "ready" });
  }

  if (plan && plan.preview) {
    runPreview(plan.preview.effectIndices);
  }
})();
