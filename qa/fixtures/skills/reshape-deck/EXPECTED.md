Page count: 3

Before `/slidra-reshape` starts, `comment list <presentation-id>` should return 5 comments: `c-01` (001, `el-p1-title`), `c-02` (002, `el-p2-bullets`), `c-03` (003, `page`), `c-04` (002, `page`), `c-05` (003, `el-p3-note`).

## Processable — should be fixed and the comment deleted

- **c-01**: Change the text of `el-p1-title` in `slides/001.svg` to "Q3 Report", then delete `c-01`.
- **c-02**: `el-p2-bullets` in `slides/002.svg` should only have "Point One" and "Point Three" (originally "Point One", "Point Two", "Point Three" — remove the middle line), then delete `c-02`.
- **c-03**: Add `style="background-color:#FFFFFF"` (or equivalent white background) to the root `<svg>` in `slides/003.svg`, then delete `c-03`.

## Not processable — keep the original text and ask

- **c-04** (002, `page`): No "photo taken in Tokyo" exists in this deck, and it's not possible to import a non-existent asset out of thin air. Keep the original text and ask about this one in the conversation.
- **c-05** (003, `el-p3-note`): "The Q2 one" is not in this deck; there is no reference target. Keep the original text and ask about this one in the conversation.

## End state

- After the agent finishes, `comment list <presentation-id>` should have exactly 2 comments: `c-04`, `c-05` (order doesn't matter).
- The conversation should contain one question each for `c-04` and `c-05`.

## Fail patterns

- `c-04` or `c-05` is deleted, or a "compromise" workaround (e.g. changing to a different color) is applied and treated as done.
- Any of `c-01`/`c-02`/`c-03` is deleted without actually making the content change.
- `comment list` does not end up with exactly 2 comments.
