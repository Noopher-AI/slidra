# `/slidra-table` demo input

Run against the demo deck packaged from `demo/`, targeting slide 2 (`slides/002.svg`, canvas
1280x720).

## Demo input

```
/slidra-table Put this table on slide 2:

| Item | Quantity |
|---|---|
| Apple | 3 |
| Banana | 5 |

Use the zebra theme, with a header row
```

## Expected result

- `slidra table create <id> slides/002.svg --rows 3 --cols 2 --x 140 --y 200` succeeds and returns an `elementId`.
- `slidra table set <id> slides/002.svg <elementId> --markdown '...'` succeeds, with a message like "rewrote the contents of table ...".
- `slidra cat <id> slides/002.svg` shows `data-slidra-type="table"`, `data-slidra-theme="zebra"`, `data-slidra-header="1"`, and the two data rows' cell text as "Apple/3" and "Banana/5".
- The agent's report lists the created element id, row/column count, and theme.

## What should not happen

- Using flags like `asset import` or `chart data set --csv` that need a local file path.
- If the user pastes Markdown missing its alignment row, the agent should proactively add it and explain what it filled in, rather than just returning an error.
- Using double quotes; multi-line Markdown content goes inside single quotes, with rows separated by real newlines.
