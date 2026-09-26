# .slidra conformance suite

Small decks, each paired with the verdict a conforming reader must reach. Use them to test any implementation of [`spec/slidra-format.md`](../spec/slidra-format.md) and [`spec/playback.md`](../spec/playback.md), in any language.

```
conformance/
├── manifest.json        every case: id, file, the rule it tests, and the expected verdict
├── decks/<id>.slidra    one deck per case
└── cases.mjs            the source: how each deck is built and what is expected
```

## What the suite covers

Every deck in the suite is a formatVersion 6 deck: the SQLite container of format §1.1 with `formatVersion` and `user_version` both `6`, or a file that a reader MUST refuse. A reader that implements formatVersion 6 and nothing else passes the whole suite, with no cases to skip.

Findings that only a checker reports, and a reader does not act on, show up in a verdict only as far as they affect it. `roles-invalid`, for example, carries role values a checker reports as errors (format §4.9), and its expectation is that the slide is not corrupt.

Legacy decks (formatVersion 5 in SQLite, 1–4 in ZIP; format §1.2) are outside the suite. Readers MAY open them, and how well they do so is not something this suite tests. This repository's own reader still opens them; its unit tests (`test/deck.test.mjs`, `test/writer.test.mjs`, `test/validate.test.mjs`) cover that.

## The manifest

```jsonc
{
  "formatVersion": 6,
  "cases": [
    {
      "id": "effects-hex-duration",
      "file": "decks/effects-hex-duration.slidra",
      "rule": "format §6.1, §6.4",
      "description": "duration=\"0x10\" is not a plain decimal.",
      "expect": { "open": "accept", "slides": [{ "status": "corrupt" }] }
    }
  ]
}
```

`expect.open` is `"reject"` when a reader MUST refuse to open the deck, and `"accept"` when it MUST open it. An accepted deck lists what each slide must come to, in order. Only the fields a case states are part of its expectation:

| Field | Meaning |
|---|---|
| `status` | `"ok"`, or `"corrupt"`: the slide is shown statically, and the reader reports why (playback §4). A slide that is not well-formed SVG is also `"corrupt"`. |
| `steps` | How many steps advancing walks through (format §6.3). |
| `hidden` | The element ids that start hidden (playback §2), in effect-list order. |
| `triggers` | For each trigger element id, how many steps its own sequence has (format §6.3). |
| `enter` | The page transition the slide arrives with (`"none"` when the slide is corrupt). |
| `links` | The element ids whose `data-slidra-link` a reader follows, in document order. Ignored links are left out (format §4.8). |
| `title`, `lang` | The slide's accessible title and its language (format §4.7). |

A reader passes a case when it opens (or refuses) the deck as `open` says and every stated slide field matches. Error messages are not part of the verdict.

## Running it

This repository's reader runs the whole suite twice: under Node (`test/conformance.test.mjs`, through `lib/conformance.js`) and in the browser viewer (`e2e/conformance.spec.mjs`).

After changing `cases.mjs`, rebuild the decks and the manifest (Node ≥ 22.5):

```bash
node --no-warnings tools/build-conformance.mjs
```

`npm test` fails when the committed decks or the manifest no longer match `cases.mjs`.
