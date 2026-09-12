# Verification prerequisites (`npm run verify:setup`)

This document covers only what `npm run verify:setup` doesn't handle, or parts that are easy to
misunderstand when running it. The steps themselves (install, build, prerequisite checks, prepare the
deck, start) aren't repeated here — run `npm run verify:setup --help` to see them.

## Why you have to rebuild every time you touch the frontend

`slidra serve` only reads static files from `packages/web/dist` — there's no dev-server proxy
(ADR-0002). If you've changed source under `packages/web` but rerun with `--skip-build`, what you see
on screen is the old build output. `--skip-build` is only safe to use when you haven't touched frontend
source at all.

## How far the PATH change reaches

`export PATH=".../node_modules/.bin:$PATH"` only affects the `serve` process this script starts, and the
agent subprocesses it forks — this chain only holds when "serve was started by
`npm run verify:setup`." **If you separately run `node_modules/.bin/slidra serve` yourself, the agent
conversation still gets `command not found: slidra`**, because that process never went through the
script's PATH fix. This is a known limitation; the fix is to always start it via
`npm run verify:setup`, never assemble the command by hand.

## The agent doesn't need separate installation, but you must pick one to chat

`claude-code-acp` / `codex-acp` are ordinary npm dependencies of `@slidra/server` — `npm install`
installs them, no global install needed. `--agent` only overrides which one is used for this single
`serve` run; without it, the setting falls back to whatever was previously chosen in the user's settings
file (`<SLIDRA_HOME>/settings.json`); if neither is set, `serve` still starts normally, but chat will
report "no agent selected" until one is chosen.

The setup script runs `npm install` every time to sync workspace dependencies, so switching branches
never leaves an adapter un-installed. The Codex adapter uses a read-only sandbox with per-request
authorization; the editing charter requires that commands pass Slidra's `allow_once` allowlist check
before they can write to the deck or its undo snapshots. There's no need to change the user's global
Codex settings to full access.

## `--qa`: the sandboxed QA layer

`--qa` runs after the usual flow (install/build/prerequisite checks/deck prep): it starts a
`slidra serve` and a headless Chromium (with `--remote-debugging-port`) in the background for
`browser-use` to drive, and then the script itself exits (unlike the no-`--qa` case, where it `exec`s
into `serve` and stays resident). It writes out `.quickstart/qa/qa.env` (`BU_CDP_URL`,
`BH_AGENT_WORKSPACE=qa/`, the server URL, the deck id, and so on); after `source`-ing it, `browser-use`
can operate on this demo deck via the primitives in `qa/agent_helpers.py` — see `qa/README.md` for
details and the primitive list. When done, wrap up with `./quick_start.sh --qa-stop`, which tears down
both the background `serve` and Chromium. Behavior without `--qa` is completely unaffected.

## When you must use `--fresh`

After changing anything under `demo/`. The script doesn't automatically repackage the existing demo
deck — repackaging it swaps in a new deck id, invalidating every URL and terminal command the user
already has (see the corresponding comment in `quick_start.sh`). The same applies to the blank deck in
`--blank` mode: if you change it and want to rebuild it, add `--fresh` too.
