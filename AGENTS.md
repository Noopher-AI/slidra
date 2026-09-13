# Slidra

## Agent skills

### Issue tracker

Issues and PRDs are tracked via GitHub Issues, operated through the `gh` CLI. See `.dev_docs/agents/issue-tracker.md`.

### Triage labels

Reuses the five canonical roles; the label strings match the role names. See `.dev_docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `.dev_docs/adr/`. See `.dev_docs/agents/domain.md`.

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

### Division of responsibility for visual regression gatekeeping

Appearance baseline screenshots (`compareScreenshot` in `e2e/helpers/screenshot.ts`) must be produced on
the same `ubuntu-latest` + Playwright-bundled Chromium as CI — screenshots produced locally (especially
on macOS) render fonts differently, which causes appearance tests to fail spuriously in CI. Therefore:

- **CI (`.github/workflows/e2e.yml`) is the authoritative gatekeeper for baseline comparisons**:
  `npm run test:e2e` does its usual pixel-by-pixel comparison, never skipped.
- **The only supported way to regenerate baseline screenshots**: manually trigger `e2e.yml` with
  `update_baselines` checked, then download the results from the `appearance-baselines` artifact once
  it finishes, verify the screenshot contents are correct, and commit them.
- **Appearance comparison results from running `npm run test:e2e` or `npm run visual-qa` locally are
  reference-only** (local font rendering differs from CI, so pixel-by-pixel comparison is bound to
  fail) — they cannot serve as acceptance evidence; acceptance is based on CI's comparison results.
