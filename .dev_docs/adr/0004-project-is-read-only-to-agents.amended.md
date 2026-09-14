# Presentation content is read-only to agents, accessed through a virtual filesystem

> **⚠️ `work/<id>` no longer exists.** [`spec/rfcs/0001-sqlite-container-format.md`](../../spec/rfcs/0001-sqlite-container-format.md) removes the hidden work directory this file's repeated "`work/<id>` remains unreadable outside the CLI" invariant refers to — the presentation's content now lives inside a single SQLite `.slidra` file, never unpacked anywhere. The invariant itself (an agent only ever reaches content through the CLI's virtual interface, never a real path) is unchanged; there is simply no `work/<id>` left for the old wording to describe. `slidra extract`, named below as the intended escape hatch, is implemented by that RFC.
>
> **⚠️ Partially superseded.** The second of the three layers of protection (the permission hook only allows `slidra *`) has an explicit hole opened in it by **ADR-0015**: the asset-import command accepts absolute paths and URLs, and since it's a `slidra` command it passes the hook. Media-format validation is the only guard left on that path.
>
> **What still stands**: the virtual file structure, `fs/write_text_file` is always refused, real paths are never leaked, elements are addressed by opaque stable identifiers, and SVG must stay lean (file size is the token cost of every conversation turn).

> A further hole was opened in the third layer: the agent session's working directory is no longer a blank scratch directory regenerated on every connection, but a product-owned working directory bundled with the app and re-laid-out on every `slidra serve` start (`<SLIDRA_HOME>/agent` — a different thing from the presentation's own real working directory `work/<id>`, which remains completely unreadable). The scope of `fs/read_text_file` widens accordingly to "presentation virtual paths (whose relative path's first segment is one of `project.json`, `slides`, `assets`, or `fonts`) plus this working directory's own real files (read-only)."
>
> Reading the working directory reuses the existing structural containment of `readVirtualFile`; it does **not** add the "re-check that the resolved `realpath` is still inside the directory" guard this ADR originally envisioned: `buildVirtualTree` only admits entries that satisfy `isDirectory()`/`isFile()`, so a symlink pointing outside the directory was never recorded in the virtual tree in the first place — it's structurally unreachable, and no extra guard-style check is needed.
>
> **What still stands**: `fs/write_text_file` is always refused, real paths are never leaked, the command allowlist is unchanged, `work/<id>` remains unreadable, and elements are addressed by opaque stable identifiers.

> **ADR-0019 overturns the second layer.** The command gate is no longer an allowlist of "only `slidra *` passes." Now, only a command that names a path under `<SLIDRA_HOME>` (excluding the `agent/` subtree) or any `.slidra` container is blocked; every other shell command is allowed, and the `slidra` command itself is no longer constrained by that character grammar either. When a command is blocked, the app responds with a suggestion for what to use instead, and the adapter's cancellation of the turn is recovered. See ADR-0019 for the reasoning and the trade-offs.
>
> **What still stands**: `fs/write_text_file` is always refused, real paths are never leaked, the virtual file structure, `work/<id>` remains unreadable outside the CLI, and elements are addressed by opaque stable identifiers.

ADR-0002 requires every change to go through a semantic command. But as soon as an agent can see real file paths, it will reach for `cat`, `sed`, `grep` — reading and writing are inseparable, and discipline can't stop that.

So the app never exposes the real filesystem to an agent. Instead, the CLI provides a virtual file structure: the agent can see the full content, but has no write path at all.

## Three layers of protection

1. **ACP file methods**: `fs/read_text_file` returns content under a virtual path; `fs/write_text_file` is always refused, with an error message that points directly to the semantic command to use instead.
2. **Permission hook**: `session/request_permission` only allows `slidra *`; every other shell command is blocked. As a side effect, this also keeps the user from being interrupted by permission dialogs.
3. **No real-path leakage**: success messages never contain a filesystem path. Error messages may echo back the caller's own input string verbatim, but must never resolve it to an absolute path, expand it, or normalize it. Native filesystem errors are always translated, never surfaced directly. The real location of the working directory never appears in any output. Once a real path is exposed even once, an agent will try it.

## Consequences

- The read capability that gets blocked has to be restored some other way: `ls`, `tree`, `cat`, `cat --lines`, `grep`. The output format deliberately mirrors the corresponding Unix tool so an agent doesn't need to learn anything new. `grep` is essential — without it an agent would have to `cat` page by page, and the token cost would be unacceptable.
- What's blocked is the agent, not the person. `slidra extract` lets a user retrieve their own files at any time — `.slidra` is a container, not a cage.
- Elements are addressed by opaque stable identifiers, with display names stored separately. So before an agent can act, it must read the SVG to build a lookup table — SVG file size directly becomes the token cost of every conversation turn, which is why the SVG produced must stay lean: no embedded base64, no bloated path data, shared styles via classes rather than inline styles.
