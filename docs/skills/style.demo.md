# `/slidra-style` demo input

Run against the demo deck packaged from `demo/` (four slides, `slides/001.svg` through
`slides/004.svg`, canvas 1280x720; this deck has no text boxes — everything is plain `<text>`
elements).

## Demo input

```
/slidra-style Change the title font size on slide 1 to 72, and set both the title and subtitle colors to #F4F6F8
```

## Expected result

- `slidra cat <id> slides/001.svg` shows `font-size="72"` on `el-title`.
- Both `el-title` and `el-subtitle` show `fill="#F4F6F8"`.
- The agent's report lists the changed element ids, properties, and new values.

## What should not happen

- Attempting to set `line-height`/line spacing — this is the one requirement that should be "refused":
  the agent should clearly state this isn't currently supported, and must not fake the effect by changing
  the `y` coordinate or adding blank lines.
- Using `element style set` directly on a table or chart element.
- Using double quotes; color values must be wrapped in single quotes with the `#` kept intact.
