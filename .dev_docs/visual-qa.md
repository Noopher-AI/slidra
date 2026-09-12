# Visual QA judgment protocol

This document is for the agent that **reads screenshots and writes up a findings report**. A scene
runner (to be rebuilt separately) is responsible for opening the app to defined scenes and taking
screenshots; this protocol defines the next step — looking at those screenshots, what to report, what
not to report, and what a report should look like.

Without this protocol, an instruction like "see if anything looks off" just produces a pile of noise
like "the spacing could be a bit bigger." After the third round of that, people stop reading the report.

## Five judgment categories

Only look for problems along these five categories. Each one must be able to answer "what will the user
run into because of this" — if you can't answer that, it doesn't belong in these five categories (see
"Filter rule" below).

### 1. Insufficient foreground/background contrast — content is genuinely invisible

Not "the contrast could look nicer" — the user **cannot see** something they're supposed to see.

- **Example**: inserting text picked up a dark-theme default fill color, and the text color came out
  nearly identical to the `demo/` deck's `#101418` dark background — black text on a black background.
- **User consequence**: after inserting text, the screen looks like nothing happened, so the user assumes
  the action failed and retries it, or concludes the tool is broken.

### 2. Insufficient status-indicator contrast — current state can't be read

An element **does** carry a visual marker for its state, but the marker is too weak to read, which looks
the same to the user as having no marker at all.

- **Example**: the multi-selection box used only a 1px outline that visually blends into the canvas
  content.
- **User consequence**: after multi-selecting, the user can't tell which elements are selected or how
  many, so the next action (e.g. arrange) is a gamble rather than a confirmed choice.

### 3. No visual feedback after an action completes

The user performs an action, it succeeds at the data level, but nothing on screen changes to confirm it.

- **Example**: no selection box appeared after inserting a text box.
- **User consequence**: the user doesn't know whether the insert succeeded or where the new element is,
  so they click insert again or hunt around with the mouse, wasting effort.

### 4. Unbalanced space allocation — secondary panels crowd out the main work area

Secondary features (panels, sidebars, toolbars) take up enough screen proportion to squeeze the main work
area where the user is actually getting things done.

- **Example**: two panels placed side by side crowded each other, compressing the visible canvas area
  down to a disproportionately small size.
- **User consequence**: while doing the main task (editing canvas content), the user doesn't have enough
  visible space, and has to zoom or scroll frequently just to see what they're editing.

### 5. Edit-state indication doesn't match actual behavior

The edit state shown on screen (cursor position, selection range, focus) doesn't match what will actually
happen.

- **Example**: while editing text, the visible cursor always stayed at the end of the text regardless of
  where the user actually clicked or moved it.
- **User consequence**: the user judges where the next keystroke will land based on the visible cursor
  position, but the actual input location isn't where it appears to be, so they end up typing in the
  wrong place without realizing it.

## Filter rule

Every finding must be able to state "what will the user get wrong because of this" — concrete enough to
reach the level of "the user will mistakenly think X," "the user will repeat Y," "the user won't be able
to see Z."

- Can state a user consequence -> report it.
- Can't state a user consequence, and can only say "this could look better" or "the spacing/font
  size/color could use tuning" -> don't report it. **Subjective aesthetic preference doesn't count as a
  consequence.**
- Unsure whether it fits one of the five categories -> don't report it. This protocol only covers these
  five categories; problems outside them belong to a different mechanism — don't force them in here.

## Intermediate-state scenes

The following scenes are transitional screens mid-interaction (e.g. after a menu opens, before a final
action is chosen) — they aren't an end state the user would pause and scrutinize, so **leave the judgment
column blank for them; don't judge them**:

- `new-slide-menu`
- `shape-menu`
- `insert-shape-menu`

Judging these screens amounts to critiquing a moment the user would never actually stare at, and tends
to force out false problems like "menu item spacing." When you see one of these three scene ids, skip it
outright — don't manufacture a finding just to pad the count.

## Report format

Output is Markdown; the findings list is **always sorted ascending by scene id string** (ASCII order,
e.g. `arrange` sorts before `copy`). Running the same input twice should produce output that `diff`s
clean; any random variation in order or wording counts as the protocol not being followed.

Scene ids and naming follow the ids defined in the scene manifest — this protocol's ordering rule only
requires "ascending by scene id"; it doesn't redefine how the ids themselves are assigned.

Each finding is one line, fields in fixed order, separated by `|`:

```
| scene id | judgment category | user consequence | screenshot filename |
```

- **Scene id**: the scene's id from the manifest, copied verbatim, not reworded.
- **Judgment category**: a short label for one of the five categories, e.g. `insufficient-contrast`,
  `unclear-status-indicator`, `no-action-feedback`, `unbalanced-space`, `inconsistent-edit-state`.
- **User consequence**: one sentence meeting the "Filter rule" bar — concrete about what the user will
  get wrong.
- **Screenshot filename**: the screenshot filename for that scene from the manifest, copied verbatim.

Scenes with no findings don't appear in the table — there's no need to pad a "nothing wrong here" row.
Intermediate-state scenes (see the previous section) never appear in the table.

## Limits

- **This report is not a merge gate.** The report itself doesn't block or approve any PR — it's a
  supplementary signal for humans to consult.
- **The judgment isn't reproducible.** "Is there a problem" is the agent's subjective read after looking
  at an image; running the same image twice may yield different conclusions. This is an expected
  limitation, not a bug to fix.
- **No quantitative thresholds are defined.** This protocol doesn't specify numeric contrast ratios,
  spacing in pixels, color-difference formulas, or similar quantitative standards — the judgment relies on
  "will the user get something wrong because of this," not a computable threshold.
