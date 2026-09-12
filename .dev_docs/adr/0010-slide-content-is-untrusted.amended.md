# Slide content is untrusted: view mode never runs a script, play mode gets `allow-scripts`

> **⚠️ Partially superseded.** The fullscreen target element has been revised by a later fix: fullscreen is now requested on the **container** that wraps the iframe and the playback controls, not on the iframe element itself. See the note inline below.
>
> **What still stands**: slide content is always untrusted, view mode never runs a script, play mode is the only mode that adds `allow-scripts`, `allow-same-origin` is never added, the server must reject `Origin: null`, and server-side sanitization is not used.

One purpose of a `.slidra` file is to be opened by someone other than its author (ADR-0003). Valid SVG can carry event handlers like `onload` and `onerror`; if executed as first-party content, those could reach `/api/*` and exfiltrate the whole presentation. So slide content is always treated as untrusted.

Slides render inside a sandboxed iframe, fed via `srcdoc`, at an opaque origin. The posture differs by mode:

- **View mode needs no script at all.** The decision is that a slide's static appearance is the final state after all effects have run (hiding is applied by the runtime at playback time, never written to the file), so the browser can render the correct picture on its own. The sandbox stays at zero token cost. The overview thumbnails work the same way.
- **Only play mode adds `allow-scripts`**, with the runtime injected alongside the `srcdoc`. **`allow-same-origin` is never added**: with both flags present, a script inside the iframe could escape the sandbox itself, which is worse than either flag alone.

The runtime must listen for keyboard input inside the iframe itself. Transient activation does not propagate across `postMessage` (a delegation proposal was rejected over abuse concerns), so "the parent document catches an arrow key and forwards it to the iframe to play audio" fails with a `NotAllowedError`. When focus isn't on the player, the UI must say so explicitly and offer a way to click back in — it must never silently fail, since half the steps working and half not is worse than the whole thing being broken.

## Consequences

- Switching the sandbox attribute requires rebuilding the iframe, so entering play mode is a reload, not an in-place toggle.
- An opaque origin can still send simple cross-origin requests (the response is unreadable, but the request still goes out). The server must reject requests with `Origin: null` — this protection and enabling `allow-scripts` are two halves of the same thing, and can't be implemented separately.
- State between the player and the sidebar can only be exchanged via `postMessage`.
- Fullscreen is requested by the parent document on the iframe element itself, with the sandbox granted no fullscreen permission of its own. This behavior under an opaque origin should be confirmed by actual testing, not assumed from the spec.

> **The fullscreen target has since been revised: fullscreen is now requested on the container element that wraps both the iframe and the playback controls, rather than the iframe element itself.** Putting the iframe itself into fullscreen put it alone into the browser's top layer, making every element in the parent document — including the fullscreen toggle and the exit-playback button themselves — completely unclickable. Testing confirmed this as a real Playwright click timeout, with the browser reporting `intercepts pointer events`. Requesting fullscreen on the container instead keeps the playback control buttons as descendants of the same top-layer element, so they can actually be clicked. This fallback path was measured across Chromium, Firefox, and WebKit; all three work, with the iframe filling the container via CSS during container fullscreen — this isn't a newly-introduced untested assumption.
>
> **What hasn't changed**: `allowfullscreen` is still never added, `allow-same-origin` is still never added, and slide content is granted no fullscreen permission of its own — the security posture hasn't relaxed at all; only which element enters fullscreen has changed, not the authorization model. The iframe is still only ever operated on by the parent document as a first party; slide content itself has no knowledge of, and no way to request, fullscreen.

- Server-side sanitize-then-embed is not used: sanitizer bypasses are a well-known category of attack, and the browser's own sandbox is a boundary that's been hardened over many years.
