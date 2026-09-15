# The command gate now protects "presentation files must go through the CLI," everything else is allowed

> **Amended (NOOP-472, re-confirming against [E6.T8]).** The Cost section's closing paragraph named the follow-up this decision needed: "taking execution back under control... and putting subprocesses inside an OS-level sandbox." That follow-up has landed, as ADR-0021 — Linux via Landlock, macOS via Seatbelt, Windows still unconfined. It closes exactly the gap it was built for and no more: it restricts what a spawned process can *write*, refusing anything outside an allow-listed sandbox root and a small set of credential/cache paths (`packages/server/src/sandbox/landlock-launcher.ts:12-18`, deliberately ignoring `denyRead`/`denyWrite` — a Landlock ruleset built from `AccessFs::from_write` has no read-restriction concept to apply them to). Reads and outbound network access remain exactly as unrestricted as this ADR already said they'd stay. **"The prompt-injection chain is now open" (above) still stands, unchanged**: the sandbox limits what an agent can write, never what it can be talked into believing or repeating. Nothing here substitutes for `protected-paths.ts`'s existing string-level check or for `validate`/undo's role as the layers that don't depend on guessing.

ADR-0004's second layer was an allowlist: `session/request_permission` only allowed commands
starting with `slidra` whose arguments matched a strict character grammar, blocking everything
else. This ADR redraws that line.

## Why change it

The allowlist itself wasn't broken — it still blocks what it was meant to block. What broke was
three things around it:

1. **It blocks more than it needs to, and the agent doesn't know where the boundary is.** A file
   like `reference/modes.md`, sitting in the working directory, is readable via the ACP file
   methods (the working directory was brought into readable scope in an earlier revision), but
   blocked via `cat`. Same file, same read-only intent, two different outcomes depending on the path taken.
2. **ADR-0004's third layer has already sprung a leak.** The original design was "don't leak real
   paths, and the agent won't be tempted to `cat` them"; but once the ACP session's working
   directory became the real working directory, the absolute path is handed over for free. "Once a
   real path is exposed even once, an agent will try it" is now true on every single turn.
3. **The cost of a refusal gets amplified by the adapter into losing the entire turn.** One adapter
   hard-codes any denial into `interrupt: true`; another's cancellation behaves the same way. The
   allowlist assumed "only one command gets rejected," but in practice what actually gets rejected
   is the whole turn, and the author just sees a generic internal error.

One more thing testing turned up: under the author's own Claude Code settings (an automatic
default mode), some read-only Bash commands never even reach `session/request_permission` — they
just run. The allowlist never took effect for that class of command at all; its actual coverage
always depended on the settings on the machine it happened to run on.

## Decision

**A presentation's content can only be changed through `slidra` commands; every other shell
command is unrestricted.**

Concretely: `session/request_permission` refuses a command if and only if it names one of these
paths:

- anything under `<SLIDRA_HOME>` — every presentation's working directory, undo history,
  `projects.json`, save state — **except** `<SLIDRA_HOME>/agent/<id>`, which is the agent's own
  working directory and must stay usable;
- any `.slidra` container file, wherever it lives on disk.

Everything else is allowed: pipes, redirects, chaining, other programs, double quotes, backslashes.
The `slidra` command itself is no longer constrained by that character grammar either —
`slidra text set … "Q3 Earnings"` can now be written directly.

Three things go with this:

- **A refusal now comes back as a suggestion, not an error.** A refusal reaching the agent as "the
  user declined" makes it stop, treating it like a person saying no. This is changed to tell it
  which command to use instead (via a command-hints helper), and when the adapter turns that
  refusal into a canceled turn, the suggestion is fed back as the next prompt, up to two retries.
- **The freeze/undo grouping check is decoupled from the grammar.** The condition for opening an
  undo-history group is now "the first word is `slidra`," rather than "passes that character
  grammar" — otherwise something like `slidra undo X | head` would quietly fail to enter the undo group.
- **The editing contract is rewritten to match.** The contract and the agent-facing guide used to
  teach "only run `slidra`, never redirect, arguments only take two forms" — if that isn't
  updated, the agent will keep self-censoring, and this relaxation would have no effect.

## What still stands (from ADR-0004)

`fs/write_text_file` is always refused; output never leaks real paths; presentation content is
represented by virtual paths; elements are addressed by opaque stable identifiers; `work/<id>` is
unreadable outside the CLI.

## Cost

This is a decision that replaces a security boundary rather than strengthening it, and the cost
needs to be stated plainly:

- **The blast radius grows from one presentation to the whole machine.** Claude Code's Bash runs
  with the author's own permissions; the allowlist used to be the only wall on that path. Codex
  still has its own read-only sandbox, but that's a third party's default, not something this
  project controls.
- **The prompt-injection chain is now open.** Web search results, imported URLs, and external
  articles the author pastes in all end up in the agent's context; with the allowlist in place, an
  instruction hidden inside one of those was, at worst, a blocked command.
- **The path check is a signpost, not a fence.** `protected-paths.ts` does string-level path
  comparison, which variables, globs, `find`, or a program that reads a path from stdin can all get
  around. What it blocks is the realistic case of "an agent reaches for `sed` to edit a slide out of
  convenience," not a determined adversary set on bypassing it. The protections that don't depend on
  guessing are elsewhere: `.slidra` is always repacked from the CLI's own view of the world,
  `validate` has final say over content, and undo snapshots only recognize commands.

Getting both "commands are unrestricted" and "the blast radius stays bounded" at the same time
requires taking execution back under control (an ACP terminal capability) and putting subprocesses
inside an OS-level sandbox. That's a follow-up to this decision, not a substitute for it.
