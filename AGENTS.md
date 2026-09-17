# Slidra

## Agent skills

### Issue tracker

Issues and PRDs are tracked via GitHub Issues, operated through the `gh` CLI. See `.dev_docs/agents/issue-tracker.md`.

### Triage labels

Reuses the five canonical roles; the label strings match the role names. See `.dev_docs/agents/triage-labels.md`.

### Domain docs

Single-context: `.dev_docs/CONTEXT.md` + `.dev_docs/adr/`. See `.dev_docs/agents/domain.md`.

## Language

Prefer English everywhere in this repository except under `docs/`, including pull requests and GitHub Issues.

## Verification prerequisites

Manual acceptance always starts with `npm run verify:setup` — don't assemble the steps yourself. It
installs, builds, checks prerequisites, prepares a deck, puts the workspace's `node_modules/.bin` on
PATH, and then starts `serve`. There are two setup modes: with no flag you get the e2e four-slide demo
(for verifying existing behavior); `--blank` gives you a blank deck (for verifying a from-scratch path).
Details, and cases this command doesn't cover, are in `.dev_docs/verify-setup.md`.

`npm test` (unit tests) already runs `npm run build` as a prerequisite (in the root `package.json`), so
you don't need to `npm run build` manually beforehand. The tests under `packages/server/test/agent/`
(`freeze.test.ts` / `agent-api.test.ts`) actually shell out to the `slidra` CLI, and guard that
dependency in `beforeAll` with `requireCliBuilt()` — if you bypass `npm test` and run
`npx vitest run <single-file>` directly and forget to build first, you get a readable error instead of a
string of 30-second timeouts.

## Rules for the verification checklist

Every command written in a PR's "verification checklist for humans" must have **actually been run**,
with real output pasted in. Don't write down a command you haven't run; if you ran it and it failed,
write down what the failure looked like, not what you expected.
The checklist's starting point is always `npm run verify:setup`.

### CI test scope

CI runs `npm test` and `npm run test:e2e:core`. The browser gate is intentionally limited to the cross-layer authoring flows that cannot be established by unit tests: browser/agent edits, playback, undo/redo, and save/open persistence.

`npm run test:e2e` remains the broader manual or on-demand E2E suite. The repository currently has no committed product appearance baselines, so CI does not claim a pixel-comparison gate. Add a visual gate only with explicit core screenshot coverage, a reviewed baseline-generation workflow, and corresponding policy here.

### Verifying a refactor

Green tests do not demonstrate that a refactor was faithful. If a change does not alter behaviour,
the existing test suite passes whether the change was a clean move or a rewrite along the way — a
dropped negation or a missing `notify()` inside a large moved block passes every existing test just
as well as a correct move does ([S10]/#379). A refactor PR is instead verified mechanically, with
`scripts/verify_refactor.sh`:

- **A move is verified by sorted-diff equality.** For a commit that moves code without renaming
  anything, run:

  ```
  scripts/verify_refactor.sh moved <sha>...
  ```

  It takes the commit's diff, strips the +/- prefixes, drops the lines the commit's own
  `Verbatim-move-exempt:` trailer declares (new import/export lines the move needed), sorts each side,
  and diffs them. A pure move produces the same bag of lines added and removed; any other difference
  means content changed during the move, and the script exits non-zero and prints what did not match.

- **A rename is verified by reverse substitution against a mapping table.** For a commit that renames
  bindings, the commit message carries a `Rename-map:` trailer (one `old -> new` per line). Run:

  ```
  scripts/verify_refactor.sh renamed <sha>...
  ```

  It substitutes every `new` name back to `old` in the commit's new blobs and diffs the result against
  the old blobs. Lines the commit's own `Rename-exempt:` trailer declares (the record's own
  declaration/initialization) are dropped first. Any residual diff means the commit changed more than
  the name.

Run both against every commit in a "split module X out of file Y" PR before claiming it is a pure
move or rename; see the script's own header comment for the trailer syntax.

Both checks read the trailers of the commit that wrote them, so they only work on the PR's
individual commits — during review, or afterwards via `refs/pull/<n>/head`. This repository
squash-merges, and a squash concatenates several commits' trailers into one commit whose line ranges
no longer align and whose verbatim entries later commits have already overwritten, so the gate
reports failures there that say nothing about the refactor. Never run it over `main..HEAD` on
squashed history.
