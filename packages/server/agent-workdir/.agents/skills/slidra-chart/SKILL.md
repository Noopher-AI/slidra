---
name: slidra-chart
description: Build a chart on a specified page from a set of category/series data pasted in the conversation; type, dual axes, stacking, palette, and legend are optional. Use when the user says "make this into a chart", "draw it as a bar chart/line chart", "dual axis", "stacked chart", "change the chart colors", or the message starts with /slidra-chart
---

# Make a chart

Data only comes from categories and series pasted in the conversation: `--csv`/`--csv-asset` need a local file path or an existing data asset, which the agent cannot use — always use `--categories`/`--series`.

## Input

- Target page: `slides/00N.svg`.
- Data: a category list and one or more series.
- Optional: chart type, dual axes, stacking, palette, legend position.
- When the target page or data is missing, first run `slidra ls <presentation-id> slides` to see the current state, ask the user for the missing item, and issue no write commands until it's clear.

## Steps

1. **The specified page does not exist**: report "This deck only has N pages"; do not execute.
2. **Create the chart element**: `slidra chart create <presentation-id> slides/00N.svg --type <T> --x <N> --y <N> --width <N> --height <N>`. Default to `bar` when no type is given; use `line` for time series or when the user says "trend"; use `pie` for proportions with a single series. Default to `--x 140 --y 160 --width 640 --height 400` when coordinates aren't given; note in the report that they can be adjusted later.
3. **Write the data**: note the element id returned in step 2, then `slidra chart data set <presentation-id> slides/00N.svg <el> --categories <c1,c2,...> --series 'name=v1,v2,...'` (one `--series` per series).
4. **Dual axes and stacking are mutually exclusive**, and the order matters:
   - Dual axes: `slidra chart axis set <presentation-id> slides/00N.svg <el> dual --right <right-axis series name>`; if stacking was set previously, first `slidra chart stack set <presentation-id> slides/00N.svg <el> off`, otherwise the command replies "stacked chart requires axes=single".
   - Stacking: only `bar`/`hbar`/`area` can stack, and it must be `axes=single`. First `chart type set` (if the type needs changing) → then `chart axis set <el> single` (if it was dual) → finally `chart stack set <el> on`.
   - `pie`/`donut` do not support stacking or dual axes: explain this and ask the user which one they want; let them choose.
   If a command errors, the order was wrong — redo it in the order above.
5. **Palette**: `slidra chart palette set <presentation-id> slides/00N.svg <el> brand|cool|warm`; override individual series with `--color 'name=#RRGGBB'` (includes `#`, so single quotes).
6. **Legend**: `slidra chart legend set <presentation-id> slides/00N.svg <el> none|bottom|right`.
7. **Verify**: rely on the command's own success message. `cat` on a chart page produces long output (it embeds the entire rendered SVG); only `cat` when you need to confirm data details, and warn the user first that the output will be long.

## Wrap-up

After making changes, before replying, run `slidra validate <presentation-id>` once (only that page if only one page changed) and put the result on the first line of the report; if `errors` is not empty, fix and re-validate, ending this round only at 0 errors (see "wrap-up conditions" in `AGENTS.md`).

## Report format

List the created chart's element id, its page, type, the data's categories and series, and whether dual axes/stacking/palette/legend were set. When the user asks for an unsupported combination, explain why and offer a viable alternative.
