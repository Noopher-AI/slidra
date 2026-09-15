# The CLI is the only vocabulary; `slidra serve` is its resident mode

> **⚠️ Partially superseded.** The clause "commands must be semantic, not generic low-level attribute operations" is revoked by **ADR-0014**: styling now goes through a single generic `element style set` command whose attribute names are SVG attribute names directly, guarded by an allowlist. What goes with it is the premise that "agents shouldn't need to be fluent in SVG."
>
> **What still stands**: the CLI is the only vocabulary, `slidra serve` is its resident mode, the frontend must never have a capability the CLI lacks, one operation equals one command equals one undo step, and invariants must be enforced structurally rather than by discipline. That is the core of this ADR.
>
> **Second amendment**: the reasons for rejecting "server forks a subprocess to call the CLI" in the Considered Options section below — a 100–300ms process-startup cost per command — **no longer hold**. They are replaced by "**a single binary**": `slidra` is the sole entry point and sole writer; `serve`/`export` `exec` into Node from it; when the Node side needs to spawn further commands, it always uses that same binary (see `SLIDRA_BIN`) rather than resolving one from `PATH`. The normative definition of the command set now lives in `docs/spec/cli.md`.
>
> **Third amendment (NOOP-472, re-confirming against [E6.T8]).** "`slidra` is the sole entry point" for reads was, until now, discipline alone: the ACP permission hook's `slidra *` allowlist and `protected-paths.ts`'s string check (ADR-0004's second and third layers) were the only things standing between an agent and a stray `cat`/`sed` against a deck file, and a hook or a string check that gets bypassed leaves nothing else in the way. **On macOS only**, that is no longer the whole picture: the agent's own OS process is additionally denied read access to `SLIDRA_HOME` and every registered deck's real path at the Seatbelt layer (`packages/server/src/sandbox/policy.ts`'s `denyRead`, consumed by `srt-launcher.ts` — ADR-0021), a second, independent layer under the existing one. On Linux, the OS sandbox (`landlock-launcher.ts`) deliberately does not consume `denyRead` at all — a Landlock ruleset built from `AccessFs::from_write` has no read-restriction concept to apply it to (AC2/AC3 of `os-enforcement.test.ts` prove reads and network stay open there) — so on Linux this guarantee still rests on the pre-existing discipline-based layers alone, unchanged by this amendment.

The app has to serve two kinds of editors at once: a person working through a visual editor, and an agent working through a shell. If each had its own interface, their capabilities would drift apart, and people and agents could never truly collaborate on the same presentation.

So every operation a presentation supports is defined by a CLI command, and the frontend must never have a capability the CLI lacks. The web editor isn't an independent backend — it's a subcommand, `slidra serve`, sharing the same dispatch as the one-shot commands. That makes "the frontend can only do what the CLI can do" a structural guarantee, not a matter of discipline.

## Considered Options

- **Server forks a subprocess to call the CLI**: the most honest option, but paying a 100–300ms process-startup cost per command makes drag-to-edit unusable.
- **Server calls a shared core in-process, with tests enforcing correspondence**: fast enough, but it downgrades the invariant from structural to disciplinary, and it will drift.

## Consequences

- Dragging in the frontend is a local, real-time preview; releasing the mouse is what dispatches a single command. One operation equals one command equals one undo step.
- The command set itself is the product spec for the app; adding a command means adding a user-facing capability, so it deserves careful design.
- Commands must be semantic (`text set`, `element move`), not generic low-level attribute operations — otherwise an agent would need to be fluent in SVG before it could issue a command, which defeats the product's premise.
