# View mode also gets `allow-scripts`, so the author can click elements

> **Revised**: the reason the first Considered Option below was originally rejected — "can't be computed accurately: `transform`, text layout, and filter bleed all throw the box off" — no longer holds. The runtime (`selection-runtime.js`) now additionally reports each selected element's precise bounding box and ancestor chain via `getBoundingClientRect()` (a `bounds` event); the parent document uses this to draw name/group/drill-down-path labels and snapping guides, instead of computing boxes from the SVG itself. **Everything else below still stands as originally written**: `sandbox="allow-scripts"`, **`allow-same-origin` is never added**, the selection box, corner handles, and marquee-select rectangle are still drawn inside the iframe's Shadow DOM (the clause below, "the selection box must be drawn in the Shadow DOM," now narrows to just the selection box itself — not the labels/guides), the server's `Origin: null` rejection is unchanged, and overview thumbnails remain zero-token.

The author needs to be able to click an element on the canvas to select it. View mode's iframe is a zero-token sandbox (ADR-0010), so the parent document **can't receive any click that happens inside it** — no script, no `allow-same-origin`, events don't bubble out, and the DOM can't be read either. This isn't hard to do — it's flatly impossible as things stand.

Decision: **view mode moves to `sandbox="allow-scripts"`**, with a small script injected alongside `srcdoc` whose only job is to report which element was clicked, and to draw a selection box around it. The selected identifier is reported back to the parent document via `postMessage`. **`allow-same-origin` is never added** — identical to play mode's posture — the security model hasn't relaxed at all; it's just extending the stance play mode already used to view mode as well.

**Overview thumbnails stay at zero-token.** The thumbnail iframe has `pointer-events: none`; clicks land on the outer `.overview-thumb` button, which the parent document already receives directly. This hole is only opened on the main canvas.

## Considered Options

- **Overlay a hit-testing layer in the parent document**: the parent document would parse the SVG itself, compute each element's box, and overlay a transparent hit layer above the iframe. Wouldn't require touching ADR-0010 at all. Rejected because the boxes can't be computed accurately — `transform`, actual text layout, and filter bleed all throw the box off, and a selection box that never quite lines up with the content is exactly the wrong result for the one thing this feature exists to do.
- **Don't click the canvas at all — use an element-list panel instead** (listing that page's elements by display name). Also wouldn't touch ADR-0010, and is friendlier to agent collaboration. Rejected for one reason: the author can't click something on the screen, which is exactly what this decision needs to deliver. This path is still worth keeping as a coexisting second option in the future.

## Consequences

- ADR-0010's line "view mode needs no script at all… the sandbox stays at zero token cost" is superseded by this ADR for the main canvas; it still holds for overview thumbnails.
- `wrapSlideDocument` no longer produces a purely static document. The difference between view and play mode becomes "which script is injected," not "whether a script runs at all."
- **The selection box must be drawn in the Shadow DOM.** It lives inside an untrusted document, and the slide's own CSS could otherwise hide or override it — the author would see "I clicked and nothing happened." A shadow root is the cheapest way to draw it in a box the surrounding content can't interfere with. (Revision: this now constrains only the selection box, corner handles, and marquee-select rectangle — name/group labels and snapping guides are now drawn in the parent document, per the note above.)
- The server's rejection of `Origin: null` is now equally necessary for view mode. This protection used to be "two halves of the same thing" together with `allow-scripts`, and that thing only happened in play mode; now view mode needs it too — there's no longer any mode where "this mode doesn't run scripts anyway" is a valid excuse to skip it.

## Revision: third-party embedded players live in the parent document

Third-party players like YouTube's **cannot** be placed inside a slide's iframe — this was verified by testing:

| Slide iframe's sandbox | YouTube player |
| --- | --- |
| `allow-scripts` (current) | Fails to load at all (`embedder.identity.missing.referrer`, origin is `null`) |
| `allow-scripts allow-same-origin` | Loads fine |

And `allow-same-origin` is exactly the token this ADR explicitly forbids: the slide document is `srcdoc`, and adding this token makes it same-origin with the parent document, letting untrusted slide content script its way out of the sandbox. Sandbox flags on nested iframes also intersect with the parent's, so "only relax it for this one embed" isn't achievable per spec.

Decision: **third-party embed `<iframe>`s are drawn in the parent document** (in an embed overlay layer), positioned over the slide's placeholder element. It loads a real https document, not `srcdoc`, so it was never subject to this ADR's sandbox clauses to begin with, and **the slide iframe's sandbox tokens are left completely unchanged**.

Geometry is always reported by the runtime via `getBoundingClientRect()` (an `embed-boxes` event, implemented in both runtimes), and the parent document only handles the coordinate-space conversion — the same rule applied again as with the `bounds` handling above: the parent document never computes SVG boxes itself.

`family="media"` effects still reach embeds: the runtime has no `<video>` to call `.play()` on, so it forwards intent instead (an `embed-command` event), and the parent document speaks the player's own protocol. This uses YouTube's official IFrame Player API (`YT.Player`) — testing showed that hand-rolling a `postMessage` with `{"event":"command","func":"playVideo"}` to a `?enablejsapi=1` frame gets no response at all; that handshake's shape is YouTube's private implementation detail and subject to change. The third-party script is only lazy-loaded when a slide actually contains a YouTube embed.

### Consequences

- This is the **only** overlay layer that stays mounted during play mode (outside the normal shell-visibility gating): an embedded video must keep playing through play mode and fullscreen.
- In view mode, the embedded iframe has `pointer-events: none`, otherwise the author couldn't click their own element to select it; play mode hands clicks back to the player.
- The embed depends on a third-party script (`https://www.youtube.com/iframe_api`). If it fails to load, the embed still displays and viewers can still use the player's own play button — only "effect-driven playback" stops working, which isn't treated as a broken slide, so it doesn't error.
- Embeds require a network connection. Offline playback leaves only a transparent placeholder box for that element — `data-slidra-media` stores the player's URL, and no bytes are ever pulled into the `.slidra` container.
