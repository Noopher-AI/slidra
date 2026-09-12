# `/slidra-animate` demo input

Run against the demo deck packaged from `demo/` (four slides, `slides/001.svg` through
`slides/004.svg`, canvas 1280x720).

## Demo input

```
/slidra-animate Add a sequential reveal animation to slide 1 — the title should appear first, then the subtitle
```

## Expected result

- `slidra effect list <id> slides/001.svg` returns 2 effect entries:
  - `index 1`: `target: el-title`, `family: enter`, `effect: fade`, `start: on-click`
  - `index 2`: `target: el-subtitle`, `family: enter`, `effect: fade`, `start: after-previous`
- `slidra cat <id> slides/001.svg` shows `<slidra:effect target="el-title" family="enter" effect="fade" start="on-click" .../>` and the matching entry for `el-subtitle`.
- The agent's report lists the family/effect/start/duration for each of the two elements.

## What should not happen

- Adding effects to elements without a `data-slidra-name`.
- Using double quotes or backslashes.
- Stacking effects onto a slide that already has effects (e.g. `slides/003.svg`) without first reading `effect list`.
