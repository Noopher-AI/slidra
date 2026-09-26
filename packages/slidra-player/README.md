# @slidra/player

`<slidra-player>` plays a [`.slidra`](https://github.com/Noopher-AI/slidra) deck on any web page: slides, animations, transitions, media and fonts. Every slide renders in a sandboxed, opaque-origin frame, so a deck's content can never run script on your page.

```html
<script type="module" src="https://unpkg.com/@slidra/player"></script>

<slidra-player src="talk.slidra" controls></slidra-player>
```

The deck is fetched with `fetch()`, so it must be same-origin or served with CORS.

## Deck sources

Instead of a file, the element can play a **deck source**: an object that hands out `project.json`, one slide at a time, and a URL for each packaged file. The element then never downloads the whole deck; it asks only for the slides it shows and the next one.

```js
const player = document.querySelector("slidra-player");
player.source = {
  project: () => fetch("/api/decks/42/project.json").then((r) => r.json()), // parsed project.json
  slide: (path) => fetch(`/api/decks/42/${path}`).then((r) => r.text()), // one slide's SVG markup
  fileUrl: (path) => filesByPath[path] ?? null, // a URL for a font, image, video or audio file, or null
  // Optional: slideIds() → each slide's data-slidra-slide-id (links to slides resolve without reading every slide)
  // Optional: presenter() → a descriptor another window can open the same deck from
};
```

- File URLs may be `https:` (or `http:`), `blob:` or `data:`. The slide frame's Content-Security-Policy admits each `http(s)` URL the source returned by origin and path, and nothing else from the network. Those files are the deck's own, so they load without `allow-remote`; what a slide itself references on the network still waits for it.
- Fonts load in CORS mode from the frame's opaque origin, so font URLs need `Access-Control-Allow-Origin: *`.
- Everything a source returns is treated as untrusted: `project.json` is validated again, and slides are prepared and sandboxed like any other.
- A slide the source cannot serve fires `error` and the deck keeps playing. Setting `src` replaces the source; setting `source` to `null` goes back to `src`.

## Attributes

| Attribute | |
|---|---|
| `src` | The deck's URL. Changing it loads another deck. |
| `slide` | The slide to start at, 1-based. Default `1`. |
| `controls` | Show a bar with previous, the slide counter, next and fullscreen. |
| `allow-remote` | Let the deck load images, media and fonts from the network. Off by default: a remote image would tell its server that the deck was opened. |

The element keeps the deck's aspect ratio (CSS `aspect-ratio`) unless you size it yourself. `::part(stage)` and `::part(controls)` are styleable.

## Script API

```js
const player = document.querySelector("slidra-player");
player.next();
player.previous();
await player.goTo(4); // 1-based
player.slide; // current slide, 1-based
player.step; // current step on the slide, -1 before the first
player.slideCount;
player.source = mySource; // play a deck source instead of src
player.addEventListener("slidechange", (event) => console.log(event.detail)); // { slide, step, slideCount }
player.addEventListener("error", (event) => console.warn(event.detail.message));
```

Keyboard, with the element focused: `→` `↓` `Space` `PageDown` next · `←` `↑` `PageUp` previous · `Home` / `End` · `F` fullscreen. Clicking the slide advances.

## Building

From the repository root: `npm run build:element` writes `packages/slidra-player/dist/slidra-player.js`, one ES module with the slide runtime built in.
