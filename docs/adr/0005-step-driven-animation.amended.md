# Animation uses `data-slidra-*` attributes with a custom runtime, not SMIL or CSS

> **⚠️ This ADR has been substantially revised; only one core sentence remains.** Two clauses are superseded:
> "motion data is expressed as element attributes" is replaced by **ADR-0009** (an ordered list of effects in the slide's `<metadata>` instead);
> "the runtime must not depend on the server" is replaced by **ADR-0007** (playback and editing are two modes of the same web app).
> Details are noted inline below, where each original clause appears.
>
> **What still stands**: animation is step-driven, no SMIL or CSS animation, no `<foreignObject>`, and audio/video is expressed as a visible placeholder element with `data-slidra-media`.

Presentation animation is **step-driven**: the user clicks, the next element appears, and how long they linger in between is up to them. Both SMIL and CSS animation are timeline-driven; expressing "wait for a user click" with either still requires JS to pause/seek them, which just stacks a distorted intermediary on top of a custom runtime anyway.

So motion data is expressed with custom attributes, driven by the app's own runtime:

```xml
<g id="el-a3f2c1" data-slidra-name="Title" data-slidra-step="1" data-slidra-enter="fade">
```

> **The attribute design has been superseded by ADR-0009.** Motion data is now written as an ordered list of effects living in the slide SVG's `<metadata>`, each pointing at an element; the step number is derived from that list rather than stored as a number on the element. What's revoked is only "motion data is expressed as element attributes" — "step-driven, no SMIL, no CSS animation" still holds, and that's the core of this ADR. Element identifiers, `data-slidra-name`, and the `data-slidra-media` attribute for audio/video are unaffected.

Audio and video use the same mechanism: a poster placeholder `<image>` with `data-slidra-media="assets/intro.mp4"`, swapped in by the runtime at playback time. `<foreignObject>` is avoided because most SVG viewers don't support it, which would leave a hole in the static view and violate ADR-0001.

## Consequences

- `data-*` is valid SVG, so a static view renders correctly in other tools — it just won't animate.
- The trade-off is that a `.slidra` won't animate outside the app. In exchange, the animation model maps cleanly onto how people already think about presentations, and an agent can read it at a glance and change one attribute to make an edit.
- The runtime must not depend on the server: it only needs to read the SVG and its attributes, and handle key presses and media. Keeping it this decoupled means a future `slidra export --html` is nearly free, and presenting live doesn't require installing the app on every machine.

> **The clause above has been superseded by ADR-0007.** The runtime can now depend on the server: playback and editing are two modes of the same web app, playing a `.slidra` requires the app to be installed, and sharing goes through export instead. The original reasoning is left in place to record the trade-off as it stood at the time. The rest of this ADR is unaffected.

## Revision: the runtime moved to driving animation with the Web Animations API

"No SMIL, no CSS animation" was originally implemented as plain CSS `transition` (direct assignment to `opacity`/`el.style`). This was later changed to drive playback with the **Web Animations API** (`el.animate(keyframes, options)`) instead, which still falls squarely within the letter of "no SMIL, no CSS `@keyframes`/`animation`" — WAAPI is an imperative API the runtime calls itself and controls the timing of; it is not a declarative timeline description, and it is a different thing from SMIL or CSS animation. The reasons for the switch:

- The four effect families (enter/emphasis/exit, plus path effects added later) are naturally described as "a set of keyframes." WAAPI is the browser's native, controllable (`cancel()`, `.finished`) support for exactly that shape; a plain CSS `transition` can only interpolate between two endpoints, which can't support an emphasis effect's back-and-forth keyframes or a path effect's multi-point sampling.
- Resetting to a step (`resetToStep`) uses `document.getAnimations().forEach(a => a.cancel())` to get back to a known-clean starting point, replacing the earlier approach of manually clearing `style.opacity`/`style.transition` — this is fully compatible with the existing guarantee that a reset is instantaneous; only the mechanism changed.
- Path animation (`family="path"`) samples a series of `transform: translate(dx,dy)` keyframes along an SVG path and hands them to `el.animate`, deliberately avoiding the CSS `offset-path`/`motion-path` properties: support for those varies across engines, and using them would create a second animation engine rather than extend this one.
- The hide rule (`renderHideStyle`) now emits one rule per id, and the runtime removes that rule before calling `el.animate` within the same synchronous task that reveals the element, to avoid an `!important` rule overriding WAAPI's opacity keyframes (`!important` outranks any animation-level style).

"No `<foreignObject>`," "audio/video expressed as a visible placeholder with `data-slidra-media`," and "step-driven" are all completely unaffected.
