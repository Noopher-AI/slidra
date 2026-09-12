# Playing a `.slidra` requires the app to be installed

ADR-0005 originally required that the animation runtime not depend on the server, reasoning that this would keep `slidra export --html` nearly free and avoid needing the app installed on every computer used to present. That requirement is now retired.

The app is a server: `slidra serve` starts it and it's used through a browser; if it's ever packaged as a desktop app, that's just the same server hidden inside a wrapper. Playback and editing are two modes of the same web app, so the runtime can — and should — draw on the server.

The trade-off is not "presentations can no longer be shared." Sharing happens through **exporting to another format** (HTML, PDF, etc.), which is a server-side feature to be built when it's needed. `.slidra` itself is a working format, meant to run only inside this app.

## Consequences

- The animation runtime can draw on the server: audio/video streams through `/api/raw` with HTTP Range support, so assets don't need to be bundled whole into the browser.
- The player isn't a separate artifact — it's one mode of the same web app as the editor. There's no second SVG-interpretation codebase to maintain.
- A `.slidra` handed to someone without the app installed won't play. To show it to someone else, export it.
- ADR-0001's acceptance criterion goes from being a matter of taste to the last remaining compatibility guarantee: a single `slides/00N.svg` opened in a browser or vector drawing tool must still render a correct static view. That's the only way someone without the app installed can see the content at all, and it must never be eroded further.
- This only replaces the "the runtime must not depend on the server" clause of ADR-0005. The rest of ADR-0005's decisions (the `data-slidra-*` attributes, no SMIL or CSS animation, no `<foreignObject>`) are unaffected.
