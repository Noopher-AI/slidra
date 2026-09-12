# `/slidra-notes` demo input

Run against the demo deck packaged from `demo/` (four slides, `slides/001.svg` through
`slides/004.svg`).

## Demo input

```
/slidra-notes Write conversational presenter notes for every slide
```

## Expected result

- `slidra slide notes set <id> slides/00N.svg '<script>'` is run once per slide across all four slides, each succeeding.
- `slidra cat <id> slides/00N.svg` shows a non-empty `<slidra:notes>...</slidra:notes>` on every slide.
- The script content is conversational, first-person — not a copy of the slide's own text.
- The agent's report lists the notes content or a summary of it, per slide.

## What should not happen

- Overwriting a slide's existing notes without confirmation (`slide notes set` replaces the whole thing; there's no append).
- Using double quotes; if the script content contains no single quotes (e.g. an English possessive), it must not be backslash-escaped.
- Copying the slide's own on-screen text verbatim as the notes.
