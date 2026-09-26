# @slidra/player

`<slidra-player>` plays a [`.slidra`](https://github.com/Noopher-AI/slidra) deck on any web page: slides, animations, transitions, media and fonts. Every slide renders in a sandboxed, opaque-origin frame, so a deck's content can never run script on your page.

```html
<script type="module" src="https://unpkg.com/@slidra/player"></script>

<slidra-player src="talk.slidra" controls></slidra-player>
```

The deck is fetched with `fetch()`, so it must be same-origin or served with CORS.

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
player.addEventListener("slidechange", (event) => console.log(event.detail)); // { slide, step, slideCount }
player.addEventListener("error", (event) => console.warn(event.detail.message));
```

Keyboard, with the element focused: `→` `↓` `Space` `PageDown` next · `←` `↑` `PageUp` previous · `Home` / `End` · `F` fullscreen. Clicking the slide advances.

## Building

From the repository root: `npm run build:element` writes `packages/slidra-player/dist/slidra-player.js`, one ES module with the slide runtime built in.
