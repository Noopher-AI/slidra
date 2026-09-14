---
name: slidra-table
description: Turn a Markdown or CSV table pasted in the conversation into a table on a specified page; theme and header row are configurable, and it can bind to an existing data asset. Use when the user says "make this into a table", "put this data on page N", "change the table to zebra/dark theme", "bind this data", or the message starts with /slidra-table
---

# Make a table

Data only comes from text pasted in the conversation: the agent has no file-writing ability, so flags that need local file paths — `--csv`, `--markdown-file`, `asset import <path>` — are not available to you.

## Input

- Target page: `slides/00N.svg`.
- Data: a Markdown table or CSV text pasted into the conversation.
- Optional: theme (`dark`/`light`/`zebra`), whether there is a header row, coordinates.
- When the target page or data is missing, first run `slidra ls <presentation-id> slides` to see the current state, ask the user for the missing item, and issue no write commands until it's clear.

## Steps

1. **The specified page does not exist**: report "This deck only has N pages"; do not execute.
2. **The user pasted CSV**: first convert it to a Markdown table in the conversation (including the alignment row), then continue.
3. **Create the table element**: `slidra table create <presentation-id> slides/00N.svg --rows <R> --cols <C> --x <N> --y <N>` (all four required). Default to `--x 140 --y 200` when coordinates aren't given; note in the report that it sits in the upper-left area and can be adjusted.
4. **Write the content**: note the element id returned in step 3, then `slidra table set <presentation-id> slides/00N.svg <el> --markdown '<multi-line Markdown, with real newlines and the alignment row>'` — real newlines inside single quotes; this is the only way to paste multi-line Markdown.
   - The command replies "the second row of a Markdown table must be the alignment row": add the alignment row for the user (e.g. `|---|---|`) and resubmit; say what you added in the report.
   - The command replies "row N's column count does not match the header": relay the original error, ask which row the user is missing; padding an empty column hides a data problem.
5. **Theme and header row**: `slidra table theme set <presentation-id> slides/00N.svg <el> dark|light|zebra`; `slidra table header set <presentation-id> slides/00N.svg <el> true|false`. When the user says something like "striped", map it to `zebra` and explain the mapping.
6. **Bind existing data**: when the user names a virtual path inside the presentation, first `slidra ls <presentation-id> assets` to confirm it exists, then `slidra table bind <presentation-id> slides/00N.svg <el> --source <virtual path>`; afterwards `slidra table refresh <presentation-id> slides/00N.svg <el>` syncs it. When the path doesn't exist, just say "this data file isn't in the presentation, and CSV cannot be imported from the conversation right now".
7. **Verify**: `cat` and read back to confirm the cell text.

## Wrap-up

After making changes, before replying, run `slidra validate <presentation-id>` once (only that page if only one page changed) and put the result on the first line of the report; if `errors` is not empty, fix and re-validate, ending this round only at 0 errors (see "wrap-up conditions" in `AGENTS.md`).

## Report format

List the created table's element id, its page, row/column counts, the applied theme, and whether there is a header row. If you added an alignment row, say what you added.
