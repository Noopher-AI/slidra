# `/slidra-chart` demo input

Run against the demo deck packaged from `demo/`, targeting slide 2 (`slides/002.svg`, canvas
1280x720).

## Demo input

```
/slidra-chart Turn this data into a bar chart on slide 2: categories Q1, Q2, Q3,
revenue 100, 120, 140, gross profit 40, 55, 60, gross profit on the right axis, legend at the bottom
```

## Expected result

- `slidra chart create <id> slides/002.svg --type bar ...` succeeds and returns an `elementId`.
- `slidra chart data set <id> slides/002.svg <elementId> --categories Q1,Q2,Q3 --series 'revenue=100,120,140' --series 'gross_profit=40,55,60'` succeeds.
- `slidra chart axis set <id> slides/002.svg <elementId> dual --right gross_profit` succeeds.
- `slidra cat <id> slides/002.svg` shows `<slidra:chart type="bar" ... axes="dual" legend="bottom" ...>`, with two `<slidra:series>` entries, `gross_profit` carrying `axis="right"`.
- The agent's report lists the chart's element id, type, categories and series, and its axis/legend settings.

## What should not happen

- Using `--csv`/`--csv-asset` — the agent has no file-writing capability, so data always goes through `--categories`/`--series`.
- Running `chart stack set on` directly on a chart already configured with dual axes returns "stacked charts must have axes=single"; the agent shouldn't ignore this error or work around it some other way — it should switch back to `single` before stacking, or explain to the user that the two are mutually exclusive.
- Setting stacking or dual axes on `pie`/`donut` chart types.
