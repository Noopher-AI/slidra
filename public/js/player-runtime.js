// The slide-side half of the player. Plain JavaScript, no imports,
// self-contained: the host (player.js) inlines this source into every play
// document's <script>, where it runs inside `<iframe sandbox="allow-scripts">`
// with no `allow-same-origin`, so it reaches nothing outside itself except
// through postMessage.
//
// Its whole job: read window.__SLIDRA_PLAN__ (written by the host just
// before this script), move through the plan's steps on key presses, clicks
// and swipes, apply each step's effects with the Web Animations API, and
// report to the host over postMessage. It derives nothing itself — parsing
// the effect list, grouping steps and deciding which ids start hidden all
// happen in the host (slide.js / effects.js). spec/playback.md is the
// normative description of what it does.
(function () {
  "use strict";

  var plan = window.__SLIDRA_PLAN__ || {};
  var steps = plan.steps || [];
  var media = plan.media || {};
  var hideSelectors = plan.hideSelectors || {};
  var hiddenAtOpen = plan.hidden || [];
  var stageMedia = plan.stageMedia || {};
  var embedIds = plan.embedIds || [];
  var linkIds = plan.linkIds || [];
  // A presenter view's copy of the slide plays every medium silently (playback §6.1).
  var muted = plan.muted === true;
  var triggers = plan.triggers || {};
  var triggerIds = plan.triggerIds || [];
  var has = Object.prototype.hasOwnProperty;

  // -1: no step applied yet — the slide's opening state.
  var currentStep = -1;

  // Every table keyed by an element id is Object.create(null): ids come
  // from untrusted slide markup, and a legal id can be "constructor" or
  // "__proto__", which a plain {} would already "contain".
  var mediaElements = Object.create(null); // effect target -> playing <video>/<audio>
  var stageMediaElements = Object.create(null); // id -> { media, button, placeholder }
  var hiddenNow = Object.create(null); // ids still hidden right now
  // Elements resetToStep() tore down on purpose; a play() promise of theirs
  // rejecting with AbortError is our own cancellation, not a failure.
  var tornDownMedia = new WeakSet();
  var hideStyleEl = document.getElementById("slidra-hide");

  function post(message) {
    // This frame has an opaque origin, so there is no meaningful target
    // origin to name; the host authenticates messages by
    // `event.source === iframe.contentWindow`.
    var payload = { source: "slidra-player" };
    for (var key in message) {
      if (has.call(message, key)) payload[key] = message[key];
    }
    parent.postMessage(payload, "*");
  }

  function errorMessage(err) {
    return err && err.message ? err.message : String(err);
  }

  // ── Pre-hidden targets ───────────────────────────────────────────────

  function resetHidden() {
    hiddenNow = Object.create(null);
    for (var i = 0; i < hiddenAtOpen.length; i++) hiddenNow[hiddenAtOpen[i]] = true;
    rewriteHideStyle();
  }

  /** Rewrites `<style id="slidra-hide">` to exactly the ids still hidden, using the selectors the host escaped. */
  function rewriteHideStyle() {
    if (!hideStyleEl) return;
    var rules = "";
    for (var id in hiddenNow) {
      if (!has.call(hiddenNow, id) || !has.call(hideSelectors, id)) continue;
      rules += hideSelectors[id] + "{opacity:0 !important}";
    }
    hideStyleEl.textContent = rules;
  }

  /**
   * Removes `target`'s hide rule. The caller must call `el.animate(...)` in
   * the same task: the `!important` rule would otherwise beat the entrance
   * keyframes, and removing it any earlier would flash the element at full
   * opacity for a frame.
   */
  function unhideForEnter(target) {
    if (!hiddenNow[target]) return;
    delete hiddenNow[target];
    rewriteHideStyle();
  }

  // ── Media ────────────────────────────────────────────────────────────

  /** Positions an overlay over its placeholder's current box, in document coordinates. */
  function positionOverlay(el, placeholder) {
    var rect = placeholder.getBoundingClientRect();
    el.style.position = "absolute";
    el.style.left = rect.left + window.scrollX + "px";
    el.style.top = rect.top + window.scrollY + "px";
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
    el.style.objectFit = "contain";
  }

  function positionStageMedia(overlay) {
    positionOverlay(overlay.media, overlay.placeholder);
    if (!overlay.button) return;
    var rect = overlay.placeholder.getBoundingClientRect();
    var size = 48;
    overlay.button.style.left = rect.left + window.scrollX + (rect.width - size) / 2 + "px";
    overlay.button.style.top = rect.top + window.scrollY + (rect.height - size) / 2 + "px";
  }

  /** The media bytes live on the placeholder's own (inlined) data-slidra-media; a plan-provided src wins when present. */
  function mediaSource(cue, placeholder) {
    return cue.src || placeholder.getAttribute("data-slidra-media") || "";
  }

  function reportPlayFailure(target, err) {
    post({ event: "error", message: "media playback failed (" + target + "): " + errorMessage(err) });
  }

  /**
   * A video or audio element with no media effect: the audience starts it
   * with a play/pause button over its placeholder. (Native `controls` are
   * not used: their fullscreen button is dead inside this sandbox.)
   */
  function createStageMedia(id, cue, placeholder) {
    var el = document.createElement(cue.kind === "video" ? "video" : "audio");
    el.src = mediaSource(cue, placeholder);
    el.preload = "metadata";
    el.muted = muted;
    el.setAttribute("playsinline", "");
    document.body.appendChild(el);

    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "▶";
    button.setAttribute("aria-label", "Play");
    button.setAttribute("data-slidra-stage-media-control", "play");
    var style = button.style;
    style.position = "absolute";
    style.zIndex = "2";
    style.width = style.height = "48px";
    style.borderRadius = "50%";
    style.border = "none";
    style.cursor = "pointer";
    style.font = "20px/1 sans-serif";
    style.color = "white";
    style.background = "rgba(0,0,0,.55)";
    document.body.appendChild(button);

    button.addEventListener("click", function () {
      if (el.paused) {
        // Synchronous from the click: its user activation is what lets
        // playback with sound start.
        var result = el.play();
        if (result && typeof result.catch === "function") {
          result.catch(function (err) {
            reportPlayFailure(id, err);
          });
        }
      } else {
        el.pause();
      }
    });
    el.addEventListener("play", function () {
      button.textContent = "⏸";
      button.setAttribute("aria-label", "Pause");
    });
    el.addEventListener("pause", function () {
      button.textContent = "▶";
      button.setAttribute("aria-label", "Play");
    });
    el.addEventListener("error", function () {
      post({ event: "error", message: "media failed to load (" + id + ")" });
    });

    var overlay = { media: el, button: button, placeholder: placeholder };
    positionStageMedia(overlay);
    return overlay;
  }

  /**
   * A video driven by a media effect shows its first frame from the start
   * (muted, never played by itself), so the audience does not stare at a
   * flat placeholder until the effect fires; playMedia() then reuses this
   * very element.
   */
  function createVideoPoster(cue, placeholder) {
    var el = document.createElement("video");
    el.src = mediaSource(cue, placeholder);
    el.preload = "metadata";
    el.muted = true;
    el.setAttribute("playsinline", "");
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    var overlay = { media: el, button: null, placeholder: placeholder };
    positionStageMedia(overlay);
    return overlay;
  }

  function buildStageMedia() {
    for (var id in stageMedia) {
      if (!has.call(stageMedia, id)) continue;
      var placeholder = document.getElementById(id);
      if (!placeholder) continue;
      if (has.call(media, id)) {
        if (stageMedia[id].kind === "video") stageMediaElements[id] = createVideoPoster(stageMedia[id], placeholder);
        continue;
      }
      stageMediaElements[id] = createStageMedia(id, stageMedia[id], placeholder);
    }
  }

  /**
   * Plays a media effect's target. `.play()` stays on the synchronous path
   * from the key press / click all the way down: the user activation is
   * good for the current task only, and anything async in between gets
   * playback with sound refused.
   */
  function playMedia(target) {
    if (mediaElements[target]) return; // reaching the same target twice never doubles it
    var cue = media[target];
    var placeholder = document.getElementById(target);
    if (!cue || !placeholder) {
      post({ event: "error", message: "media effect target not found: " + target });
      return;
    }

    var poster = stageMediaElements[target];
    var el = poster ? poster.media : document.createElement(cue.kind === "video" ? "video" : "audio");
    if (poster) {
      el.muted = muted;
      if (!el.isConnected) document.body.appendChild(el);
    } else {
      el.src = mediaSource(cue, placeholder);
      el.muted = muted;
      el.setAttribute("playsinline", "");
      document.body.appendChild(el);
    }
    positionOverlay(el, placeholder);
    mediaElements[target] = el;
    tornDownMedia.delete(el);

    var result = el.play();
    if (result && typeof result.catch === "function") {
      result.catch(function (err) {
        if (err && err.name === "AbortError" && tornDownMedia.has(el)) return;
        reportPlayFailure(target, err);
      });
    }
  }

  // ── Third-party embeds ───────────────────────────────────────────────
  // The embed's <iframe> lives in the HOST document (a player such as
  // YouTube's refuses to run inside this sandbox). This runtime only
  // measures the placeholders and forwards play/pause intents.

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

  // ── Effects ──────────────────────────────────────────────────────────

  /**
   * The element's current resolved transform, as the base every family's
   * keyframes compose onto — a CSS `transform` replaces the SVG
   * `transform` attribute outright, so an element's own translate() would
   * otherwise be lost for the animation's duration.
   */
  function baseTransform(el) {
    var computed = getComputedStyle(el).transform;
    return computed && computed !== "none" ? computed : "";
  }

  function compose(base, fn) {
    return base ? base + " " + fn : fn;
  }

  /** family/effect -> WAAPI keyframes (spec/playback.md §3). */
  function keyframesFor(el, effect) {
    var base = baseTransform(el);
    switch (effect.family + "/" + effect.effect) {
      case "enter/appear":
      case "enter/fade":
        return [{ opacity: 0 }, { opacity: 1 }];
      case "enter/fly-up":
        return [
          { opacity: 0, transform: compose(base, "translateY(40px)") },
          { opacity: 1, transform: compose(base, "translateY(0px)") },
        ];
      case "enter/fly-down":
        return [
          { opacity: 0, transform: compose(base, "translateY(-40px)") },
          { opacity: 1, transform: compose(base, "translateY(0px)") },
        ];
      case "enter/fly-left":
        return [
          { opacity: 0, transform: compose(base, "translateX(40px)") },
          { opacity: 1, transform: compose(base, "translateX(0px)") },
        ];
      case "enter/fly-right":
        return [
          { opacity: 0, transform: compose(base, "translateX(-40px)") },
          { opacity: 1, transform: compose(base, "translateX(0px)") },
        ];
      case "enter/zoom":
        return [
          { opacity: 0, transform: compose(base, "scale(0.5)") },
          { opacity: 1, transform: compose(base, "scale(1)") },
        ];
      case "emphasis/pulse":
        return [{ transform: compose(base, "scale(1)") }, { transform: compose(base, "scale(1.15)") }, { transform: compose(base, "scale(1)") }];
      case "emphasis/spin":
        return [{ transform: compose(base, "rotate(0deg)") }, { transform: compose(base, "rotate(360deg)") }];
      case "emphasis/grow":
        return [{ transform: compose(base, "scale(1)") }, { transform: compose(base, "scale(1.3)") }, { transform: compose(base, "scale(1)") }];
      case "exit/disappear":
      case "exit/fade-out":
        return [{ opacity: 1 }, { opacity: 0 }];
      case "exit/fly-out-up":
        return [
          { opacity: 1, transform: compose(base, "translateY(0px)") },
          { opacity: 0, transform: compose(base, "translateY(-40px)") },
        ];
      case "exit/fly-out-down":
        return [
          { opacity: 1, transform: compose(base, "translateY(0px)") },
          { opacity: 0, transform: compose(base, "translateY(40px)") },
        ];
      case "exit/fly-out-left":
        return [
          { opacity: 1, transform: compose(base, "translateX(0px)") },
          { opacity: 0, transform: compose(base, "translateX(-40px)") },
        ];
      case "exit/fly-out-right":
        return [
          { opacity: 1, transform: compose(base, "translateX(0px)") },
          { opacity: 0, transform: compose(base, "translateX(40px)") },
        ];
      case "exit/zoom-out":
        return [
          { opacity: 1, transform: compose(base, "scale(1)") },
          { opacity: 0, transform: compose(base, "scale(0.5)") },
        ];
    }
    return null;
  }

  /**
   * `family="path"`: samples the path with a detached <path> element and
   * turns the samples into translate() keyframes relative to the path's
   * first point, composed onto the element's own transform.
   */
  function animatePath(el, effect, duration, delay) {
    var pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", effect.d || "");
    var length;
    try {
      length = pathEl.getTotalLength();
    } catch (err) {
      post({ event: "error", message: "path data could not be parsed (" + effect.target + "): " + errorMessage(err) });
      return null;
    }
    if (!isFinite(length) || length <= 0) {
      post({ event: "error", message: "path effect has zero length: " + effect.target });
      return null;
    }
    var SAMPLES = 20;
    var start = pathEl.getPointAtLength(0);
    var base = baseTransform(el);
    var keyframes = [];
    for (var i = 0; i <= SAMPLES; i++) {
      var point = pathEl.getPointAtLength((length * i) / SAMPLES);
      keyframes.push({ transform: compose(base, "translate(" + (point.x - start.x) + "px, " + (point.y - start.y) + "px)") });
    }
    return el.animate(keyframes, { duration: duration, delay: delay, fill: "forwards", easing: easingFor(effect) });
  }

  /** spec/playback.md §3.2.1: the named curves; `ease` by default, `linear` for a path. */
  var EASINGS = {
    ease: "cubic-bezier(0.25, 0.1, 0.25, 1)",
    linear: "linear",
    "ease-in": "cubic-bezier(0.42, 0, 1, 1)",
    "ease-out": "cubic-bezier(0, 0, 0.58, 1)",
    "ease-in-out": "cubic-bezier(0.42, 0, 0.58, 1)",
    overshoot: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  };

  function easingFor(effect) {
    if (effect.easing && has.call(EASINGS, effect.easing)) return EASINGS[effect.easing];
    return effect.family === "path" ? "linear" : EASINGS.ease;
  }

  // ── Text builds (spec/playback.md §3.5) ──────────────────────────────

  var SVG_NS = "http://www.w3.org/2000/svg";
  var builds = Object.create(null); // target + "|" + by -> { units: [...], shapes: [...] }

  function isSvgElement(node, name) {
    return node && node.nodeType === 1 && node.namespaceURI === SVG_NS && node.localName === name;
  }

  function containsText(node) {
    return isSvgElement(node, "text") || (node.getElementsByTagNameNS && node.getElementsByTagNameNS(SVG_NS, "text").length > 0);
  }

  /** Wraps the non-white-space runs (word) or characters (letter) of every text node under `node` in bare <tspan>s, which move no glyph. */
  function splitText(node, by, units) {
    var children = [];
    for (var child = node.firstChild; child; child = child.nextSibling) children.push(child);
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.nodeType === 1) {
        splitText(c, by, units);
        continue;
      }
      if (c.nodeType !== 3 && c.nodeType !== 4) continue;
      var parts = by === "word" ? c.data.split(/(\s+)/) : Array.from(c.data);
      var fragment = document.createDocumentFragment();
      for (var p = 0; p < parts.length; p++) {
        if (parts[p] === "") continue;
        if (/^\s+$/.test(parts[p])) {
          fragment.appendChild(document.createTextNode(parts[p]));
          continue;
        }
        var span = document.createElementNS(SVG_NS, "tspan");
        span.textContent = parts[p];
        fragment.appendChild(span);
        units.push(span);
      }
      node.replaceChild(fragment, c);
    }
  }

  /** A <text>'s lines: runs of its children, each starting at a tspan with x or data-slidra-break, wrapped in one <tspan>. */
  function splitLines(text, units) {
    var groups = [];
    var current = [];
    for (var child = text.firstChild; child; child = child.nextSibling) {
      var startsLine = isSvgElement(child, "tspan") && (child.hasAttribute("x") || child.getAttribute("data-slidra-break") === "true");
      if (startsLine && current.length > 0) {
        groups.push(current);
        current = [];
      }
      current.push(child);
    }
    if (current.length > 0) groups.push(current);
    if (groups.length <= 1) {
      units.push(text);
      return;
    }
    for (var g = 0; g < groups.length; g++) {
      var wrapper = document.createElementNS(SVG_NS, "tspan");
      text.insertBefore(wrapper, groups[g][0]);
      for (var n = 0; n < groups[g].length; n++) wrapper.appendChild(groups[g][n]);
      units.push(wrapper);
    }
  }

  /** The units and the non-text shapes of `target` for a build by `by`, split once and cached. */
  function buildFor(target, by) {
    var key = target + "|" + by;
    if (builds[key]) return builds[key];
    var el = document.getElementById(target);
    var build = { units: [], shapes: [] };
    if (el) {
      var visit = function (node) {
        for (var child = node.firstChild; child; child = child.nextSibling) {
          if (child.nodeType !== 1) continue;
          if (isSvgElement(child, "text")) {
            if (by === "line") splitLines(child, build.units);
            else splitText(child, by, build.units);
          } else if (containsText(child)) {
            visit(child);
          } else if (!isSvgElement(child, "title") && !isSvgElement(child, "desc") && !isSvgElement(child, "metadata")) {
            build.shapes.push(child);
          }
        }
      };
      visit(el);
    }
    builds[key] = build;
    return build;
  }

  function prepareBuilds() {
    var all = steps.slice();
    for (var t = 0; t < triggerIds.length; t++) all = all.concat(triggers[triggerIds[t]] || []);
    for (var s = 0; s < all.length; s++) {
      for (var e = 0; e < all[s].effects.length; e++) {
        var effect = all[s].effects[e];
        if (effect.by) buildFor(effect.target, effect.by);
      }
    }
  }

  function unitCount(effect) {
    return effect.by ? buildFor(effect.target, effect.by).units.length : 0;
  }

  /** An effect's length on the step clock (spec/playback.md §3.1). */
  function lengthOf(effect) {
    var length = (effect.duration || 0) * (effect.repeat || 1);
    var units = unitCount(effect);
    if (units > 1) length += (units - 1) * (effect.stagger || 0);
    return length;
  }

  /** Fades every unit (and, with the first or last unit, the shapes) of a build. */
  function animateBuild(effect, build, duration, delay, stagger) {
    var enter = effect.family === "enter";
    var frames = enter
      ? [
          { fillOpacity: 0, strokeOpacity: 0 },
          { fillOpacity: 1, strokeOpacity: 1 },
        ]
      : [
          { fillOpacity: 1, strokeOpacity: 1 },
          { fillOpacity: 0, strokeOpacity: 0 },
        ];
    var options = function (offset) {
      return { duration: duration, delay: delay + offset, fill: enter ? "backwards" : "forwards", easing: easingFor(effect) };
    };
    for (var u = 0; u < build.units.length; u++) build.units[u].animate(frames, options(u * stagger));
    var shapeOffset = enter ? 0 : (build.units.length - 1) * stagger;
    var shapeFrames = enter ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
    for (var sh = 0; sh < build.shapes.length; sh++) build.shapes[sh].animate(shapeFrames, options(shapeOffset));
  }

  /**
   * Applies one effect. During a replay every effect runs with zero
   * duration and delay (the step's final state, instantly) and media is
   * skipped — a replay never plays sound. `offsetSeconds` is the effect's
   * start on the step clock (see scheduleStep); its own delay adds to it.
   */
  function applyEffect(effect, duringReplay, offsetSeconds) {
    if (effect.family === "media") {
      if (duringReplay) return null;
      if (isEmbedTarget(effect.target)) {
        post({ event: "embed-command", id: effect.target, command: effect.effect });
        return null;
      }
      if (effect.effect === "play") {
        playMedia(effect.target);
      } else if (effect.effect === "pause") {
        var mediaEl = mediaElements[effect.target];
        if (mediaEl) mediaEl.pause();
        else post({ event: "error", message: "no playing media to pause: " + effect.target });
      }
      return null;
    }

    var el = document.getElementById(effect.target);
    if (!el) {
      post({ event: "error", message: "effect target not found: " + effect.target });
      return null;
    }
    if (effect.family === "enter") unhideForEnter(effect.target);

    var duration = duringReplay ? 0 : Math.round((effect.duration || 0) * 1000);
    var delay = duringReplay ? 0 : Math.round(((offsetSeconds || 0) + (effect.delay || 0)) * 1000);
    if (effect.family === "path") return animatePath(el, effect, duration, delay);

    if (effect.by) {
      var build = buildFor(effect.target, effect.by);
      if (build.units.length > 0) {
        animateBuild(effect, build, duration, delay, duringReplay ? 0 : Math.round((effect.stagger || 0) * 1000));
        return null;
      }
    }

    var keyframes = keyframesFor(el, effect);
    if (!keyframes) return null;
    return el.animate(keyframes, {
      duration: duration,
      delay: delay,
      iterations: effect.repeat || 1,
      // An exit must stay gone; an entrance shows its first keyframe while
      // it waits out its delay (its pre-hide rule is already gone, so without
      // a backwards fill it would sit at full opacity until it starts).
      fill: effect.family === "exit" ? "forwards" : effect.family === "enter" ? "backwards" : "none",
      easing: easingFor(effect),
    });
  }

  /**
   * One step's shared clock: `on-click` opens the step at 0,
   * `with-previous` starts with the previous effect, `after-previous` once
   * the previous effect has ended (its start + duration). Each effect's own
   * delay adds on top.
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
      prevEnd = start + lengthOf(effect);
    }
  }

  function applyStep(step, duringReplay) {
    scheduleStep(step.effects, function (effect, offset) {
      applyEffect(effect, duringReplay, offset);
    });
  }

  /**
   * Going back never inverts effects: the slide is reset to its opening
   * state (animations cancelled, media torn down, hidden targets hidden
   * again) and steps 0..target are replayed instantly. Any family retreats
   * correctly this way. A media step crossed backwards therefore restarts
   * from the beginning when reached again, rather than resuming.
   */
  // ── Morph (spec/playback.md §5.1) ────────────────────────────────────
  // The outgoing slide reports what it shows (snapshot); the incoming slide
  // starts from that picture: paired elements are moved back to their old
  // boxes and animated home, new ones fade in, and ghosts of the departed
  // ones (built by the host) fade out.

  var MORPH_EASING = "cubic-bezier(0.42, 0, 0.58, 1)";
  var morphAnimations = [];
  var morphLayer = null;

  function slideRoot() {
    return document.querySelector("body > svg");
  }

  function isContainer(el) {
    return el && el.nodeType === 1 && el.localName === "g" && /^el-/.test(el.getAttribute("id") || "");
  }

  /** The transform from `el`'s user space to the slide root's. */
  function matrixToRoot(el, root) {
    var rootCtm = root.getScreenCTM();
    var ctm = el === root ? rootCtm : el.getScreenCTM();
    if (!rootCtm || !ctm) return new DOMMatrix();
    return DOMMatrix.fromMatrix(rootCtm).inverse().multiply(DOMMatrix.fromMatrix(ctm));
  }

  /** `el`'s bounding box in slide-root coordinates. */
  function boxInRoot(el, root) {
    var b;
    try {
      b = el.getBBox();
    } catch (err) {
      return null;
    }
    var m = matrixToRoot(el, root);
    var xs = [];
    var ys = [];
    var corners = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height],
    ];
    for (var i = 0; i < corners.length; i++) {
      var p = new DOMPoint(corners[i][0], corners[i][1]).matrixTransform(m);
      xs.push(p.x);
      ys.push(p.y);
    }
    var x = Math.min.apply(null, xs);
    var y = Math.min.apply(null, ys);
    return { x: x, y: y, width: Math.max.apply(null, xs) - x, height: Math.max.apply(null, ys) - y };
  }

  /** `el`'s opacity as drawn: its own times every ancestor's; 0 when it or an ancestor is not displayed. */
  function effectiveOpacity(el, root) {
    var opacity = 1;
    for (var node = el; node && node !== root.parentNode; node = node.parentNode) {
      var style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return 0;
      opacity *= Number(style.opacity);
    }
    return opacity;
  }

  function snapshot() {
    var root = slideRoot();
    var elements = Object.create(null);
    if (!root) return { elements: elements, background: null };
    var all = root.querySelectorAll("g[id]");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!isContainer(el)) continue;
      var opacity = effectiveOpacity(el, root);
      var box = boxInRoot(el, root);
      if (opacity <= 0.001 || !box) continue;
      var m = matrixToRoot(el, root);
      elements[el.getAttribute("id")] = { box: box, matrix: [m.a, m.b, m.c, m.d, m.e, m.f], opacity: opacity };
    }
    return { elements: elements, background: getComputedStyle(root).backgroundColor || null };
  }

  function hasAncestorWhere(el, root, test) {
    for (var node = el.parentNode; node && node !== root; node = node.parentNode) {
      if (isContainer(node) && test(node.getAttribute("id"))) return true;
    }
    return false;
  }

  function track(animation) {
    morphAnimations.push(animation);
    return animation;
  }

  function startMorph(morph) {
    var root = slideRoot();
    if (!root) return;
    var duration = Math.round((morph.duration || 0) * 1000);
    var options = { duration: duration, easing: MORPH_EASING, fill: "backwards" };
    var from = morph.from || {};
    var paired = Object.create(null);
    for (var fromId in from) {
      if (!has.call(from, fromId)) continue;
      var candidate = document.getElementById(fromId);
      if (candidate && isContainer(candidate) && !hiddenNow[fromId]) paired[fromId] = true;
    }

    // Paired: from the old box to the new, outermost first (descendants ride along).
    for (var id in paired) {
      var el = document.getElementById(id);
      if (
        hasAncestorWhere(el, root, function (a) {
          return !!paired[a];
        })
      )
        continue;
      var now = boxInRoot(el, root);
      var then = from[id].box;
      if (!now) continue;
      var sx = now.width > 0.01 ? then.width / now.width : 1;
      var sy = now.height > 0.01 ? then.height / now.height : 1;
      var shift = new DOMMatrix().translate(then.x, then.y).scale(sx, sy).translate(-now.x, -now.y);
      var parent = el.parentNode === root ? new DOMMatrix() : matrixToRoot(el.parentNode, root);
      var start = parent.inverse().multiply(shift).multiply(matrixToRoot(el, root));
      var own = Number(getComputedStyle(el).opacity);
      var drawn = effectiveOpacity(el, root);
      var ancestors = own > 0 ? drawn / own : 0;
      var startOpacity = ancestors > 0 ? Math.min(1, from[id].opacity / ancestors) : own;
      var base = baseTransform(el) || "none";
      track(
        el.animate(
          [
            { transform: start.toString(), opacity: startOpacity },
            { transform: base, opacity: own },
          ],
          options,
        ),
      );
    }

    // New on this slide: fade in, outermost first; a container that holds a paired element is walked into instead.
    var all = root.querySelectorAll("g[id]");
    var faded = Object.create(null);
    for (var i = 0; i < all.length; i++) {
      var item = all[i];
      var itemId = item.getAttribute("id");
      if (!isContainer(item) || paired[itemId] || hiddenNow[itemId]) continue;
      if (
        hasAncestorWhere(item, root, function (a) {
          return !!paired[a] || !!faded[a];
        })
      )
        continue;
      var holdsPaired = false;
      for (var p in paired) {
        if (has.call(paired, p) && item.contains(document.getElementById(p))) holdsPaired = true;
      }
      if (holdsPaired) continue;
      faded[itemId] = true;
      track(item.animate([{ opacity: 0 }, { opacity: Number(getComputedStyle(item).opacity) }], options));
    }

    // Departed: the host's ghosts, drawn where they were, fading out on top.
    if (morph.ghosts) {
      var parsed = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + morph.ghosts + "</svg>", "image/svg+xml");
      if (!parsed.getElementsByTagName("parsererror").length) {
        morphLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        morphLayer.setAttribute("data-slidra-ghosts", "");
        morphLayer.setAttribute("aria-hidden", "true");
        morphLayer.style.pointerEvents = "none";
        var source = parsed.documentElement;
        while (source.firstChild) {
          morphLayer.appendChild(document.importNode(source.firstChild, true));
          source.removeChild(source.firstChild);
        }
        root.appendChild(morphLayer);
        var ghosts = morphLayer.children;
        for (var g = 0; g < ghosts.length; g++) {
          track(ghosts[g].animate([{ opacity: Number(ghosts[g].getAttribute("opacity") || 1) }, { opacity: 0 }], { duration: duration, easing: MORPH_EASING, fill: "forwards" }));
        }
      }
    }

    if (morph.background) {
      track(root.animate([{ backgroundColor: morph.background }, { backgroundColor: getComputedStyle(root).backgroundColor }], { duration: duration, easing: MORPH_EASING }));
    }

    var cleanup = setTimeout(finishMorph, duration + 50);
    morphAnimations.cleanup = cleanup;
  }

  /** Ends a running morph at once (advancing or retreating does this first) and drops the ghosts. */
  function finishMorph() {
    if (morphAnimations.cleanup) clearTimeout(morphAnimations.cleanup);
    var running = morphAnimations;
    morphAnimations = [];
    for (var i = 0; i < running.length; i++) {
      try {
        running[i].finish();
      } catch (err) {
        running[i].cancel();
      }
      running[i].cancel();
    }
    if (morphLayer && morphLayer.parentNode) morphLayer.parentNode.removeChild(morphLayer);
    morphLayer = null;
  }

  function releaseMorphHold() {
    var hold = document.getElementById("slidra-morph-hold");
    if (hold && hold.parentNode) hold.parentNode.removeChild(hold);
  }

  function resetToStep(target) {
    resetHidden();
    var animations = document.getAnimations();
    for (var a = 0; a < animations.length; a++) animations[a].cancel();

    for (var id in mediaElements) {
      if (!has.call(mediaElements, id)) continue;
      var mediaEl = mediaElements[id];
      tornDownMedia.add(mediaEl);
      mediaEl.pause();
      var poster = stageMediaElements[id];
      if (poster && poster.media === mediaEl) {
        // A poster goes back to its resting state rather than away, so the
        // flat placeholder never shows through.
        mediaEl.currentTime = 0;
        mediaEl.muted = true;
        positionStageMedia(poster);
      } else if (mediaEl.parentNode) {
        mediaEl.parentNode.removeChild(mediaEl);
      }
    }
    mediaElements = Object.create(null);
    for (var e = 0; e < embedIds.length; e++) post({ event: "embed-command", id: embedIds[e], command: "pause" });
    resetTriggers();

    for (var s = 0; s <= target; s++) applyStep(steps[s], true);
  }

  function advance() {
    finishMorph();
    if (currentStep + 1 < steps.length) {
      currentStep += 1;
      applyStep(steps[currentStep], false);
      post({ event: "step", step: currentStep, total: steps.length });
    } else {
      post({ event: "advance-past-end" });
    }
  }

  function retreat() {
    finishMorph();
    if (currentStep >= 0) {
      currentStep -= 1;
      resetToStep(currentStep);
      post({ event: "step", step: currentStep, total: steps.length });
    } else {
      post({ event: "retreat-past-start" });
    }
  }

  // ── Links (spec §4.8) ────────────────────────────────────────────────
  // The host parsed and vetted every link; this side only knows which
  // element ids are linked and reports an activation by id.

  var linked = Object.create(null);

  // ── Triggers (spec/playback.md §3.6) ─────────────────────────────────

  var triggerPosition = Object.create(null); // trigger id -> last step run (-1: none)

  function resetTriggers() {
    for (var i = 0; i < triggerIds.length; i++) triggerPosition[triggerIds[i]] = -1;
  }

  function setUpTriggers() {
    resetTriggers();
    for (var i = 0; i < triggerIds.length; i++) {
      var el = document.getElementById(triggerIds[i]);
      if (!el) continue;
      el.setAttribute("tabindex", "0");
      if (!el.getAttribute("role")) el.setAttribute("role", "button");
      el.style.cursor = "pointer";
    }
  }

  /** The trigger element containing `node`, if any. */
  function triggerFor(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentNode) {
      var id = el.getAttribute("id");
      if (id && has.call(triggerPosition, id)) return id;
    }
    return null;
  }

  function runTrigger(id) {
    var list = triggers[id] || [];
    var next = triggerPosition[id] + 1;
    if (next >= list.length) return;
    triggerPosition[id] = next;
    applyStep(list[next], false);
  }

  function setUpLinks() {
    for (var i = 0; i < linkIds.length; i++) {
      var el = document.getElementById(linkIds[i]);
      if (!el) continue;
      linked[linkIds[i]] = true;
      el.setAttribute("tabindex", "0");
      if (el.getAttribute("role") !== "img") el.setAttribute("role", "link");
      el.style.cursor = "pointer";
    }
    if (linkIds.length > 0) {
      var style = document.createElement("style");
      style.textContent = "[data-slidra-link]:focus{outline:none}[data-slidra-link]:focus-visible{outline:3px solid #2f6fed;outline-offset:4px}";
      document.head.appendChild(style);
    }
  }

  /** The linked element containing `node`, if any. */
  function linkFor(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentNode) {
      var id = el.getAttribute("id");
      if (id && linked[id]) return id;
    }
    return null;
  }

  function followLink(id) {
    post({ event: "link", id: id });
  }

  // ── Input ────────────────────────────────────────────────────────────

  // While the host holds the keys (a blanked screen, a slide number being
  // typed, the key list), every key goes to the host instead of the slide.
  var keysHeld = false;

  document.addEventListener("keydown", function (event) {
    if (keysHeld && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      post({ event: "key", key: event.key });
      return;
    }
    if (event.key === "Enter" && document.activeElement) {
      var focusedLink = linkFor(document.activeElement);
      if (focusedLink) {
        event.preventDefault();
        followLink(focusedLink);
        return;
      }
      var focusedTrigger = triggerFor(document.activeElement);
      if (focusedTrigger) {
        event.preventDefault();
        runTrigger(focusedTrigger);
        return;
      }
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === " " || event.key === "PageDown" || event.key === "Enter") {
      event.preventDefault();
      advance();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Backspace") {
      event.preventDefault();
      retreat();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      post({ event: "exit-play" });
      return;
    }
    // Every other shortcut (Home/End, F, G, N, …) belongs to the host;
    // focus usually sits in this frame, so forward it.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length <= 8) {
      // A slide number, a blackout or the key list makes the host take the
      // keys; hold them at once, so an Enter typed right after a digit
      // cannot reach the slide before the host's hold-keys message does.
      // The host answers every forwarded key with the state it is really in.
      if (/^[0-9.,?bBwW]$/.test(event.key)) keysHeld = true;
      post({ event: "key", key: event.key });
    }
  });

  // A click anywhere on the slide advances, like a presenter's clicker —
  // except on this runtime's own controls and media. The click is a real
  // user activation inside this frame, which is what lets a media effect
  // reached by clicking play with sound.
  var suppressClick = false;
  document.addEventListener("click", function (event) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    var target = event.target;
    var link = linkFor(target);
    if (link) {
      followLink(link);
      return;
    }
    var trigger = triggerFor(target);
    if (trigger) {
      runTrigger(trigger);
      return;
    }
    if (target && target.closest && target.closest("button, video, audio, a")) return;
    advance();
  });

  var touchStartX = null;
  var touchStartY = 0;
  document.addEventListener(
    "touchstart",
    function (event) {
      if (event.touches.length !== 1) {
        touchStartX = null;
        return;
      }
      touchStartX = event.touches[0].clientX;
      touchStartY = event.touches[0].clientY;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchend",
    function (event) {
      if (touchStartX === null || event.changedTouches.length === 0) return;
      var dx = event.changedTouches[0].clientX - touchStartX;
      var dy = event.changedTouches[0].clientY - touchStartY;
      touchStartX = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      suppressClick = true;
      setTimeout(function () {
        suppressClick = false;
      }, 400);
      if (dx < 0) advance();
      else retreat();
    },
    { passive: true },
  );

  // Pointer movement is reported (throttled) so the host can reveal its
  // auto-hiding controls, and knows where to magnify (playback §1: Z), as a
  // fraction of the slide.
  var lastPointerReport = 0;
  document.addEventListener("mousemove", function (event) {
    var now = Date.now();
    if (now - lastPointerReport < 100) return;
    lastPointerReport = now;
    post({ event: "pointer", x: event.clientX / Math.max(1, window.innerWidth), y: event.clientY / Math.max(1, window.innerHeight) });
  });

  window.addEventListener("resize", function () {
    for (var target in mediaElements) {
      if (!has.call(mediaElements, target)) continue;
      var placeholder = document.getElementById(target);
      if (placeholder) positionOverlay(mediaElements[target], placeholder);
    }
    for (var id in stageMediaElements) {
      if (has.call(stageMediaElements, id)) positionStageMedia(stageMediaElements[id]);
    }
    reportEmbedBoxes();
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "slidra-host" || event.source !== parent) return;
    if (data.command === "focus") window.focus();
    else if (data.command === "advance") advance();
    else if (data.command === "retreat") retreat();
    else if (data.command === "hold-keys") keysHeld = data.hold === true;
    else if (data.command === "snapshot") {
      var shot = snapshot();
      post({ event: "snapshot", requestId: data.requestId, elements: shot.elements, background: shot.background });
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────

  resetHidden();
  buildStageMedia();
  setUpLinks();
  setUpTriggers();
  prepareBuilds();

  // Arriving backwards lands on the slide's last step: replay up to it.
  var startStep = typeof plan.startStep === "number" ? plan.startStep : -1;
  if (startStep >= 0 && startStep < steps.length) {
    currentStep = startStep;
    resetToStep(startStep);
  }
  reportEmbedBoxes();

  function ready() {
    // A morph measures text, so it starts once the fonts apply; the hold
    // style kept the slide undrawn until its first frame is the morph's.
    if (plan.morph) {
      try {
        startMorph(plan.morph);
      } catch (err) {
        finishMorph();
        post({ event: "error", message: "morph transition failed: " + errorMessage(err) });
      }
    }
    releaseMorphHold();
    post({ event: "ready", step: currentStep, total: steps.length });
  }
  // Wait for this document's own fonts: each play document is its own
  // opaque origin, so only it can know when its embedded faces apply.
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
    document.fonts.ready.then(ready, ready);
  } else {
    ready();
  }
})();
