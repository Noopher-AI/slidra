# `.slidra` Playback

**Applies to:** format version 5 ([`slidra-format.md`](slidra-format.md))
**Status:** Stable

This document specifies how a conforming player presents a deck: what is on screen when a slide opens, what one "advance" does, how each effect animates, and how slides change. The reference implementation is this repository's viewer (`public/js/player-runtime.js` for everything inside a slide, `public/js/player.js` for page changes).

---

## 1. The model

- A deck plays slide by slide, in `project.json`'s `slides` order.
- Each slide has zero or more **steps** (format §6.3). *Advance* applies the next step; when none is left, it moves to the next slide. *Retreat* undoes the last applied step; when none is applied, it moves to the previous slide, landing on that slide's **last** step.
- A slide's position is `-1` (opening state, no step applied) through `steps − 1`.

Players SHOULD map advance to → ↓ Space PageDown Enter, a click on the slide, and a leftward swipe; retreat to ← ↑ PageUp Backspace and a rightward swipe; Home/End to the first slide / the last slide's last step.

## 2. Opening state

**A slide's static SVG is its final look with all effects run.** When a slide opens:

- Every element whose **first** effect in file order has `family="enter"` starts hidden (opacity 0). An element whose first effect is anything else — even if a later effect is `enter` — starts visible.
- Everything else is visible where the SVG puts it.
- Pre-hidden elements MUST be hidden before the first paint (no flash of the full slide).

Dynamic text (format §14) is substituted before rendering.

## 3. Effects

### 3.1 Scheduling within a step

A step's effects share one clock, in list order:

| `start` | The effect begins at … |
|---|---|
| `on-click` | 0 (it opens the step) |
| `with-previous` | the previous effect's start |
| `after-previous` | the previous effect's end (its start + its `duration`) |

Each effect's own `delay` is added to that start. "Previous" is the effect immediately before it in the same step, whatever its family.

### 3.2 Keyframes

Every transform composes onto the element's existing transform (its container's `transform` attribute) — the effect moves the element *relative to where it is*, never to an absolute position. Scale and rotation happen about the element's local origin. Easing is `ease` unless stated.

| Family / effect | Keyframes | Holds final state |
|---|---|---|
| enter `appear`, `fade` | opacity 0 → 1 | — (ends visible) |
| enter `fly-up` | opacity 0 → 1, translateY(40px) → 0 | — |
| enter `fly-left` | opacity 0 → 1, translateX(40px) → 0 | — |
| enter `zoom` | opacity 0 → 1, scale(0.5) → 1 | — |
| emphasis `pulse` | scale 1 → 1.15 → 1 | — |
| emphasis `spin` | rotate 0 → 360deg | — |
| emphasis `grow` | scale 1 → 1.3 → 1 | — |
| exit `disappear`, `fade-out` | opacity 1 → 0 | yes (stays gone) |
| exit `zoom-out` | opacity 1 → 0, scale 1 → 0.5 | yes |
| path `path` | translate along `d`, relative to the path's first point, `linear` | yes (stays at the end) |

An `enter` effect un-hides its element in the same frame its animation starts (the pre-hide must not win over the entrance, and the element must not flash at full opacity first). `appear` uses the effect's `duration` like `fade`; set `duration="0"` for an instant appearance.

Players MAY implement the path by sampling (the reference player samples 20 points with `getPointAtLength`).

### 3.3 Media

- `media` `play` starts the target's video/audio, shown over the target's placeholder box (letterboxed to fit). Playback MUST start synchronously from the user's input so that sound is allowed; a refused `play()` MUST be reported, not ignored.
- `media` `pause` pauses it. Pausing media that is not playing is an error to report.
- Reaching the same `play` again while it plays does not start a second copy.
- A video driven by a `play` effect SHOULD show its first frame (muted, not playing) from the moment the slide opens, rather than the bare placeholder.
- A media element with **no** media effect gets a play/pause control over its placeholder; the audience starts it.
- An embed (`data-slidra-embed`) is rendered by the player outside the slide's sandbox, aligned over the placeholder; `play`/`pause` effects drive it through the provider's player API.

### 3.4 Retreat

Retreat never inverts effects. It resets the slide to its opening state — cancelling every running or held animation, tearing down effect-driven media (posters return to their first frame), re-hiding pre-hidden elements — and then applies steps `0 … target` **instantly**: every effect with zero duration and delay, media effects skipped. Arriving at a slide backwards does the same with `target = steps − 1`.

Consequence, by design: crossing a media step backwards and then forwards again restarts that media from the beginning.

## 4. Corrupt slides

A slide whose effect list or transition is corrupt (format §6.4, §7) is shown statically — its SVG as-is, no pre-hiding, no steps — and the player reports why. It still participates in navigation (advance/retreat move straight to the neighbouring slide) and its transition is treated as `none`.

## 5. Page transitions

A transition animates the whole slide surface, not the elements inside it.

| Effect | Enter: from → rest | Exit: rest → to |
|---|---|---|
| `none` | instant | instant |
| `fade` | opacity 0 → 1 | opacity 1 → 0 |
| `slide` | opacity 0, translateX(8%) → rest | → opacity 0, translateX(−8%) |
| `zoom` | opacity 0, scale(1.06) → rest | → opacity 0, scale(0.94) |

- The **outgoing** slide plays its `exit` edge only on a **forward** move (to a higher-numbered slide). A backward move skips it.
- The **incoming** slide plays its `enter` edge on every arrival — forward, backward, or a jump — after its content is ready (fonts loaded), easing out.
- A second forward request while an exit is still playing is ignored, not queued.
- A duration of `0` means no animation.

## 6. Speaker notes and chrome

Speaker notes (format §9) are shown to the presenter only — never on the audience surface. Comments (format §10) are never shown during playback.

## 7. Fonts

Every registered font (format §8) is made available to each slide under its `family` name before the slide is shown; a player SHOULD wait for the slide's fonts before revealing it.
