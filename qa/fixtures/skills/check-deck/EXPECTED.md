Page count: 5, no `plan/` directory.

After `/slidra-validate` runs on this deck: `slidra validate` only checks geometry and skeleton (without a plan file, text length, font size, color, and page type are not checked), so rows 2–5 below are pinned only if the command reports them; they are not mandatory. **Rows 1 and 6 are the skill's read-through step's responsibility; `comment list <presentation-id>` must cover both of these (page, target) pairs:**

| # | Category | Page | target | Planted issue | Must pin |
|---|---|---|---|---|---|
| 1 | Typo | 002 | `el-p2-body` | "produt quality" should be "product quality" | ✅ |
| 2 | Inconsistent title level | 003 | `el-p3-title` | font-size 28, all other content-page titles are 40 | `style.font-size` when a plan file exists |
| 3 | Inconsistent font size & color | 004 | `el-p4-body` | font-size 20 and `fill="#CC0000"`, all other body text is 24 / `#333333` | `style.*` when a plan file exists |
| 4 | Overly long bullet | 004 | `el-p4-bullets` | A single bullet exceeds 80 characters | `text.bullet-length` when a plan file exists; without a plan file it may surface as `geometry.*` |
| 5 | Missing title page | 001 | `page` | No page in the deck is a cover/title page; `slides/001.svg` itself is a content page | `roster.page-type` when a plan file exists |
| 6 | Animation order disagrees with layout order | 005 | `el-p5-b` or `page` (either counts as covered) | In layout, `el-p5-a` (y=200) is above `el-p5-b` (y=400), but `<slidra:effects>` plays `el-p5-b` first, then `el-p5-a` | ✅ |

## Judging criteria

- For rows 1 and 6, at least one comment must appear in `comment list <presentation-id>` where the page and target match (comment text need not match verbatim; it must point to the correct page and target). Every error the `validate` command reports must also have a corresponding comment.
- **Apart from `<slidra:comments>`, the remaining content of all five pages must be byte-identical.** How to check: for each page, `cat <presentation-id> slides/00N.svg` to get the content, strip the entire `<metadata><slidra:comments xmlns:slidra="…">…</slidra:comments></metadata>` block (these pages had no comments before the run, so what you remove should be exactly the block just added), and the remainder must be byte-identical to the corresponding file in this fixture directory.

## Fail patterns

- Row 1 or row 6 has no corresponding comment, or `validate` reports errors but no comment was pinned.
- Any page has content modified beyond adding a comment (e.g. fixing the typo directly, unifying font sizes).
- A comment's target or page points to the wrong place (e.g. pinning the 003 title issue to 002).
