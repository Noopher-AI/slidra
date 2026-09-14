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
