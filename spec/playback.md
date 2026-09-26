# `.slidra` Playback

**Applies to:** format version 5 ([`slidra-format.md`](slidra-format.md))
**Status:** Stable

This document specifies how a conforming player presents a deck: what is on screen when a slide opens, what one "advance" does, how each effect animates, and how slides change. The reference implementation is this repository's viewer (`public/js/player-runtime.js` for everything inside a slide, `lib/viewer/player.js` for page changes).

---

## 1. The model

- A deck plays slide by slide, in `project.json`'s `slides` order.
- Each slide has zero or more **steps** (format §6.3). *Advance* applies the next step; when none is left, it moves to the next slide. *Retreat* undoes the last applied step; when none is applied, it moves to the previous slide, landing on that slide's **last** step.
- A slide's position is `-1` (opening state, no step applied) through `steps − 1`.

A click on a linked element (format §4.8) follows the link and does not advance.

Players SHOULD map advance to → ↓ Space PageDown Enter, a click on the slide, and a leftward swipe; retreat to ← ↑ PageUp Backspace and a rightward swipe; Home/End to the first slide / the last slide's last step.

Players SHOULD also give the presenter these, as in other presentation software:

| Key | Action |
|---|---|
| B or . | Black out the audience surface; the next key or click restores it without moving. |
| W or , | The same with a white surface. |
| a slide number, then Enter | Go to that slide (clamped to the deck), arriving at its opening state. |
| ? | List the keys. |

While the surface is blanked, a number is being typed or the key list is open, the navigation keys act on that state instead of the slides: they restore the surface, finish or cancel the number, or close the list.

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
| `after-previous` | the previous effect's end (its start + its length) |

Each effect's own `delay` is added to that start. "Previous" is the effect immediately before it in the same step, whatever its family. An effect's **length** is its `duration`, times `repeat` for emphasis, plus `(units − 1) × stagger` for a text build (§3.5).

### 3.2 Keyframes

Every transform composes onto the element's existing transform (its container's `transform` attribute) — the effect moves the element *relative to where it is*, never to an absolute position. Scale and rotation happen about the element's local origin. Easing is the effect's `easing` (§3.2.1), `ease` unless stated.

| Family / effect | Keyframes | Holds final state |
|---|---|---|
| enter `appear`, `fade` | opacity 0 → 1 | — (ends visible) |
| enter `fly-up` | opacity 0 → 1, translateY(40px) → 0 | — |
| enter `fly-down` | opacity 0 → 1, translateY(−40px) → 0 | — |
| enter `fly-left` | opacity 0 → 1, translateX(40px) → 0 | — |
| enter `fly-right` | opacity 0 → 1, translateX(−40px) → 0 | — |
| enter `zoom` | opacity 0 → 1, scale(0.5) → 1 | — |
| emphasis `pulse` | scale 1 → 1.15 → 1 | — |
| emphasis `spin` | rotate 0 → 360deg | — |
| emphasis `grow` | scale 1 → 1.3 → 1 | — |
| exit `disappear`, `fade-out` | opacity 1 → 0 | yes (stays gone) |
| exit `fly-out-up` | opacity 1 → 0, translateY(0) → −40px | yes |
| exit `fly-out-down` | opacity 1 → 0, translateY(0) → 40px | yes |
| exit `fly-out-left` | opacity 1 → 0, translateX(0) → −40px | yes |
| exit `fly-out-right` | opacity 1 → 0, translateX(0) → 40px | yes |
| exit `zoom-out` | opacity 1 → 0, scale 1 → 0.5 | yes |
| path `path` | translate along `d`, relative to the path's first point, `linear` | yes (stays at the end) |

An `enter` effect un-hides its element in the same frame its animation starts (the pre-hide must not win over the entrance, and the element must not flash at full opacity first). While the effect waits out its start offset and `delay`, the element shows its first keyframe (opacity 0), not its resting state. `appear` uses the effect's `duration` like `fade`; set `duration="0"` for an instant appearance.

Players MAY implement the path by sampling (the reference player samples 20 points with `getPointAtLength`).

`repeat="n"` runs an emphasis effect's keyframes `n` times back to back.

#### 3.2.1 Easing

| `easing` | Timing function |
|---|---|
| `ease` | `cubic-bezier(0.25, 0.1, 0.25, 1)` |
| `linear` | `linear` |
| `ease-in` | `cubic-bezier(0.42, 0, 1, 1)` |
| `ease-out` | `cubic-bezier(0, 0, 0.58, 1)` |
| `ease-in-out` | `cubic-bezier(0.42, 0, 0.58, 1)` |
| `overshoot` | `cubic-bezier(0.34, 1.56, 0.64, 1)` (passes the end and settles back) |

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

### 3.5 Text builds

An `enter` or `exit` effect with `by` animates the target's text one unit at a time instead of the whole element:

- `letter`: every character other than white space; `word`: every run of non-white-space characters; `line`: every line — a `<text>` element, or within one, each `<tspan>` that starts a line (`data-slidra-break`, or its own `x`).
- Units are taken in document order across all `<text>` elements inside the target. Shapes inside the target that are not text take part as the whole element would without `by`: they appear with the first unit (enter) or go with the last (exit).
- Unit *k* (from 0) starts `k × stagger` seconds after the effect starts and fades its fill and stroke opacity over `duration` (0 → 1 for enter, 1 → 0 for exit, easing as §3.2.1). The effect's motion (a fly's translate, a zoom's scale) is not applied per unit.
- A target with no text builds as if `by` were absent.
- Splitting text into units MUST NOT move any glyph: the static slide and the finished build look identical.

### 3.6 Triggers

A trigger element (format §6.3) is interactive: activating it runs its next step, on its own clock, as §3.1 describes; once its steps are used up, activating it does nothing. A trigger does not advance the slide, and a trigger element SHOULD be reachable with Tab and look interactive, like a link. An element whose first effect is a triggered `enter` starts hidden like any other (§2).

Retreat (§3.4) resets triggered effects along with everything else: each trigger starts over from its first step, and the instant replay of steps `0 … target` never runs triggered effects.

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

### 5.1 Morph

`enter="morph"` animates the incoming slide's elements from where the outgoing slide showed them, instead of animating the surface. It plays on every arrival that leaves another slide on screen (forward, backward or a jump); with no slide on screen before it (the first slide shown), it plays as `fade`. When the incoming slide morphs, the outgoing slide's `exit` edge is skipped.

The player captures the outgoing slide **as it is on screen** when the move starts (its current step applied) and pairs element containers by `id`:

| Element | During the morph |
|---|---|
| On both slides, visible on both | Moves and scales from its box on the outgoing slide to its box on the incoming one (boxes in slide coordinates, including every ancestor's transform), and its opacity goes from the old value to the new. |
| Only on the incoming slide, or hidden on the outgoing one | Fades in (opacity 0 → its value). |
| Only on the outgoing slide, or pre-hidden on the incoming one | Stays drawn where it was and fades out (→ opacity 0), then is gone. |

- Only the outermost paired element of a nesting is animated; its descendants move with it.
- An element pre-hidden on the incoming slide (§2) keeps its opening state: the morph never reveals it.
- The slide background (`background-color` on the root) changes from the old color to the new one over the same time.
- Everything runs for the incoming slide's `enter-duration`, easing `ease-in-out`. Advancing or retreating while it runs finishes it at once first.
- The incoming slide's first paint already shows the morph's first frame; the player MUST NOT flash the incoming slide's resting state or an empty surface in between.

## 6. Speaker notes and chrome

Speaker notes (format §9) are shown to the presenter only — never on the audience surface. Comments (format §10) are never shown during playback.

## 7. Fonts

Every registered font (format §8) is made available to each slide under its `family` name before the slide is shown; a player SHOULD wait for the slide's fonts before revealing it.
